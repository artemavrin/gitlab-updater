import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUpgradePathYml, stopVersions, isStale, STALE_AFTER_DAYS } from '../src/plan/upgradePathSource.js';
import { commandRefreshPath } from '../src/commands/refreshPath.js';
import { createTranslator } from '../src/i18n/index.js';

const officialYml = readFileSync('test/fixtures/upgrade_path.yml', 'utf8');
const ours = JSON.parse(readFileSync('data/upgrade-path.json', 'utf8'));

/**
 * Самый важный тест проекта: неверный список остановок уверенно приводит
 * пользователя в сломанный GitLab, и до боевого апгрейда это не проявится.
 */
test('наши остановки в точности совпадают с официальным upgrade_path.yml', () => {
  const official = stopVersions(parseUpgradePathYml(officialYml));
  assert.deepEqual(stopVersions(ours.stops), official);
});

test('остановки строго возрастают и не повторяются', () => {
  const nums = stopVersions(ours.stops).map((v) => v.split('.').map(Number));
  for (let i = 1; i < nums.length; i++) {
    const [aM, aN] = nums[i - 1];
    const [bM, bN] = nums[i];
    assert.ok(bM > aM || (bM === aM && bN > aN), `порядок нарушен на ${nums[i - 1].join('.')} → ${nums[i].join('.')}`);
  }
});

test('17.1 присутствует и помечена условной — её пропуск ломает часть инстансов', () => {
  const stop = ours.stops.find((s) => s.version === '17.1');
  assert.ok(stop, '17.1 пропала из данных');
  assert.equal(stop.conditional, true);
  assert.match(stop.note, /Conditional stop/i);
});

test('парсер вытаскивает примечания и распознаёт условные остановки', () => {
  const stops = parseUpgradePathYml(officialYml);
  assert.ok(stops.find((s) => s.version === '14.0').note.includes('Migrations can take a long time'));
  assert.deepEqual(stops.filter((s) => s.conditional).map((s) => s.version), ['17.1']);
});

test('парсер не падает на пустом и мусорном вводе', () => {
  assert.deepEqual(parseUpgradePathYml(''), []);
  assert.deepEqual(parseUpgradePathYml('не yaml вовсе\n- major: x\n'), []);
});

test('данные протухают через полгода', () => {
  const now = new Date('2026-08-30');
  assert.equal(isStale('2026-08-01', now), false);
  assert.equal(isStale('2025-01-01', now), true);
  assert.equal(isStale('не дата', now), true);
  const edge = new Date(now.getTime() - (STALE_AFTER_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  assert.equal(isStale(edge, now), false);
});

const ctx = (body, flags = {}) => ({
  t: createTranslator('ru'),
  flags: { yes: false, ...flags },
  config: { proxy: null, proxyCa: null },
  data: { upgradePath: ours },
  dataPath: '/dev/null',
  fetcher: async () => ({ status: 200, body }),
});

test('refresh-path на актуальных данных не находит расхождений', async () => {
  const r = await commandRefreshPath(ctx(officialYml));
  assert.equal(r.code, 0);
  assert.deepEqual(r.result.added, []);
  assert.deepEqual(r.result.removed, []);
  assert.match(r.lines.join('\n'), /Данные актуальны/);
});

test('refresh-path показывает новую остановку и без --yes ничего не пишет', async () => {
  const withNew = officialYml + '\n- major: 20\n  minor: 0\n';
  const r = await commandRefreshPath(ctx(withNew));
  assert.deepEqual(r.result.added, ['20.0']);
  assert.equal(r.result.applied, false);
  assert.match(r.lines.join('\n'), /--yes/);
});

test('недоступный официальный файл — понятная ошибка со стабильным кодом', async () => {
  const broken = { ...ctx(''), fetcher: async () => { throw new Error('ECONNREFUSED'); } };
  const r = await commandRefreshPath(broken);
  assert.equal(r.code, 1);
  assert.equal(r.errorCode, 'upgrade-path-unreachable');
  assert.match(r.lines.join('\n'), /ECONNREFUSED/);
});

test('пустой ответ не затирает данные молча', async () => {
  const r = await commandRefreshPath(ctx('', { yes: true }));
  assert.equal(r.code, 1);
  assert.equal(r.errorCode, 'upgrade-path-unreachable');
});
