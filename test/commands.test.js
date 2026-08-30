import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createExec, MODE } from '../src/core/exec.js';
import { createTranslator } from '../src/i18n/index.js';
import { commandCheck } from '../src/commands/check.js';
import { commandPlan } from '../src/commands/plan.js';
import { EXIT } from '../src/plan/planner.js';
import { fixturesFor, checkFixtures, osReleaseJammy, osReleaseFocal } from './fixtures/index.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = {
  upgradePath: JSON.parse(readFileSync('data/upgrade-path.json', 'utf8')),
  osMatrix: JSON.parse(readFileSync('data/os-matrix.json', 'utf8')),
  pgRequirements: JSON.parse(readFileSync('data/pg-requirements.json', 'utf8')),
};

const dir = mkdtempSync(join(tmpdir(), 'glu-'));
const osPath = (text) => {
  const p = join(dir, `os-${Math.random().toString(36).slice(2)}`);
  writeFileSync(p, text);
  return p;
};

const ctx = (version, { lang = 'ru', os = osReleaseJammy, ...flags } = {}) => ({
  exec: createExec({ mode: MODE.REPLAY, fixtures: { ...fixturesFor({ version }), ...checkFixtures() } }),
  t: createTranslator(lang),
  flags: { from: null, to: null, targetMajor: null, safeForOs: false, patchOnly: false, force: false, minFreeGb: null, ...flags },
  config: { proxy: 'socks5h://svc:s3cret@10.0.0.5:1080' },
  data,
  osPath: osPath(os),
  uid: 0, env: {}, isTty: false,
});

test('check на патче возвращает код 10 и называет версию', async () => {
  const r = await commandCheck(ctx('17.11.4-ee.0'));
  assert.equal(r.code, EXIT.PATCH);
  assert.match(r.lines.join('\n'), /17\.11\.6-ee\.0/);
});

test('check на последней версии возвращает 0', async () => {
  const r = await commandCheck(ctx('17.11.6-ee.0'));
  assert.equal(r.code, EXIT.CURRENT);
});

test('check с древней базы возвращает код мажорного обновления', async () => {
  const r = await commandCheck(ctx('15.11.13-ee.0'));
  assert.equal(r.code, EXIT.MAJOR);
});

test('план длинного пути перечисляет остановки и предупреждает про откат', async () => {
  const r = await commandPlan(ctx('15.11.13-ee.0'));
  const text = r.lines.join('\n');
  assert.match(text, /16\.3\.9-ee\.0/);
  assert.match(text, /Отката нет/);
  assert.match(text, /обязательная остановка/);
});

test('план патча не пугает предупреждением про откат', async () => {
  const text = (await commandPlan(ctx('17.11.4-ee.0'))).lines.join('\n');
  assert.ok(!/Отката нет/.test(text), 'для патча этот блок только мешает');
  assert.match(text, /бэкап БД и конфигов/);
});

test('пароль прокси не попадает в вывод плана', async () => {
  const text = (await commandPlan(ctx('17.11.4-ee.0'))).lines.join('\n');
  assert.ok(!text.includes('s3cret'), 'пароль прокси утёк на экран');
  assert.match(text, /svc:\*\*\*@/);
});

test('--safe-for-os на 20.04 обрезает путь и объясняет причину', async () => {
  const r = await commandPlan(ctx('16.3.9-ee.0', { os: osReleaseFocal, safeForOs: true }));
  const text = r.lines.join('\n');
  assert.match(text, /17\.5\.5-ee\.0/);
  assert.ok(!/17\.11\.6/.test(text));
  assert.match(text, /потолок текущей ОС/);
});

test('план рендерится в обеих локалях и укладывается в 78 колонок', async () => {
  for (const lang of ['ru', 'en']) {
    for (const from of ['17.11.4-ee.0', '15.11.13-ee.0', '17.11.6-ee.0']) {
      const r = await commandPlan(ctx(from, { lang }));
      for (const line of r.lines) {
        assert.ok([...line].length <= 78, `${lang}/${from}: строка длиннее 78 колонок: «${line}»`);
      }
    }
  }
});

test('план показывает проверки готовности, а не только шаги', async () => {
  const text = (await commandPlan(ctx('17.11.4-ee.0'))).lines.join('\n');
  assert.match(text, /сервисы GitLab/);
  assert.match(text, /пройдено/);
});

/**
 * План остаётся виден — он информативен, — но код возврата говорит правду:
 * выполнить его сейчас нельзя.
 */
test('критическая проверка меняет код плана на ошибку, но план не прячет', async () => {
  const broken = ctx('17.11.4-ee.0');
  broken.exec = createExec({ mode: MODE.REPLAY, fixtures: {
    ...fixturesFor({ version: '17.11.4-ee.0' }), ...checkFixtures(),
    'test -f /etc/gitlab/gitlab-secrets.json': { code: 1, stdout: '' },
  } });
  const r = await commandPlan(broken);
  assert.equal(r.code, EXIT.ERROR);
  assert.equal(r.errorCode, 'checks-failed');
  assert.equal(r.result.checks.blocked, true);
  assert.match(r.lines.join('\n'), /17\.11\.6-ee\.0/, 'план обязан остаться видимым');
});

test('длинная диагностика обрезается, а не ломает выравнивание', async () => {
  const noisy = ctx('17.11.4-ee.0');
  noisy.exec = createExec({ mode: MODE.REPLAY, fixtures: {
    ...fixturesFor({ version: '17.11.4-ee.0' }), ...checkFixtures(),
    'gitlab-psql --version': { code: 1, stdout: '', stderr: 'x'.repeat(400) },
  } });
  for (const line of (await commandPlan(noisy)).lines) {
    assert.ok([...line].length <= 78, `строка длиннее 78: ${line}`);
  }
});

test('недоступный репозиторий — ошибка с подсказкой, а не пустой план', async () => {
  const broken = ctx('17.11.4-ee.0');
  broken.exec = createExec({ mode: MODE.REPLAY, fixtures: { ...fixturesFor(), ...checkFixtures(), 'apt-cache madison gitlab-ee': { code: 100, stdout: '', stderr: 'E: no packages' } } });
  const r = await commandCheck(broken);
  assert.equal(r.code, EXIT.ERROR);
  assert.match(r.lines.join('\n'), /proxy test/);
});
