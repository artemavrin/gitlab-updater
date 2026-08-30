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

/** Отрицательное — a < b. patch === null считается нулём. */
export function compareVersions(a, b) {
  const A = typeof a === 'string' ? parseVersion(a) : a;
  const B = typeof b === 'string' ? parseVersion(b) : b;
  if (!A || !B) throw new TypeError('cannot parse version');
  return A.major - B.major || A.minor - B.minor || (A.patch ?? 0) - (B.patch ?? 0);
}

export const sameMinor = (a, b) => a.major === b.major && a.minor === b.minor;

/** Версия из строки `apt-cache madison`: "  gitlab-ee | 17.11.4-ee.0 | https://..." */
export function parseMadison(stdout) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 2 || !parts[1]) continue;
    const v = parseVersion(parts[1]);
    if (v) out.push({ ...v, package: parts[0], aptVersion: parts[1] });
  }
  return out.sort(compareVersions);
}

/** Последний доступный патч внутри указанной минорной версии. */
export function latestPatchOf(available, major, minor) {
  const inMinor = available.filter((v) => v.major === major && v.minor === minor);
  return inMinor.length ? inMinor[inMinor.length - 1] : null;
}
