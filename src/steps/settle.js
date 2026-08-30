import { parseCtlStatus, missingKeyServices } from '../detect/services.js';

export const MIGRATION_QUERY =
  'm = Gitlab::Database::BackgroundMigration::BatchedMigration; puts "#{m.queued.count} #{m.failed.count}"';

export class MigrationsFailed extends Error {
  constructor(count) {
    super(`${count} batched migration(s) failed`);
    this.name = 'MigrationsFailed';
    this.count = count;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждём, пока поднимутся все ключевые сервисы после reconfigure. */
export async function waitServices({ exec, bus, timeoutMs = 20 * 60_000, intervalMs = 5_000, now = () => Date.now(), wait = sleep }) {
  const deadline = now() + timeoutMs;
  // Счётчик итераций — страховка от неидущих часов: без него замерший
  // clock превратил бы ожидание в вечный цикл.
  let attempts = Math.ceil(timeoutMs / Math.max(1, intervalMs)) + 1;
  let last = null;
  while (now() < deadline && attempts-- > 0) {
    const r = await exec(['gitlab-ctl', 'status'], { readOnly: true, allowFailure: true });
    if (r.code === 0) {
      last = parseCtlStatus(r.stdout);
      const missing = missingKeyServices(last);
      bus?.emit({ t: 'services:progress', running: last.running, total: last.total, missing });
      if (!missing.length) return { ok: true, ...last };
    }
    await wait(intervalMs);
  }
  return { ok: false, ...(last ?? { running: 0, total: 0 }) };
}

/**
 * Ожидание фоновых миграций между шагами — не опция, а требование GitLab:
 * следующий шаг мигрировал бы поверх незавершённых данных.
 *
 * Упавшая миграция прекращает ожидание немедленно. Ждать её бессмысленно:
 * она не «догонит», а каждая минута ожидания — минута простоя впустую.
 */
export async function waitMigrations({
  exec, bus, timeoutMs = 72 * 3600_000, intervalMs = 60_000,
  slowAfterMs = 60 * 60_000, version = null,
  now = () => Date.now(), wait = sleep,
}) {
  const deadline = now() + timeoutMs;
  const started = now();
  const history = [];
  let attempts = Math.ceil(timeoutMs / Math.max(1, intervalMs)) + 1;
  let slowReported = false;

  while (now() < deadline && attempts-- > 0) {
    const r = await exec(['gitlab-rails', 'runner', '-e', 'production', MIGRATION_QUERY], {
      readOnly: true, allowFailure: true, timeout: 300_000,
    });
    if (r.code !== 0) {
      // Неизвестно — не значит «в порядке»: сообщаем и пробуем снова.
      bus?.emit({ t: 'migrations:unknown', detail: (r.stderr || '').trim().split('\n').pop() ?? '' });
      await wait(intervalMs);
      continue;
    }
    const [queued, failed] = r.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(queued) || !Number.isFinite(failed)) {
      bus?.emit({ t: 'migrations:unknown', detail: r.stdout.trim() });
      await wait(intervalMs);
      continue;
    }
    if (failed > 0) throw new MigrationsFailed(failed);

    history.push({ at: now(), queued });
    const rate = rateOf(history);
    const elapsedMs = now() - started;
    bus?.emit({ t: 'migrations:progress', queued, rate, elapsedMs });
    // Один сигнал на шаг: «идёт дольше обычного» стоит сказать, но не
    // превращать в поток сообщений раз в минуту на протяжении шести часов.
    if (!slowReported && elapsedMs > slowAfterMs) {
      slowReported = true;
      bus?.emit({ t: 'migrations:slow', version, queued, elapsedMin: Math.round(elapsedMs / 60_000) });
    }
    if (queued === 0) return { ok: true, elapsedMs };

    await wait(intervalMs);
  }
  return { ok: false, timedOut: true, elapsedMs: now() - started };
}

/**
 * Темп за последние десять минут — измеренный, а не эвристика по числу
 * проектов. Ноль на длинном окне означает «возможно, застряла», и это
 * честнее любой оценки «осталось примерно столько-то».
 */
export function rateOf(history, windowMs = 10 * 60_000) {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  const first = history.find((h) => last.at - h.at <= windowMs) ?? history[0];
  if (first === last) return null;
  return { closed: first.queued - last.queued, windowMs: last.at - first.at };
}

export function etaMinutes(queued, rate) {
  if (!rate || rate.closed <= 0) return null;
  const perMs = rate.closed / rate.windowMs;
  return Math.ceil(queued / perMs / 60_000);
}
