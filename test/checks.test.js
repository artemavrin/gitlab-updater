import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExec, MODE } from '../src/core/exec.js';
import { createTranslator, LOCALES } from '../src/i18n/index.js';
import { runChecks, CHECKS, DEPTH, blocked, gate } from '../src/checks/index.js';
import { commandDoctor } from '../src/commands/doctor.js';
import { LEVEL } from '../src/core/events.js';
import { COMMANDS } from '../src/cli/registry.js';
import { EXIT } from '../src/plan/planner.js';
import { checkFixtures, fixturesFor, ctlStatusDegraded, dfTight, osReleaseJammy, osReleaseFocal } from './fixtures/index.js';

const data = {
  upgradePath: JSON.parse(readFileSync('data/upgrade-path.json', 'utf8')),
  osMatrix: JSON.parse(readFileSync('data/os-matrix.json', 'utf8')),
  pgRequirements: JSON.parse(readFileSync('data/pg-requirements.json', 'utf8')),
};
const dir = mkdtempSync(join(tmpdir(), 'glu-checks-'));
const osPath = (text) => {
  const p = join(dir, `os-${Math.random().toString(36).slice(2)}`);
  writeFileSync(p, text);
  return p;
};

const base = (over = {}, fixtures = {}) => ({
  exec: createExec({ mode: MODE.REPLAY, fixtures: { ...checkFixtures(), ...fixtures } }),
  uid: 0,
  env: {},
  isTty: false,
  minFreeGb: 5,
  safeForOs: false,
  data,
  os: { id: 'ubuntu', versionId: '22.04', pretty: 'Ubuntu 22.04.4 LTS', supported: true },
  plan: { steps: [{ raw: '17.11.6-ee.0' }], target: { major: 17, minor: 11, patch: 6, raw: '17.11.6-ee.0' } },
  ...over,
});

const byId = (findings, id) => findings.find((f) => f.id === id);

test('здоровый инстанс проходит все проверки', async () => {
  const s = await runChecks(base(), { depth: DEPTH.FULL });
  assert.equal(s.critical, 0, JSON.stringify(s.findings.filter((f) => f.level !== LEVEL.OK)));
  assert.equal(s.warnings, 0);
});

test('без root — критическая остановка', async () => {
  const s = await runChecks(base({ uid: 1000 }));
  assert.equal(byId(s.findings, 'root').level, LEVEL.CRITICAL);
  assert.ok(blocked(s));
});

test('упавшая миграция останавливает и не лечится --force', async () => {
  const s = await runChecks(base({}, { [Object.keys(checkFixtures()).find((k) => k.startsWith('gitlab-rails'))]: { code: 0, stdout: '0 1' } }));
  const f = byId(s.findings, 'migrations-failed');
  assert.equal(f.level, LEVEL.CRITICAL);
  assert.equal(f.params.n, 1);
  assert.ok(blocked(s), 'critical обязан блокировать независимо от --force');
});

test('незавершённые миграции — предупреждение, а не остановка', async () => {
  const key = Object.keys(checkFixtures()).find((k) => k.startsWith('gitlab-rails'));
  const s = await runChecks(base({}, { [key]: { code: 0, stdout: '7 0' } }));
  assert.equal(byId(s.findings, 'migrations-pending').level, LEVEL.WARN);
  assert.equal(blocked(s), false);
});

test('неизвестное состояние миграций — предупреждение, а не «в порядке»', async () => {
  const key = Object.keys(checkFixtures()).find((k) => k.startsWith('gitlab-rails'));
  const s = await runChecks(base({}, { [key]: { code: 1, stdout: '', stderr: 'uninitialized constant' } }));
  assert.equal(byId(s.findings, 'migrations-unknown').level, LEVEL.WARN);
});

test('упавший ключевой сервис останавливает и называет его', async () => {
  const s = await runChecks(base({}, { 'gitlab-ctl status': { code: 0, stdout: ctlStatusDegraded } }));
  const f = byId(s.findings, 'services');
  assert.equal(f.level, LEVEL.CRITICAL);
  assert.match(f.params.missing, /sidekiq/);
});

test('нет gitlab-secrets.json — остановка: бэкап без него не восстановить', async () => {
  const s = await runChecks(base({}, { 'test -f /etc/gitlab/gitlab-secrets.json': { code: 1, stdout: '' } }));
  assert.equal(byId(s.findings, 'secrets').level, LEVEL.CRITICAL);
});

test('мало места — остановка с конкретными цифрами', async () => {
  const s = await runChecks(base({}, { 'df -B1 --output=source,size,avail,target /var/opt/gitlab /': { code: 0, stdout: dfTight } }));
  const f = byId(s.findings, 'disk');
  assert.equal(f.level, LEVEL.CRITICAL);
  assert.equal(f.params.need, 5);
  assert.ok(f.params.free < 5);
});

