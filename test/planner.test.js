import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMadison, compareVersions } from '../src/plan/version.js';
import { buildPlan, PROFILE, exitCodeFor, EXIT, policyFor } from '../src/plan/planner.js';
import { madison1711 } from './fixtures/index.js';

const stops = JSON.parse(readFileSync('data/upgrade-path.json', 'utf8')).stops;
const available = parseMadison(madison1711);
const plan = (current, opts = {}) => buildPlan({ current, available, stops, ...opts });

test('патч внутри минорной версии — один шаг и профиль patch', () => {
  const p = plan('17.11.4-ee.0');
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].raw, '17.11.6-ee.0');
  assert.equal(p.profile, PROFILE.PATCH);
});

test('длинный путь проходит через все обязательные остановки между началом и целью', () => {
  const p = plan('15.11.13-ee.0');
  const got = p.steps.map((s) => `${s.major}.${s.minor}`);
  assert.deepEqual(got, ['16.3', '16.7', '16.11', '17.3', '17.5', '17.8', '17.11']);
  assert.equal(p.profile, PROFILE.LONG);
});

test('путь строго возрастает и не содержит повторов', () => {
  for (const from of ['15.11.13-ee.0', '16.3.9-ee.0', '17.3.7-ee.0', '17.11.0-ee.0']) {
    const steps = plan(from).steps;
    for (let i = 1; i < steps.length; i++) {
      assert.ok(compareVersions(steps[i - 1], steps[i]) < 0, `${from}: шаги не возрастают`);
    }
  }
});

test('сначала последний патч своей минорной версии — требование, которое чаще всего забывают', () => {
  const p = plan('16.3.0-ee.0');
  assert.equal(p.steps[0].raw, '16.3.9-ee.0');
  assert.equal(p.steps[0].reason, 'latest-patch-of-current-minor');
});

test('--safe-for-os обрезает путь по потолку ОС и называет причину', () => {
  const p = plan('16.3.9-ee.0', { osMax: '17.7' });
  assert.equal(p.target.raw, '17.5.5-ee.0');
  assert.equal(p.limitedBy, 'os-ceiling');
  assert.ok(!p.steps.some((s) => s.minor === 11 && s.major === 17));
});

test('--patch-only не выпускает за пределы текущей минорной версии', () => {
  const p = plan('17.11.0-ee.0', { patchOnly: true });
  assert.equal(p.steps.length, 1);
  assert.equal(p.target.raw, '17.11.6-ee.0');
  assert.equal(p.profile, PROFILE.PATCH);
});

test('--patch-only на последнем патче не даёт шагов', () => {
  const p = plan('17.11.6-ee.0', { patchOnly: true });
  assert.equal(p.steps.length, 0);
  assert.equal(p.profile, PROFILE.CURRENT);
});

test('--target-major ограничивает верхнюю границу', () => {
  const p = plan('15.11.13-ee.0', { targetMajor: 16 });
  assert.equal(p.target.major, 16);
  assert.equal(p.limitedBy, 'target-major');
});

test('на последней версии путь пуст', () => {
  const p = plan('17.11.6-ee.0');
  assert.equal(p.steps.length, 0);
  assert.equal(p.profile, PROFILE.CURRENT);
});

test('коды возврата check различают патч, минор и мажор', () => {
  assert.equal(exitCodeFor(plan('17.11.6-ee.0').current, null), EXIT.CURRENT);
  assert.equal(exitCodeFor(plan('17.11.4-ee.0').current, plan('17.11.4-ee.0').target), EXIT.PATCH);
  assert.equal(exitCodeFor(plan('17.8.7-ee.0').current, plan('17.8.7-ee.0').target), EXIT.MINOR);
  assert.equal(exitCodeFor(plan('16.3.9-ee.0').current, plan('16.3.9-ee.0').target), EXIT.MAJOR);
});

test('политика профиля соответствует таблице из FLOWS.md', () => {
  assert.deepEqual(
    { ...policyFor(PROFILE.PATCH) },
    { backup: 'db', predownload: false, checks: 'fast', confirm: 'inline', screen: 'compact', suggestDetach: false, notify: ['error'] }
  );
  assert.equal(policyFor(PROFILE.LONG).predownload, true);
  assert.equal(policyFor(PROFILE.LONG).backup, 'first-full');
});

test('нет пакета для обязательной остановки — критическая находка, а не тихий пропуск', () => {
  const gapped = available.filter((v) => !(v.major === 16 && v.minor === 7));
  const p = buildPlan({ current: '15.11.13-ee.0', available: gapped, stops });
  assert.ok(p.findings.some((f) => f.id === 'missing-stop-package' && f.stop === '16.7'));
});
