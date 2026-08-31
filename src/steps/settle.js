import { parseCtlStatus, missingKeyServices } from '../detect/services.js';
import { errorDetail } from '../core/exec.js';

/**
 * Число незавершённых и упавших фоновых миграций — на любой версии GitLab.
 *
 * Механизмов два, и в разных версиях доступны разные:
 *
 * * `BatchedMigration` — появился в 13.11. Ниже него класса нет вовсе, и
 *   обращение к нему даёт NameError: на 13.0–13.10 проверка просто не могла
 *   работать. `queued` — настоящий scope (`with_statuses(:active, :paused)`),
 *   есть во всех версиях. А `failed` scope'ом не был никогда: сам GitLab
 *   пишет `with_status(:failed)`, в модели есть только `state :failed`.
 * * `Gitlab::BackgroundMigration.remaining` — старые миграции в очереди
 *   Sidekiq. Есть с 13.0 по 17.11, в 19.x файла уже нет. С 13.x подниматься,
 *   не дождавшись их, нельзя — а до сих пор мы их не считали совсем.
 *
 * Отсутствующий класс пропускаем, отсутствующий метод — нет. NoMethodError
 * наследуется от NameError, и `rescue NameError` проглотил бы ровно ту ошибку,
 * из-за которой этот запрос был сломан: сломанный вызов стал бы тихим «0 0»,
 * то есть «миграций нет». Поэтому NoMethodError поднимается дальше.
 *
 * Третье поле — какие механизмы нашлись. `none` означает «мы спросили не то»,
 * и это не то же самое, что «миграций нет».
 *
 * Источник: lib/gitlab/database/background_migration/batched_migration.rb и
 * lib/gitlab/background_migration.rb, сверено по тегам v13.0.14-ee … v19.1.7-ee.
 */
export const MIGRATION_QUERY = [
  'q = 0; f = 0; s = []',
  'begin;'
    + ' m = Gitlab::Database::BackgroundMigration::BatchedMigration;'
    + ' q += m.queued.count; f += m.with_status(:failed).count; s << "batched";'
    + ' rescue NameError => e; raise if e.is_a?(NoMethodError); end',
  'begin;'
    + ' g = Gitlab::BackgroundMigration;'
    + ' if g.respond_to?(:remaining) then q += g.remaining; s << "legacy" end;'
    + ' rescue NameError => e; raise if e.is_a?(NoMethodError); end',
  'puts "#{q} #{f} #{s.empty? ? "none" : s.join(",")}"',
].join('; ');

/**
 * Разбор ответа. Возвращает null там, где ответу верить нельзя: «в порядке»
 * по непонятному выводу — худший из возможных ответов в этом месте.
 */
export function parseMigrationCounts(stdout) {
  const parts = String(stdout ?? '').trim().split(/\s+/);
  const queued = Number(parts[0]);
  const failed = Number(parts[1]);
  const sources = parts[2] ?? '';
  if (!Number.isFinite(queued) || !Number.isFinite(failed)) return null;
  if (!sources || sources === 'none') return null;
  return { queued, failed, sources };
}

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
      bus?.emit({ t: 'migrations:unknown', detail: errorDetail(r.stderr) });
      await wait(intervalMs);
      continue;
    }
    const counts = parseMigrationCounts(r.stdout);
    if (!counts) {
      bus?.emit({ t: 'migrations:unknown', detail: r.stdout.trim() });
      await wait(intervalMs);
      continue;
    }
    const { queued, failed } = counts;
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
