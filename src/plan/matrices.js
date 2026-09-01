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

/**
 * С какой версии PostgreSQL шаг поедет — с поправкой на то, чья это база.
 *
 * Для встроенной и внешней это разные числа, и разница не косметическая.
 * Таблица требований в документации написана про внешний PostgreSQL: для
 * GitLab 17.x там 14.14. А пакет omnibus 17.1.8 несёт PostgreSQL 14.11 —
 * то есть встроенной базе взять 14.14 просто неоткуда, и требование
 * останавливает подъём навсегда. Проверено вживую: инструмент так и
 * остановился на 17.1.8 при 14.11, которую сам же и поставил шагом раньше.
 *
 * Для встроенной берём Gitlab::Database::MINIMUM_POSTGRES_VERSION — мажорную
 * из кода GitLab. Ниже неё код действительно не работает; выше работает то,
 * что принёс пакет.
 *
 * Неизвестное происхождение базы считаем внешним: там requirement строже, а
 * ошибиться в сторону лишней остановки дешевле, чем поставить пакет на базу,
 * с которой он не заведётся.
 */
export function pgFloor(range, { bundled = null } = {}) {
  if (!range) return null;
  return bundled === true ? (range.bundled_min ?? range.min) : range.min;
}

export function postgresRange(matrix, version) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v) return null;
  let range = null;
  for (const [from, r] of Object.entries(matrix.ranges)) {
    if (compareVersions(v, parseVersion(from)) >= 0) range = r;
  }
  return range;
}
