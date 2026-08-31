import { parseVersion, compareVersions, latestPatchOf, minorOf, sameMinor, shortVersion, withinCeiling } from './version.js';
import { stopVersions } from './upgradePathSource.js';

export const PROFILE = { CURRENT: 'current', PATCH: 'patch', MINOR: 'minor', LONG: 'long' };

/**
 * Профиль вычисляется по пути, а не выбирается человеком: он для того и
 * запускает инструмент, чтобы тот разобрался. От профиля зависит вес
 * церемонии — режим бэкапа, глубина проверок, форма подтверждения, экран.
 */
export function profileOf(current, steps) {
  if (steps.length === 0) return PROFILE.CURRENT;
  const last = steps[steps.length - 1];
  if (steps.length === 1 && sameMinor(current, last)) return PROFILE.PATCH;
  if (last.major === current.major && steps.length <= 2) return PROFILE.MINOR;
  return PROFILE.LONG;
}

/** Потолок пути — минимум из всех ограничений; каждое несёт причину. */
function ceiling({ available, osMax, targetMajor, to, patchOnly, current }) {
  const limits = [];
  const newest = available[available.length - 1];
  if (newest) limits.push({ v: newest, reason: 'latest-available' });
  if (osMax) {
    const fit = available.filter((v) => withinCeiling(v, osMax)).pop();
    if (fit) limits.push({ v: fit, reason: 'os-ceiling' });
  }
  if (targetMajor) {
    const fit = available.filter((v) => v.major <= Number(targetMajor)).pop();
    if (fit) limits.push({ v: fit, reason: 'target-major' });
  }
  if (to) {
    const t = parseVersion(to);
    const fit = available.filter((v) => compareVersions(v, t) <= 0).pop();
    if (fit) limits.push({ v: fit, reason: 'explicit-target' });
  }
  if (patchOnly) {
    const fit = latestPatchOf(available, current.major, current.minor);
    if (fit) limits.push({ v: fit, reason: 'patch-only' });
  }
  if (!limits.length) return null;
  return limits.reduce((a, b) => (compareVersions(a.v, b.v) <= 0 ? a : b));
}

/**
 * Строит путь обновления.
 *
 * @param {object} o
 * @param {string} o.current   текущая версия, например "15.11.13-ee"
 * @param {object[]} o.available версии из apt-cache madison (parseMadison)
 * @param {string[]} o.stops   обязательные остановки из data/upgrade-path.json
 */
export function buildPlan({ current, available, stops, osMax = null, targetMajor = null, to = null, patchOnly = false }) {
  const cur = typeof current === 'string' ? parseVersion(current) : current;
  if (!cur) throw new TypeError('cannot parse the current version');

  const sorted = [...available].sort(compareVersions);
  const top = ceiling({ available: sorted, osMax, targetMajor, to, patchOnly, current: cur });
  const findings = [];

  if (!top || compareVersions(top.v, cur) <= 0) {
    return { current: cur, steps: [], profile: PROFILE.CURRENT, limitedBy: top?.reason ?? 'no-packages', findings };
  }

  const steps = [];
  // Каждый шаг несёт не только версию, но и обоснование из официального файла:
  // какой это стоп, что про него сказано и условный ли он.
  const push = (v, reason, extra = {}) => {
    if (compareVersions(v, cur) <= 0) return;
    if (compareVersions(v, top.v) > 0) return;
    if (steps.some((s) => compareVersions(s, v) === 0)) return;
    steps.push({ ...v, reason, stop: null, note: null, conditional: false, ...extra });
  };

  // Требование GitLab, которое чаще всего забывают: сперва последний патч своей минорной.
  const ownLatest = latestPatchOf(sorted, cur.major, cur.minor);
  if (ownLatest && compareVersions(ownLatest, cur) > 0) {
    push(ownLatest, 'latest-patch-of-current-minor', { stop: minorOf(cur) });
  }

  for (const entry of stops) {
    const stop = typeof entry === 'string' ? entry : entry.version;
    const conditional = typeof entry === 'object' && entry.conditional === true;
    const s = parseVersion(stop);
    if (!s) continue;
    if (s.major < cur.major || (s.major === cur.major && s.minor <= cur.minor)) continue;
    if (s.major > top.v.major || (s.major === top.v.major && s.minor > top.v.minor)) continue;
    const patch = latestPatchOf(sorted, s.major, s.minor);
    // Условная остановка нужна не каждому инстансу, но определить это надёжно
    // мы не можем. Лишний шаг стоит времени, пропущенный — целостности данных.
    const note = typeof entry === 'object' ? (entry.note ?? null) : null;
    if (patch) push(patch, conditional ? 'conditional-stop' : 'required-stop', { stop: minorOf(s), note, conditional });
    else if (!conditional) findings.push({ id: 'missing-stop-package', level: 'critical', stop: minorOf(s) });
  }

  push(top.v, top.reason === 'latest-available' ? 'target' : top.reason, { stop: minorOf(top.v) });
  steps.sort(compareVersions);

  return {
    current: cur,
    steps,
    target: steps[steps.length - 1] ?? null,
    profile: profileOf(cur, steps),
    limitedBy: top.reason,
    findings,
  };
}

/** Что меняется от профиля — таблица из docs/FLOWS.md, но в виде данных. */
export const PROFILE_POLICY = {
  [PROFILE.PATCH]:   { backup: 'db',         predownload: false, checks: 'fast', confirm: 'inline', screen: 'compact', suggestDetach: false, notify: ['error'] },
  [PROFILE.MINOR]:   { backup: 'db',         predownload: false, checks: 'full', confirm: 'plan',   screen: 'stream',  suggestDetach: 'if-long', notify: ['start', 'done', 'error'] },
  [PROFILE.LONG]:    { backup: 'first-full', predownload: true,  checks: 'full', confirm: 'yes',    screen: 'stream',  suggestDetach: true, notify: ['start', 'step', 'slow', 'done', 'error'] },
  [PROFILE.CURRENT]: { backup: 'none',       predownload: false, checks: 'fast', confirm: 'none',   screen: 'compact', suggestDetach: false, notify: [] },
};

export function policyFor(profile) {
  return PROFILE_POLICY[profile] ?? PROFILE_POLICY[PROFILE.LONG];
}

/** Коды возврата команды `check` — контракт для крона и мониторинга. */
export const EXIT = { CURRENT: 0, ERROR: 1, PATCH: 10, MINOR: 20, MAJOR: 30 };

/** Официальные заметки к мажорной серии. Канонический адрес проверен: /ee/…html редиректит сюда. */
export const changesDocUrl = (major) => `https://docs.gitlab.com/update/versions/gitlab_${major}_changes/`;

export function exitCodeFor(current, target) {
  if (!target || compareVersions(target, current) <= 0) return EXIT.CURRENT;
  if (target.major > current.major) return EXIT.MAJOR;
  if (target.minor > current.minor) return EXIT.MINOR;
  return EXIT.PATCH;
}

export { shortVersion };
