import { bytes } from './format.js';

/**
 * Одно место, где событие превращается в человеческий текст.
 *
 * Ink и plain обязаны говорить одно и то же: `attach` показывает журнал
 * идущего апгрейда, и если экран и лог разойдутся, человек в три часа ночи
 * будет сверять два разных рассказа об одном апгрейде.
 */

/** Роли, а не цвета: цвет назначается темой, plain обходится без него. */
export const ROLE = { OK: 'ok', INFO: 'info', WARN: 'warn', ERROR: 'error' };

/** Строка ленты: заголовок шага или фаза внутри шага. */
export const KIND = { HEAD: 'head', PHASE: 'phase', DETAIL: 'detail' };

/**
 * Тема заголовка. Компактному экрану патча (§7A) маршрут не нужен — один
 * шаг не бывает «шагом 1 из 1», — а исход нужен всегда.
 */
export const TOPIC = { ROUTE: 'route', OUTCOME: 'outcome' };

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** ЧЧ:ММ:СС — на шаг смотрят часами, и «127 мин» требует арифметики. */
export function clock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * Событие → строка. `null` означает «в ленте не показываем»: exec-события
 * нужны в журнале для разбора полётов, но на экране это шум.
 */
export function describe(e, t) {
  const p = (key, params) => t(key, params ?? e);

  switch (e.t) {
    case 'run:start':
      return line(KIND.HEAD, ROLE.INFO, p('event.run.start'), TOPIC.ROUTE);
    case 'run:done':
      return line(KIND.HEAD, ROLE.OK, p('event.run.done'), TOPIC.OUTCOME);
    case 'run:stopped':
      // Короткая причина, а не готовый абзац из run.stop.*: тот адресован
      // человеку, который уже читает итог, и в строку ленты не помещается.
      return line(KIND.HEAD, ROLE.ERROR, p('event.run.stopped', {
        ...e,
        version: e.version ?? '\u2014',
        reason: t.has(`event.stop.${e.reason}`) ? t(`event.stop.${e.reason}`) : e.reason,
      }), TOPIC.OUTCOME);

    case 'step:start':
      return line(KIND.HEAD, ROLE.INFO, p('event.step.start'), TOPIC.ROUTE);
    case 'step:done':
      return line(KIND.HEAD, ROLE.OK, p('event.step.done', {
        ...e, elapsed: Number.isFinite(e.durationMs) ? clock(e.durationMs) : '\u2014',
      }), TOPIC.ROUTE);

    case 'backup:start':
      return phase(ROLE.INFO, p('event.backup.name', { mode: t(`backup.mode.${e.mode}`) }), p('event.backup.running'));
    case 'backup:done':
      return phase(ROLE.OK, p('event.backup.name', { mode: t(`backup.mode.${e.mode}`) }),
        [e.archive ? bytes(e.archive.size, t) : null, t('event.took', { n: minutes(e.durationMs) }), e.dumpDir]
          .filter(Boolean).join(' · '));
    case 'backup:skipped':
      return phase(ROLE.WARN, p('event.backup.plain'), p('event.backup.skipped'));
    case 'backup:hook':
      return phase(ROLE.OK, p('event.hook.name'), e.hook);

    case 'install:start':
      return phase(ROLE.INFO, p('event.install.name'), p('event.install.running'));
    case 'install:done':
      return phase(ROLE.OK, p('event.install.name'), `${e.version} · ${t('event.took', { n: minutes(e.durationMs) })}`);

    case 'predownload:start':
      return phase(ROLE.INFO, p('event.predownload.name'), p('event.predownload.running'));
    case 'predownload:step':
      return line(KIND.DETAIL, ROLE.INFO, p('event.predownload.step'));
    case 'predownload:done':
      return phase(ROLE.OK, p('event.predownload.name'), p('event.predownload.done'));

    case 'services:progress':
      return phase(e.running === e.total ? ROLE.OK : ROLE.INFO, p('event.services.name'), p('event.services.value'));

    case 'migrations:progress':
      return phase(e.queued === 0 ? ROLE.OK : ROLE.INFO, p('event.migrations.name'),
        e.queued === 0 ? p('event.migrations.clear') : p('event.migrations.left'));
    case 'migrations:slow':
      return phase(ROLE.WARN, p('event.migrations.name'), p('event.migrations.slow'));
    case 'migrations:unknown':
      return phase(ROLE.WARN, p('event.migrations.name'), p('event.migrations.unknown'));

    default:
      return null;
  }
}

const line = (kind, role, text, topic = null) => ({ kind, role, text, topic });
const phase = (role, name, value) => ({ kind: KIND.PHASE, role, name, value, text: `${name} ${value}` });

/** Маркер строки. Тот же в Ink и в plain — иначе экраны разъедутся. */
export const MARK = { ok: '✓', info: '·', warn: '!', error: '✗' };

/**
 * Фаза, в которой Ctrl-C оставляет систему в незавершённом состоянии, ровно
 * одна — dpkg. Список намеренно узкий: пугать там, где прерывание безопасно,
 * — верный способ научить не читать предупреждения. Прерванный бэкап стоит
 * недоделанного архива, прерванный dpkg — `dpkg --configure -a` руками.
 */
const DANGEROUS = new Set(['install']);
const PHASES = ['predownload', 'backup', 'install', 'services', 'migrations'];

/**
 * Фаза шага по событию — для индикатора безопасности Ctrl-C.
 * `null` означает «это событие фазу не меняет».
 */
export function phaseOf(e) {
  const [group, stage] = String(e.t).split(':');
  if (!PHASES.includes(group)) return null;
  return { phase: group, active: stage !== 'done' };
}

export const isDangerous = (phase) => DANGEROUS.has(phase);
