import { parseCtlStatus, missingKeyServices } from '../detect/services.js';
import { errorDetail } from '../core/exec.js';

/**
 * Число незавершённых и упавших фоновых миграций — на любой версии GitLab.
 *
 * Механизмов два, и в разных версиях доступны разные:
 *
 * * `BatchedMigration` — появился в 13.11. Ниже него класса нет вовсе, и
 *   обращение к нему даёт NameError: на 13.0–13.10 проверка просто не могла
 *   работать. Внутри класс пережил две смены API, и путь с 13.x проходит через
 *   обе: в 13.11–13.12 статусы объявлены Rails-enum, поэтому есть scope'ы
 *   .active, .paused и .failed, а `queued` появился только в 14.0; позже enum
 *   заменили на state_machine, per-state scope'ы исчезли, и упавшие считаются
 *   через `with_status(:failed)`. А `failed` полноценным scope'ом не был
 *   никогда: сам GitLab пишет `with_status(:failed)`.
 *
 *   Отсюда respond_to? на два известных перехода, а не номер версии: на длинном
 *   пути версия инстанса меняется под нами девятнадцать раз, и один запрос,
 *   который подстраивается сам, надёжнее девятнадцати верных догадок. Любой
 *   другой NoMethodError по-прежнему поднимается дальше.
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
 * lib/gitlab/background_migration.rb, сверено по тегам v13.0.14-ee, v13.6.7-ee,
 * v13.11.7-ee, v13.12.15-ee, v14.0.12-ee, v16.11.10-ee, v19.1.7-ee: scope
 * :queued впервые встречается в 14.0, в 13.11 и 13.12 у модели есть только
 * queue_order.
 */
export const MIGRATION_QUERY = [
  'q = 0; f = 0; s = []',
  'begin;'
    + ' m = Gitlab::Database::BackgroundMigration::BatchedMigration;'
    + ' q += m.respond_to?(:queued) ? m.queued.count : (m.active.count + m.paused.count);'
    + ' f += m.respond_to?(:with_status) ? m.with_status(:failed).count : m.failed.count;'
    + ' s << "batched";'
    + ' rescue NameError => e; raise if e.is_a?(NoMethodError); end',
  'begin;'
    + ' g = Gitlab::BackgroundMigration;'
    + ' if g.respond_to?(:remaining) then q += g.remaining; s << "legacy" end;'
    + ' rescue NameError => e; raise if e.is_a?(NoMethodError); end',
  'puts "#{q} #{f} #{s.empty? ? "none" : s.join(",")}"',
].join('; ');

/**
 * Имя упавшей миграции и класс её исключения.
 *
 * Отдельным запросом, а не внутри MIGRATION_QUERY: тот считает числа на любой
 * версии и обязан оставаться простым, а этот выполняется только когда упавшие
 * уже найдены — то есть один раз, на пути к остановке, где цена запроса не
 * имеет значения.
 *
 * Зачем вообще: находка «упавших фоновых миграций 1» верна и бесполезна.
 * Живой случай на 18.2.8 — чтобы добраться от неё до причины, понадобилось три
 * захода: rake status, потом запрос в журнал переходов, потом чтение
 * исходников GitLab. Первые два инструмент может сделать сам, и тогда человек
 * сразу видит:
 *
 *   BackfillSentNotificationsAfterPartition (PG::CheckViolation)
 *
 * а не одну лишь цифру.
 *
 * Класс исключения лежит в batched_background_migration_job_transition_logs.
 * Всё, что может отсутствовать на другой версии, обёрнуто: без имени тоже
 * можно жить, а вот упасть на диагностике по пути к остановке — нельзя.
 * Сообщение исключения намеренно НЕ берём: в нём бывают значения из данных.
 *
 * Сверено по v18.2.8-ee: BatchedJob#batched_job_transition_logs,
 * BatchedJobTransitionLog#exception_class.
 */
export const FAILED_MIGRATION_QUERY = [
  'begin',
  ' m = Gitlab::Database::BackgroundMigration::BatchedMigration',
  ' f = m.respond_to?(:with_status) ? m.with_status(:failed) : m.failed',
  ' f.first(3).each { |x| e = nil;'
    + ' begin;'
    + ' j = x.batched_jobs.with_status(:failed).order(id: :desc).first;'
    + ' t = j && j.respond_to?(:batched_job_transition_logs) ?'
    + ' j.batched_job_transition_logs.order(id: :desc).first : nil;'
    + ' e = t && t.exception_class;'
    + ' rescue StandardError; end;'
    + ' puts "#{x.job_class_name}#{e ? " (#{e})" : ""}" }',
  ' rescue NameError => e; raise if e.is_a?(NoMethodError); end',
].join(';');

/**
 * Что из этого можно показать человеку: имена через запятую, или null.
 * Ошибка запроса — не повод падать: мы уже на пути к остановке, и без имени
 * остановка всё равно должна произойти.
 */
export async function describeFailedMigrations(exec) {
  const r = await exec(['gitlab-rails', 'runner', '-e', 'production', FAILED_MIGRATION_QUERY], {
    readOnly: true, allowFailure: true, timeout: 180_000,
  }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const names = String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return names.length ? names.join(', ') : null;
}

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
  constructor(count, which = null) {
    super(`${count} batched migration(s) failed${which ? `: ${which}` : ''}`);
    this.name = 'MigrationsFailed';
    this.count = count;
    // Имена нужны и на экране остановки, и в уведомлении на телефон: цифра
    // без имени не отвечает ни на один вопрос, который в этот момент задают.
    this.which = which;
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
    if (failed > 0) throw new MigrationsFailed(failed, await describeFailedMigrations(exec));

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
