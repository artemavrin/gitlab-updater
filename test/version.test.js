import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, parseMadison, latestPatchOf, sameMinor, withinCeiling } from '../src/plan/version.js';
import { madison1711 } from './fixtures/index.js';

test('разбирает версию GitLab с редакцией и суффиксом apt', () => {
  const v = parseVersion('17.11.4-ee.0');
  assert.deepEqual([v.major, v.minor, v.patch, v.edition], [17, 11, 4, 'ee']);
});

test('разбирает минорную версию без патча', () => {
  const v = parseVersion('16.11');
  assert.equal(v.patch, null);
  assert.equal(v.minor, 11);
});

test('сравнение учитывает все три компонента, а не строковый порядок', () => {
  assert.ok(compareVersions('17.11.4', '17.9.0') > 0, '17.11 новее 17.9');
  assert.ok(compareVersions('16.11.10', '17.3.7') < 0);
  assert.equal(compareVersions('17.11.4-ee.0', '17.11.4'), 0);
});

test('madison разбирается и сортируется по возрастанию', () => {
  const v = parseMadison(madison1711);
  assert.equal(v.length, 11);
  assert.equal(v[0].raw, '15.11.13-ee.0');
  assert.equal(v.at(-1).raw, '17.11.6-ee.0');
});

test('latestPatchOf берёт максимальный патч внутри минорной версии', () => {
  const v = parseMadison(madison1711);
  assert.equal(latestPatchOf(v, 17, 11).patch, 6);
  assert.equal(latestPatchOf(v, 17, 9), null);
});

test('sameMinor не путает 17.1 и 17.11', () => {
  assert.equal(sameMinor(parseVersion('17.1.0'), parseVersion('17.11.0')), false);
});

test('потолок ОС — это вся минорная серия, а не её нулевой патч', () => {
  // В матрице записано «16.11», и это значит всю линейку 16.11.x. Обычное
  // сравнение считает отсутствующий patch нулём, и путь на bionic
  // заканчивался на 16.7 — на минорную версию раньше, чем можно.
  assert.equal(withinCeiling(parseVersion('16.11.10-ee.0'), '16.11'), true);
  assert.equal(withinCeiling(parseVersion('16.11.0-ee.0'), '16.11'), true);
  assert.equal(withinCeiling(parseVersion('17.0.0-ee.0'), '16.11'), false);
  assert.equal(withinCeiling(parseVersion('16.7.10-ee.0'), '16.11'), true);
  // Потолок с патчем остаётся точкой: так его и записали.
  assert.equal(withinCeiling(parseVersion('16.11.10-ee.0'), '16.11.2'), false);
  // Нет потолка — нет ограничения.
  assert.equal(withinCeiling(parseVersion('99.0.0'), null), true);
});

test('неразобранная версия — ошибка сравнения, а не «равно всему»', () => {
  // NaN в цепочке `||` ложен, поэтому `undefined - 16 || undefined - 0 || 0 - 0`
  // доходило до нуля: объект без major оказывался равен любой версии. Один раз
  // из-за этого здоровому инстансу потребовали PostgreSQL 17 — подошёл весь
  // диапазон требований, и выиграла последняя строка таблицы.
  assert.throws(() => compareVersions({ raw: '17.11.6-ee.0' }, parseVersion('16.0')), TypeError);
  assert.throws(() => compareVersions(parseVersion('16.0'), { major: 17 }), TypeError);
  // Строку разбираем сами, а отсутствующий patch — законен.
  assert.equal(compareVersions('17.11.6-ee.0', parseVersion('16.0')) > 0, true);
  assert.equal(compareVersions(parseVersion('16.11'), parseVersion('16.11.0')), 0);
});
