import { parseVersion, compareVersions } from './version.js';

/**
 * Потолок GitLab по версии ОС — только ради раннего понятного сообщения.
 * Источник истины по совместимости — наличие пакета в apt-cache madison:
 * матрица может устареть, apt — нет.
 */
export function osCeiling(matrix, os) {
  if (!os) return null;
  const key = `${os.id}:${os.versionId}`;
  return Object.hasOwn(matrix.max, key) ? matrix.max[key] : null;
}

export function osKnown(matrix, os) {
  return Boolean(os) && Object.hasOwn(matrix.max, `${os.id}:${os.versionId}`);
}

/**
 * Диапазон поддерживаемых версий PostgreSQL для версии GitLab.
 * Сверяется с КОНЕЧНОЙ версией пути: узнать о нехватке за пять шагов
 * до неё лучше, чем на пятом шаге.
 *
 * Границы хранятся с той же точностью, что в официальной таблице
 * (`14.14`, а не `14`): PostgreSQL 14.2 требованию GitLab 17 не удовлетворяет.
 */
/**
 * Сравнение версий PostgreSQL. Отдельно от версий GitLab: границы бывают
 * записаны как «17» без минорной части, а parseVersion такое не разбирает.
 */
export function comparePg(a, b) {
  const parts = (v) => String(v).split('.').map(Number);
  const A = parts(a);
  const B = parts(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const pgMajor = (v) => Number(String(v).split('.')[0]);

export function postgresRange(matrix, version) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v) return null;
  let range = null;
  for (const [from, r] of Object.entries(matrix.ranges)) {
    if (compareVersions(v, parseVersion(from)) >= 0) range = r;
  }
  return range;
}
