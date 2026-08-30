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

/** Минимальный PostgreSQL для версии GitLab. Сверяется с КОНЕЧНОЙ версией пути. */
export function requiredPostgres(matrix, version) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v) return null;
  let need = null;
  for (const [from, major] of Object.entries(matrix.min)) {
    if (compareVersions(v, parseVersion(from)) >= 0) need = major;
  }
  return need;
}
