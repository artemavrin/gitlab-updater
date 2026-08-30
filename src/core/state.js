import { writeFileSync, readFileSync, rmSync, mkdirSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STATE_VERSION = 1;

/**
 * Состояние прерванного запуска.
 *
 * Живёт в /var/lib, а не в /var/tmp: там чистка по крону, а потерянный state
 * означает потерянный resume посреди многочасового пути.
 *
 * Запись атомарная: временный файл рядом, fsync, затем rename. Оборванная
 * запись оставила бы битый JSON, из которого resume уже не поднимется.
 */
export const statePath = (dir) => join(dir, 'state.json');

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = statePath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  // Служебные поля идут последними: иначе загруженное состояние перебило бы
  // их своими старыми значениями, и updatedAt навсегда застыл бы на первом.
  const body = JSON.stringify({ ...state, stateVersion: STATE_VERSION, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(tmp, body, { mode: 0o600 });
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, target);
  return target;
}

export function loadState(dir) {
  try {
    const raw = readFileSync(statePath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.stateVersion !== STATE_VERSION) return { error: 'state-version', found: parsed.stateVersion };
    return { state: parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return { state: null };
    return { error: 'state-unreadable', detail: err.message };
  }
}

export function clearState(dir) {
  rmSync(statePath(dir), { force: true });
}

/**
 * Сверка сохранённого состояния с тем, что реально на диске.
 *
 * Продолжать вслепую нельзя: между падением и resume сервер могли обновить
 * руками, и тогда сохранённый план рассчитан не от той версии.
 */
export function reconcile(state, actual) {
  if (!state) return { ok: false, reason: 'no-state' };
  if (!actual) return { ok: false, reason: 'version-unknown' };
  if (state.edition && actual.edition && state.edition !== actual.edition) {
    return { ok: false, reason: 'edition-changed', expected: state.edition, actual: actual.edition };
  }
  // Установка — единственная фаза, где на диске законно может быть как старая
  // версия (dpkg не дошёл), так и новая (дошёл, но нас убили после). Отвергать
  // оба варианта значило бы запрещать resume ровно после самого долгого шага.
  const allowed = state.phase === 'install'
    ? [state.expectedVersion, state.installing].filter(Boolean)
    : [state.expectedVersion];
  if (!allowed.includes(actual.version)) {
    return { ok: false, reason: 'version-mismatch', expected: allowed.join(' | '), actual: actual.version };
  }
  return { ok: true, installedAhead: actual.version === state.installing };
}
