import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExec, MODE } from '../src/core/exec.js';
import { createTranslator } from '../src/i18n/index.js';
import { commandNext } from '../src/commands/next.js';
import { EXIT, changesDocUrl } from '../src/plan/planner.js';
import { COMMANDS } from '../src/cli/registry.js';
import { fixturesFor, osReleaseJammy } from './fixtures/index.js';

const data = {
  upgradePath: JSON.parse(readFileSync('data/upgrade-path.json', 'utf8')),
  osMatrix: JSON.parse(readFileSync('data/os-matrix.json', 'utf8')),
  pgRequirements: JSON.parse(readFileSync('data/pg-requirements.json', 'utf8')),
};
const dir = mkdtempSync(join(tmpdir(), 'glu-next-'));
const osFile = join(dir, 'os-release');
writeFileSync(osFile, osReleaseJammy);

const ctx = (version, flags = {}) => ({
  exec: createExec({ mode: MODE.REPLAY, fixtures: fixturesFor({ version }) }),
  t: createTranslator('ru'),
  flags: { from: null, to: null, targetMajor: null, safeForOs: false, patchOnly: false, quiet: false, ...flags },
  config: { proxy: null },
  data,
  osPath: osFile,
});

test('отдаёт ровно следующий шаг, а не конечную цель', async () => {
  const r = await commandNext(ctx('15.11.13-ee.0'));
  assert.equal(r.result.version, '16.3.9-ee.0');
  assert.equal(r.result.remaining, 7);
  assert.equal(r.result.final, false);
});

test('следующий шаг после 16.11 — условная остановка 17.1 с официальным примечанием', async () => {
  const r = await commandNext(ctx('16.11.10-ee.0'));
  assert.equal(r.result.version, '17.1.8-ee.0');
  assert.equal(r.result.reason, 'conditional-stop');
  assert.equal(r.result.conditional, true);
  assert.equal(r.result.stop, '17.1');
  assert.match(r.result.note, /Conditional stop/i);
});

test('обоснование ссылается на официальные заметки к своей мажорной серии', async () => {
  const r = await commandNext(ctx('16.11.10-ee.0'));
  assert.equal(r.result.docs, changesDocUrl(17));
  assert.equal(r.result.source, data.upgradePath.source);
  assert.equal(r.result.verifiedAt, data.upgradePath.verified_at);
});

test('патч — единственный и последний шаг', async () => {
  const r = await commandNext(ctx('17.11.4-ee.0'));
  assert.equal(r.result.version, '17.11.6-ee.0');
  assert.equal(r.result.final, true);
  assert.equal(r.result.remaining, 0);
  assert.equal(r.code, EXIT.PATCH);
});

test('на последней версии не выдумывает шаг', async () => {
  const r = await commandNext(ctx('17.11.6-ee.0'));
  assert.equal(r.result.version, null);
  assert.equal(r.code, EXIT.CURRENT);
});

test('--quiet отдаёт только версию — то, что подставляют в apt-get', async () => {
  const r = await commandNext(ctx('16.11.10-ee.0', { quiet: true }));
  assert.deepEqual(r.lines, ['17.1.8-ee.0']);
});

test('--quiet на актуальной версии молчит, а не печатает пустую строку', async () => {
  const r = await commandNext(ctx('17.11.6-ee.0', { quiet: true }));
  assert.deepEqual(r.lines, []);
  assert.equal(r.code, EXIT.CURRENT);
});

/**
 * У check код описывает весь разрыв до цели, у next — размер ближайшего шага.
 * С 16.3.9 весь путь мажорный, но следующий шаг 16.7.10 — минорный.
 */
test('код возврата описывает ближайший шаг, а не весь путь', async () => {
  assert.equal((await commandNext(ctx('17.11.4-ee.0'))).code, EXIT.PATCH);
  assert.equal((await commandNext(ctx('17.8.7-ee.0'))).code, EXIT.MINOR);
  assert.equal((await commandNext(ctx('16.3.9-ee.0'))).code, EXIT.MINOR, 'следующий шаг 16.7 — минорный');
  assert.equal((await commandNext(ctx('16.11.10-ee.0'))).code, EXIT.MAJOR, 'следующий шаг 17.1 — мажорный');
});

test('поля result совпадают с объявленными в реестре', async () => {
  for (const version of ['16.11.10-ee.0', '17.11.6-ee.0']) {
    const r = await commandNext(ctx(version));
    assert.deepEqual(Object.keys(r.result).sort(), Object.keys(COMMANDS.next.result).sort());
  }
});

test('последовательные вызовы ведут по всему пути и сходятся к цели', async () => {
  let current = '15.11.13-ee.0';
  const walked = [];
  for (let i = 0; i < 20; i++) {
    const r = await commandNext(ctx(current));
    if (!r.result.version) break;
    walked.push(r.result.version);
    current = r.result.version;
  }
  assert.deepEqual(walked, [
    '16.3.9-ee.0', '16.7.10-ee.0', '16.11.10-ee.0', '17.1.8-ee.0',
    '17.3.7-ee.0', '17.5.5-ee.0', '17.8.7-ee.0', '17.11.6-ee.0',
  ]);
});
