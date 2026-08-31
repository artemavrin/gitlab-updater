import { LEVEL } from '../core/events.js';
import { detectServices, detectPostgres, missingKeyServices, parsePgVersion } from '../detect/services.js';
import { freeBytes, toGb, GB } from '../detect/disk.js';
import { postgresRange, osCeiling, comparePg, pgMajor } from '../plan/matrices.js';
import { parseVersion, compareVersions, withinCeiling } from '../plan/version.js';
import { remedyFor } from './remedies.js';
import { MIGRATION_QUERY } from '../steps/settle.js';
import { errorDetail } from '../core/exec.js';

/**
 * Проверки — данные, а не разбросанные if'ы.
 *
 * У каждой есть глубина: `fast` гоняется всегда, `full` — только когда путь
 * длиннее патча. Так профиль `patch` не платит четырьмя минутами
 * `gitlab-rake gitlab:check` за двенадцать минут работы.
 *
 * Каждая возвращает Finding: { id, level, params }. Текст берётся из локали
 * по ключу check.<id>.<level> — в коде сообщений нет.
 */
export const DEPTH = { FAST: 'fast', FULL: 'full' };

const finding = (id, level, params = {}) => ({ id, level, params });
const ok = (id, params) => finding(id, LEVEL.OK, params);
const warn = (id, params) => finding(id, LEVEL.WARN, params);
const critical = (id, params) => finding(id, LEVEL.CRITICAL, params);

export const CHECKS = [
  {
    id: 'root',
    depth: DEPTH.FAST,
    async run({ uid }) {
      return uid === 0 ? ok('root') : critical('root');
    },
  },

  {
    id: 'omnibus',
    depth: DEPTH.FAST,
    async run({ exec, env }) {
      const omnibus = await exec(['test', '-d', '/opt/gitlab/embedded'], { readOnly: true, allowFailure: true });
      if (omnibus.code !== 0) return critical('omnibus');
      // Docker и Kubernetes живут по другим правилам — молча притворяться, что
      // это Omnibus, опаснее, чем отказаться.
      const container = await exec(['test', '-f', '/.dockerenv'], { readOnly: true, allowFailure: true });
      if (container.code !== 0) return ok('omnibus');
      // Поблажка для собственного стенда репетиции (rehearsal/). Намеренно
      // переменная окружения, а не флаг: в справку и в каталог `api` она не
      // попадает. И снятая проверка не становится «ок» — иначе репетиционная
      // поблажка однажды уехала бы в продакшен молча.
      return env?.GITLAB_UPGRADE_ALLOW_CONTAINER
        ? warn('omnibus-container-allowed')
        : critical('omnibus-container');
    },
  },

  {
    id: 'services',
    depth: DEPTH.FAST,
    async run({ exec }) {
      const status = await detectServices(exec);
      if (!status) return critical('services-unknown');
      const missing = missingKeyServices(status);
      if (missing.length) return critical('services', { missing: missing.join(', '), running: status.running, total: status.total });
      return ok('services', { running: status.running, total: status.total });
    },
  },

  {
    id: 'migrations',
    depth: DEPTH.FAST,
    async run({ exec }) {
      // Ровно тот же запрос, что у `run`: две копии строки — это два разных
      // ответа на один вопрос, и расходиться они начнут молча.
      const r = await exec(['gitlab-rails', 'runner', '-e', 'production', MIGRATION_QUERY], {
        readOnly: true, allowFailure: true, timeout: 180_000,
      });
      if (r.code !== 0) return warn('migrations-unknown', { detail: errorDetail(r.stderr) });
      const [queued, failed] = r.stdout.trim().split(/\s+/).map(Number);
      if (!Number.isFinite(queued) || !Number.isFinite(failed)) return warn('migrations-unknown', { detail: r.stdout.trim() });
      // Упавшая миграция — стоп без вариантов: следующий шаг будет мигрировать
      // поверх незавершённых данных. Этот critical не снимается --force.
      if (failed > 0) return critical('migrations-failed', { n: failed });
      if (queued > 0) return warn('migrations-pending', { n: queued });
      return ok('migrations');
    },
  },

  {
    id: 'secrets',
    depth: DEPTH.FAST,
    async run({ exec }) {
      const r = await exec(['test', '-f', '/etc/gitlab/gitlab-secrets.json'], { readOnly: true, allowFailure: true });
      // Без этого файла бэкап не восстанавливается: узнать об этом при
      // восстановлении — слишком поздно.
      return r.code === 0 ? ok('secrets') : critical('secrets');
    },
  },

  {
    id: 'disk',
    depth: DEPTH.FAST,
    async run({ exec, minFreeGb, plan }) {
      const rows = await freeBytes(exec, ['/var/opt/gitlab', '/']);
      if (!rows.length) return warn('disk-unknown');
      const data = rows.find((r) => r.target === '/var/opt/gitlab') ?? rows[0];
      const root = rows.find((r) => r.target === '/') ?? rows[rows.length - 1];
      // Предзагрузка кладёт по ~1.1 ГБ на шаг в /var/cache/apt/archives.
      const cacheNeed = (plan?.steps.length ?? 1) * 1.1;
      if (toGb(data.avail) < minFreeGb) return critical('disk', { path: data.target, free: toGb(data.avail), need: minFreeGb });
      if (root.avail / GB < cacheNeed) return warn('disk-cache', { free: toGb(root.avail), need: Math.round(cacheNeed * 10) / 10 });
      return ok('disk', { free: toGb(data.avail) });
    },
  },

  {
    id: 'apt-busy',
    depth: DEPTH.FAST,
    async run({ exec }) {
      const lock = await exec(['fuser', '/var/lib/dpkg/lock-frontend'], { readOnly: true, allowFailure: true });
      if (lock.code === 0) return critical('apt-busy');
      const timer = await exec(['systemctl', 'is-active', 'apt-daily.timer'], { readOnly: true, allowFailure: true });
      // Таймер apt перехватит dpkg-блокировку посреди установки — редкая,
      // но крайне неприятная причина зависшего unattended-запуска.
      return timer.stdout.trim() === 'active' ? warn('apt-timer') : ok('apt-busy');
    },
  },

  {
    id: 'session',
    depth: DEPTH.FAST,
    async run({ env, isTty, plan }) {
      if (!isTty) return ok('session-detached');
      if (env.TMUX || env.STY) return ok('session');
      // Для патча на десять минут это шум; для длинного пути — реальный риск.
      if ((plan?.steps.length ?? 1) <= 1) return ok('session');
      return warn('session');
    },
  },

  {
    id: 'os-ceiling',
    depth: DEPTH.FULL,
    async run({ os, plan, data, safeForOs }) {
      const max = osCeiling(data.osMatrix, os);
      if (!max || !plan?.target) return ok('os-ceiling');
      if (withinCeiling(plan.target, max)) return ok('os-ceiling');
      return safeForOs
        ? ok('os-ceiling')
        : warn('os-ceiling', { os: os.pretty, max, target: plan.target.raw });
    },
  },

  {
    id: 'postgres',
    depth: DEPTH.FULL,
    async run({ exec, plan, data }) {
      if (!plan?.target) return ok('postgres');
      const r = await exec(['gitlab-psql', '--version'], { readOnly: true, allowFailure: true });
      const have = parsePgVersion(r.stdout);
      if (r.code !== 0 || !have) return warn('postgres-unknown');
      const range = postgresRange(data.pgRequirements, plan.target);
      // Ниже GitLab 16 официальная таблица не публикуется — там PostgreSQL
      // приезжает вместе с Omnibus, и проверять нечего.
      if (!range) return ok('postgres', { have });
      if (comparePg(have, range.min) < 0) {
        // Для внешней БД `gitlab-ctl pg-upgrade` не применяется, а на
        // Patroni/HA запрещён документацией. Находка отдельная — иначе
        // экран советует команду, которая ничего не сделает.
        const where = await detectPostgres(exec);
        const id = where.bundled === true ? 'postgres' : 'postgres-external';
        return critical(id, { have, need: range.min, target: plan.target.raw });
      }
      // Выше протестированного максимума — вопрос поддерживаемости, а не поломки,
      // поэтому предупреждение. Сравниваем по мажорной: максимум задан как «16».
      if (pgMajor(have) > pgMajor(range.max)) {
        return warn('postgres-above', { have, max: range.max, target: plan.target.raw });
      }
      return ok('postgres', { have });
    },
  },
];