test('контейнер отвергается, а не притворяется Omnibus', async () => {
  const s = await runChecks(base({}, { 'test -f /.dockerenv': { code: 0, stdout: '' } }));
  assert.equal(byId(s.findings, 'omnibus-container').level, LEVEL.CRITICAL);
});

test('занятый apt останавливает, активный таймер — предупреждает', async () => {
  const busy = await runChecks(base({}, { 'fuser /var/lib/dpkg/lock-frontend': { code: 0, stdout: '1234' } }));
  assert.equal(byId(busy.findings, 'apt-busy').level, LEVEL.CRITICAL);
  const timer = await runChecks(base({}, { 'systemctl is-active apt-daily.timer': { code: 0, stdout: 'active\n' } }));
  assert.equal(byId(timer.findings, 'apt-timer').level, LEVEL.WARN);
});

test('старый PostgreSQL сверяется с конечной версией пути, а не со следующим шагом', async () => {
  const s = await runChecks(base({}, { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 12.14' } }), { depth: DEPTH.FULL });
  const f = byId(s.findings, 'postgres');
  assert.equal(f.level, LEVEL.CRITICAL);
  assert.equal(f.params.need, '14.14');
  assert.equal(f.params.target, '17.11.6-ee.0');
});

/**
 * Официальный минимум для GitLab 17 — 14.14, а не «14».
 * Округление до мажорной пропустило бы 14.2 как подходящую.
 */
test('минимум PostgreSQL сверяется с точностью до минорной версии', async () => {
  const low = await runChecks(base({}, { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 14.2' } }), { depth: DEPTH.FULL });
  assert.equal(byId(low.findings, 'postgres').level, LEVEL.CRITICAL, '14.2 ниже требуемых 14.14');
  const fine = await runChecks(base({}, { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 14.14' } }), { depth: DEPTH.FULL });
  assert.equal(byId(fine.findings, 'postgres').level, LEVEL.OK);
});

test('PostgreSQL выше протестированного максимума — предупреждение, а не остановка', async () => {
  const s = await runChecks(base({}, { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 17.2' } }), { depth: DEPTH.FULL });
  const f = byId(s.findings, 'postgres-above');
  assert.equal(f.level, LEVEL.WARN);
  assert.equal(f.params.max, '16');
});

test('потолок ОС предупреждает, а с --safe-for-os молчит', async () => {
  const focal = { id: 'ubuntu', versionId: '20.04', pretty: 'Ubuntu 20.04.6 LTS', supported: true };
  const warn = await runChecks(base({ os: focal }), { depth: DEPTH.FULL });
  assert.equal(byId(warn.findings, 'os-ceiling').level, LEVEL.WARN);
  const quiet = await runChecks(base({ os: focal, safeForOs: true }), { depth: DEPTH.FULL });
  assert.equal(byId(quiet.findings, 'os-ceiling').level, LEVEL.OK);
});

test('SSH без tmux предупреждает на длинном пути и молчит на патче', async () => {
  const long = await runChecks(base({ isTty: true, plan: { steps: [1, 2, 3] } }));
  assert.equal(byId(long.findings, 'session').level, LEVEL.WARN);
  const patch = await runChecks(base({ isTty: true, plan: { steps: [1] } }));
  assert.equal(byId(patch.findings, 'session').level, LEVEL.OK);
});

test('быстрый набор дешевле полного, но включает все критические проверки', async () => {
  const fast = CHECKS.filter((c) => c.depth === DEPTH.FAST).map((c) => c.id);
  for (const must of ['root', 'services', 'migrations', 'secrets', 'disk']) {
    assert.ok(fast.includes(must), `${must} обязана быть в быстром наборе`);
  }
  assert.ok(CHECKS.length > fast.length, 'полный набор должен быть шире быстрого');
});

test('у каждой находки есть текст в обеих локалях', async () => {
  const scenarios = [
    {}, { 'test -f /.dockerenv': { code: 0, stdout: '' } },
    { 'gitlab-ctl status': { code: 0, stdout: ctlStatusDegraded } },
    { 'test -f /etc/gitlab/gitlab-secrets.json': { code: 1, stdout: '' } },
    { 'df -B1 --output=source,size,avail,target /var/opt/gitlab /': { code: 0, stdout: dfTight } },
    { 'fuser /var/lib/dpkg/lock-frontend': { code: 0, stdout: '1' } },
    { 'systemctl is-active apt-daily.timer': { code: 0, stdout: 'active' } },
    { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 12.1' } },
    { 'gitlab-ctl status': { code: 1, stdout: '' } },
  ];
  for (const lang of Object.keys(LOCALES)) {
    const t = createTranslator(lang);
    for (const fx of scenarios) {
      const s = await runChecks(base({ isTty: true, uid: 1000 }, fx), { depth: DEPTH.FULL });
      for (const f of s.findings) {
        const key = `check.${f.id}.${f.level}`;
        assert.notEqual(t(key), key, `${lang}: нет текста для ${key}`);
        assert.notEqual(t(`check.${f.check}.title`), `check.${f.check}.title`, `${lang}: нет заголовка ${f.check}`);
      }
    }
  }
});

test('doctor на здоровом инстансе отвечает нулём, на больном — единицей', async () => {
  const ctx = (fx, os = osReleaseJammy) => ({
    exec: createExec({ mode: MODE.REPLAY, fixtures: { ...fixturesFor({ version: '17.11.4-ee.0' }), ...checkFixtures(), ...fx } }),
    t: createTranslator('ru'),
    flags: { from: null, to: null, targetMajor: null, safeForOs: false, patchOnly: false, force: false, minFreeGb: null },
    config: { proxy: null, minFreeGb: 5 },
    data, osPath: osPath(os), uid: 0, env: {}, isTty: false,
  });
  const good = await commandDoctor(ctx({}));
  assert.equal(good.code, EXIT.CURRENT);
  assert.equal(good.result.blocked, false);
  assert.match(good.lines.join('\n'), /Всё в порядке/);

  const bad = await commandDoctor(ctx({ 'test -f /etc/gitlab/gitlab-secrets.json': { code: 1, stdout: '' } }));
  assert.equal(bad.code, EXIT.ERROR);
  assert.equal(bad.errorCode, 'checks-failed');
  assert.equal(bad.result.blocked, true);
});

test('поля result doctor совпадают с реестром', async () => {
  const r = await commandDoctor({
    exec: createExec({ mode: MODE.REPLAY, fixtures: { ...fixturesFor({ version: '17.11.4-ee.0' }), ...checkFixtures() } }),
    t: createTranslator('ru'),
    flags: { from: null, to: null, targetMajor: null, safeForOs: false, patchOnly: false, force: false, minFreeGb: null },
    config: {}, data, osPath: osPath(osReleaseJammy), uid: 0, env: {}, isTty: false,
  });
  assert.deepEqual(Object.keys(r.result).sort(), Object.keys(COMMANDS.doctor.result).sort());
});

test('--force не поднимает выше потолка ОС', () => {
  // «Игнорировать предупреждения» и «поставить версию, для которой под эту
  // ОС нет пакетов» — про разное. Для агента --force читается как
  // «продолжить несмотря на шум», и это была бы самая дорогая опечатка.
  const summary = {
    ok: 5, warnings: 1, critical: 0,
    findings: [{ id: 'os-ceiling', check: 'os-ceiling', level: LEVEL.WARN, params: {} }],
  };
  assert.equal(gate(summary, {}).reason, 'os-ceiling-not-accepted');
  assert.equal(gate(summary, { force: true }).reason, 'os-ceiling-not-accepted');
  assert.equal(gate(summary, { allowUnsupportedOs: true }).ok, true);
});

test('--force по-прежнему снимает обычные предупреждения', () => {
  const summary = {
    ok: 5, warnings: 1, critical: 0,
    findings: [{ id: 'session', check: 'session', level: LEVEL.WARN, params: {} }],
  };
  assert.equal(gate(summary, {}).reason, 'warnings-not-accepted');
  assert.equal(gate(summary, { force: true }).ok, true);
});

test('критическое не снимается ничем', () => {
  const summary = {
    ok: 0, warnings: 0, critical: 1,
    findings: [{ id: 'migrations-failed', check: 'migrations', level: LEVEL.CRITICAL, params: { n: 1 } }],
  };
  for (const flags of [{}, { force: true }, { allowUnsupportedOs: true }, { force: true, allowUnsupportedOs: true }]) {
    assert.equal(gate(summary, flags).reason, 'checks-failed');
  }
});

test('незавершённые миграции при resume не требуют --force', () => {
  const summary = {
    ok: 5, warnings: 1, critical: 0,
    findings: [{ id: 'migrations-pending', check: 'migrations', level: LEVEL.WARN, params: { n: 3 } }],
  };
  assert.equal(gate(summary, {}).reason, 'warnings-not-accepted');
  assert.equal(gate(summary, {}, { resuming: true }).ok, true);
});

test('doctor и run выносят один вердикт', async () => {
  // Если doctor говорит «всё в порядке», а run отказывается, доверие к
  // doctor кончается на первом же таком случае.
  const summary = {
    ok: 5, warnings: 1, critical: 0,
    findings: [{ id: 'os-ceiling', check: 'os-ceiling', level: LEVEL.WARN, params: {} }],
  };
  assert.equal(gate(summary, { force: true }).verdict, 'doctor.osCeiling');
  assert.notEqual(gate(summary, { force: true }).verdict, 'doctor.clean');
});
