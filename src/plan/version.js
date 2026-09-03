/** Разбор и сравнение версий GitLab вида 17.11.4-ee.0 */

const RE = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+](ee|ce)[.\d]*)?/i;

export function parseVersion(input) {
  if (!input) return null;
  const m = RE.exec(String(input).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? null : Number(m[3]),
    edition: m[4] ? m[4].toLowerCase() : null,
    raw: String(input).trim(),
  };
}

export const shortVersion = (v) => `${v.major}.${v.minor}${v.patch === null ? '' : `.${v.patch}`}`;
export const minorOf = (v) => `${v.major}.${v.minor}`;

/**
 * Отрицательное — a < b. patch === null считается нулём.
 *
 * Объект без числовых major и minor — ошибка, а не «равно». Без этой проверки
 * `undefined - 16` даёт NaN, NaN в цепочке `||` ложен, и выражение доходит до
 * `0 - 0`, то есть до нуля: неразобранная версия оказывалась равной любой.
 * Один раз это уже вылезло — диапазон PostgreSQL подошёл весь, и выиграл
 * последний, потребовав от здорового инстанса версию 17.
 */
export function compareVersions(a, b) {
  const A = typeof a === 'string' ? parseVersion(a) : a;
  const B = typeof b === 'string' ? parseVersion(b) : b;
  if (!A || !B) throw new TypeError('cannot parse version');
  for (const v of [A, B]) {
    if (!Number.isFinite(v.major) || !Number.isFinite(v.minor)) {
      throw new TypeError(`cannot compare version: ${JSON.stringify(v)}`);
    }
  }
  return A.major - B.major || A.minor - B.minor || (A.patch ?? 0) - (B.patch ?? 0);
}

export const sameMinor = (a, b) => a.major === b.major && a.minor === b.minor;

/** Версия из строки `apt-cache madison`: "  gitlab-ee | 17.11.4-ee.0 | https://..." */
/**
 * Кодовое имя выпуска из третьей колонки madison.
 *
 * Формат: «<url> <suite>/<component> <arch> Packages», где suite — это
 * jammy, focal, bookworm. Берём токен с «/», который не выглядит как URL.
 * Не разобрали — null: выдумывать выпуск здесь нельзя, на этом строится
 * сверка с ОС.
 */
export function madisonSuite(column) {
  for (const token of String(column ?? '').trim().split(/\s+/)) {
    if (token.includes('://')) continue;
    const [suite] = token.split('/');
    if (/^[a-z][a-z0-9-]*$/.test(suite) && suite !== 'Packages') return suite;
  }
  return null;
}

export function parseMadison(stdout) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 2 || !parts[1]) continue;
    const v = parseVersion(parts[1]);
    // Третья колонка madison — откуда пакет: «https://…/ubuntu jammy/main
    // amd64 Packages». Кодовое имя оттуда единственный способ узнать, под
    // какой выпуск собрано то, что apt реально поставит.
    if (v) out.push({ ...v, package: parts[0], aptVersion: parts[1], suite: madisonSuite(parts[2]) });
  }
  return out.sort(compareVersions);
}

/** Последний доступный патч внутри указанной минорной версии. */
export function latestPatchOf(available, major, minor) {
  const inMinor = available.filter((v) => v.major === major && v.minor === minor);
  return inMinor.length ? inMinor[inMinor.length - 1] : null;
}

/**
 * Версия не выше потолка, где потолок записан минорной серией.
 *
 * В `data/os-matrix.json` потолок — это «16.11», то есть вся линейка 16.11.x,
 * а не точка 16.11.0. Обычное сравнение считает отсутствующий patch нулём и
 * отрезает последнюю серию целиком: для bionic путь заканчивался на 16.7
 * вместо 16.11, то есть на минорную версию раньше, чем нужно.
 */
export function withinCeiling(v, ceil) {
  const C = typeof ceil === 'string' ? parseVersion(ceil) : ceil;
  if (!C) return true;
  if (C.patch !== null) return compareVersions(v, C) <= 0;
  return v.major < C.major || (v.major === C.major && v.minor <= C.minor);
}