/** Проверки идут по возрастанию цены: дешёвые первыми, чтобы упасть раньше. */
export async function runChecks(ctx, { depth = DEPTH.FAST } = {}) {
  const selected = CHECKS.filter((c) => depth === DEPTH.FULL || c.depth === DEPTH.FAST);
  const findings = [];
  for (const check of selected) {
    try {
      const found = { check: check.id, ...(await check.run(ctx)) };
      // Починка прикрепляется здесь, а не в каждой проверке: так экран и
      // --json берут её из одного места и не могут разойтись.
      findings.push(found.level === LEVEL.OK
        ? found
        : { ...found, remedy: remedyFor(found, { version: ctx.gitlabInfo?.version ?? ctx.plan?.current?.raw ?? null }) });
    } catch (err) {
      // Упавшая проверка — это «неизвестно», а не «в порядке».
      findings.push({ check: check.id, ...warn('check-failed', { check: check.id, detail: err.message }) });
    }
  }
  return {
    findings,
    ok: findings.filter((f) => f.level === LEVEL.OK).length,
    warnings: findings.filter((f) => f.level === LEVEL.WARN).length,
    critical: findings.filter((f) => f.level === LEVEL.CRITICAL).length,
  };
}

/**
 * Critical останавливает всегда. --force снимает только предупреждения —
 * иначе флаг превратился бы в кнопку «сломать данные».
 */
export const blocked = (summary) => summary.critical > 0;
export const needsForce = (summary, { force = false }) => summary.warnings > 0 && !force;

/**
 * Одно правило готовности на все команды.
 *
 * `doctor` и `run` обязаны отвечать одинаково: если doctor говорит «всё в
 * порядке», а run отказывается — доверие к doctor кончается на первом же
 * таком случае.
 *
 * Потолок ОС вынесен из-под `--force` отдельно. «Игнорировать
 * предупреждения» и «поставить версию, для которой под эту ОС нет пакетов»
 * — про разное, а флаг был один; для агента `--force` читается как
 * «продолжить несмотря на шум».
 */
export function gate(summary, flags = {}, { resuming = false } = {}) {
  const has = (id) => summary.findings.some((f) => f.id === id && f.level === LEVEL.WARN);
  if (blocked(summary)) {
    return { ok: false, reason: 'checks-failed', verdict: 'doctor.blocked' };
  }
  if (has('os-ceiling') && !flags.allowUnsupportedOs) {
    return { ok: false, reason: 'os-ceiling-not-accepted', verdict: 'doctor.osCeiling' };
  }
  // Незавершённые миграции при resume — ровно то состояние, ради выхода из
  // которого resume и запускают. Требовать за него --force бессмысленно.
  const rest = summary.findings.filter((f) =>
    f.level === LEVEL.WARN && f.id !== 'os-ceiling' && !(resuming && f.id === 'migrations-pending'));
  if (rest.length && !flags.force) {
    return { ok: false, reason: 'warnings-not-accepted', verdict: 'doctor.warned' };
  }
  return { ok: true, reason: null, verdict: 'doctor.clean' };
}
