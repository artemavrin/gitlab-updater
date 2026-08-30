import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockedError } from '../src/core/lock.js';
import { saveState, loadState, clearState, statePath, reconcile, STATE_VERSION } from '../src/core/state.js';

const dir = () => mkdtempSync(join(tmpdir(), 'glu-state-'));

test('замок держится и освобождается', () => {
  const d = dir();
  const lock = acquireLock(join(d, 'lock'));
  assert.ok(existsSync(join(d, 'lock')));
  lock.release();
  assert.equal(existsSync(join(d, 'lock')), false);
});

test('второй экземпляр не запускается, пока первый жив', () => {
  const d = dir();
  const lock = acquireLock(join(d, 'lock'));
  assert.throws(() => acquireLock(join(d, 'lock'), { pid: process.pid + 1 }), LockedError);
  lock.release();
});

test('замок мёртвого процесса забирается, а не блокирует навсегда', () => {
  const d = dir();
  const path = join(d, 'lock');
  writeFileSync(path, '999999\n');   // почти наверняка мёртвый pid
  const lock = acquireLock(path);
  assert.equal(String(readFileSync(path, 'utf8')).trim(), String(process.pid));
  lock.release();
});

/** Если нас сочли мёртвым и замок перехватили, безусловный rm пустил бы третий экземпляр. */
test('release не удаляет замок, перехваченный другим процессом', () => {
  const d = dir();
  const path = join(d, 'lock');
  const lock = acquireLock(path);
  writeFileSync(path, '424242\n');          // кто-то другой перехватил
  lock.release();
  assert.equal(String(readFileSync(path, 'utf8')).trim(), '424242', 'удалён чужой замок');
});

test('битый замок не роняет запуск', () => {
  const d = dir();
  const path = join(d, 'lock');
  writeFileSync(path, 'не число');
  const lock = acquireLock(path);
  lock.release();
});

test('состояние пишется атомарно и читается обратно', () => {
  const d = dir();
  saveState(d, { stepIndex: 2, phase: 'settle', expectedVersion: '16.3.9-ee.0' });
  const { state } = loadState(d);
  assert.equal(state.stepIndex, 2);
  assert.equal(state.stateVersion, STATE_VERSION);
  assert.match(state.updatedAt, /^\d{4}-/);
});

test('после записи не остаётся временных файлов', () => {
  const d = dir();
  saveState(d, { stepIndex: 0 });

  assert.deepEqual(readdirSync(d), ['state.json']);
});

test('состояние от другой версии инструмента не подхватывается молча', () => {
  const d = dir();
  writeFileSync(statePath(d), JSON.stringify({ stateVersion: 99, stepIndex: 1 }));
  assert.equal(loadState(d).error, 'state-version');
});

test('битый JSON не роняет процесс, а сообщает об ошибке', () => {
  const d = dir();
  writeFileSync(statePath(d), '{ оборвано');
  assert.equal(loadState(d).error, 'state-unreadable');
});

test('отсутствие состояния — не ошибка', () => {
  assert.deepEqual(loadState(dir()), { state: null });
});

test('очистка удаляет состояние', () => {
  const d = dir();
  saveState(d, { stepIndex: 0 });
  clearState(d);
  assert.equal(loadState(d).state, null);
});

/**
 * Между падением и resume сервер могли обновить руками. Продолжать по
 * сохранённому плану в этом случае нельзя: он рассчитан от другой версии.
 */
test('сверка ловит расхождение версии на диске', () => {
  const state = { expectedVersion: '16.11.10-ee.0', edition: 'ee' };
  assert.equal(reconcile(state, { version: '16.11.10-ee.0', edition: 'ee' }).ok, true);
  const bad = reconcile(state, { version: '17.3.7-ee.0', edition: 'ee' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'version-mismatch');
  assert.equal(bad.actual, '17.3.7-ee.0');
});

test('сверка ловит смену редакции', () => {
  const r = reconcile({ expectedVersion: '16.11.10-ee.0', edition: 'ee' }, { version: '16.11.10-ee.0', edition: 'ce' });
  assert.equal(r.reason, 'edition-changed');
});

test('неизвестная версия на диске — не повод продолжать', () => {
  assert.equal(reconcile({ expectedVersion: 'x' }, null).reason, 'version-unknown');
});
