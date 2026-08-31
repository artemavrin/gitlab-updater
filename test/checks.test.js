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
  const s = await runChecks(base({}, { [Object.keys(checkFixtures()).find((k) => k.startsWith('gitlab-rails'))]: { code: 0, stdout: '0 1 batched' } }));
  const f = byId(s.findings, 'migrations-failed');
  assert.equal(f.level, LEVEL.CRITICAL);
  assert.equal(f.params.n, 1);
  assert.ok(blocked(s), 'critical обязан блокировать независимо от --force');
});

test('незавершённые миграции — предупреждение, а не остановка', async () => {
  const key = Object.keys(checkFixtures()).find((k) => k.startsWith('gitlab-rails'));
  const s = await runChecks(base({}, { [key]: { code: 0, stdout: '7 0 batched' } }));
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
  // 18.04, а не 20.04: для focal опубликовано до 18.11, и цель 17.11 в него
  // помещается. Тест на потолке обязан брать ОС, у которой потолок режет.
  const bionic = { id: 'ubuntu', versionId: '18.04', pretty: 'Ubuntu 18.04.6 LTS', supported: true };
  const warn = await runChecks(base({ os: bionic }), { depth: DEPTH.FULL });
  assert.equal(byId(warn.findings, 'os-ceiling').level, LEVEL.WARN);
  const quiet = await runChecks(base({ os: bionic, safeForOs: true }), { depth: DEPTH.FULL });
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

test('контейнер отвергается, а поблажка стенда остаётся предупреждением', async () => {
  const fixtures = {
    ...checkFixtures(),
    'test -d /opt/gitlab/embedded': { code: 0, stdout: '' },
    'test -f /.dockerenv': { code: 0, stdout: '' },
  };
  const inContainer = (env) => runChecks({
    exec: createExec({ mode: MODE.REPLAY, fixtures }),
    env, uid: 0, isTty: false, minFreeGb: 5, data,
    os: { id: 'ubuntu', versionId: '22.04', pretty: 'Ubuntu 22.04' },
  }, { depth: DEPTH.FAST });

  const strict = await inContainer({});
  const found = strict.findings.find((f) => f.check === 'omnibus');
  assert.equal(found.id, 'omnibus-container');
  assert.equal(found.level, LEVEL.CRITICAL);

  const waived = await inContainer({ GITLAB_UPGRADE_ALLOW_CONTAINER: '1' });
  const wf = waived.findings.find((f) => f.check === 'omnibus');
  // Снятая проверка не становится «ок»: иначе репетиционная поблажка
  // однажды уехала бы в продакшен молча.
  assert.equal(wf.id, 'omnibus-container-allowed');
  assert.equal(wf.level, LEVEL.WARN);
  assert.equal(blocked(waived), false);
  // И всё равно требует явного --force, а не проходит сама собой.
  assert.equal(gate(waived, {}).reason, 'warnings-not-accepted');
});

const PG_RB = "grep -E ^\\s*postgresql\\['enable'\\] /etc/gitlab/gitlab.rb";

test('внешняя БД не получает совет gitlab-ctl pg-upgrade', async () => {
  // Для внешней команда неприменима, а на Patroni/HA запрещена
  // документацией: совет, который выглядит authoritative и ничего не
  // делает, хуже отсутствия совета.
  const s = await runChecks(base({}, {
    'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 13.11' },
    [PG_RB]: { code: 0, stdout: "postgresql['enable'] = false" },
  }), { depth: DEPTH.FULL });
  const f = s.findings.find((x) => x.check === 'postgres');
  assert.equal(f.id, 'postgres-external');
  assert.equal(f.level, LEVEL.CRITICAL);
  assert.equal(f.remedy.argv, null, 'команды тут быть не должно');
  assert.match(f.remedy.docs, /external_upgrade/);
});

test('встроенная БД получает pg-upgrade', async () => {
  const s = await runChecks(base({}, {
    'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 13.11' },
  }), { depth: DEPTH.FULL });
  const f = s.findings.find((x) => x.check === 'postgres');
  assert.equal(f.id, 'postgres');
  assert.deepEqual(f.remedy.argv, ['gitlab-ctl', 'pg-upgrade']);
});

test('нечитаемый gitlab.rb не выдаётся за встроенную БД', async () => {
  // Под обычным пользователем gitlab.rb не прочитать — но и врать про
  // встроенную нельзя: решает второй признак, служба в gitlab-ctl.
  const { detectPostgres } = await import('../src/detect/services.js');
  const exec = createExec({
    mode: MODE.REPLAY,
    fixtures: { ...checkFixtures(), [PG_RB]: { code: 2, stdout: '' }, 'gitlab-ctl status': { code: 1, stdout: '' } },
  });
  const where = await detectPostgres(exec);
  assert.equal(where.bundled, null, 'неизвестность — это null, а не «встроенная»');
});

/**
 * Настоящий инстанс: 13.12.15 на PostgreSQL 12.6, путь в девятнадцать шагов.
 *
 * Требование конечной 18.11 — PostgreSQL 16.5, и по нему проверка выдавала
 * критическую находку, то есть запрещала подъём целиком. Это неверно дважды:
 * первые десять шагов на PostgreSQL 12 проходятся штатно, а `pg-upgrade` на
 * 13.12 не даёт 16.5 ни при каких условиях — нужные версии приносят сами
 * пакеты по пути. Барьер надо называть там, где он стоит.
 */
const LONG_ROUTE = ['14.0.12-ee.0', '14.10.5-ee.0', '15.11.13-ee.0', '16.11.10-ee.0',
  '17.1.8-ee.0', '17.11.7-ee.0', '18.11.11-ee.0'];

test('на длинном пути PostgreSQL сверяется с шагом, а не только с концом', async () => {
  const ctx = base({
    plan: {
      steps: LONG_ROUTE.map((raw) => ({ raw })),
      target: { major: 18, minor: 11, patch: 11, raw: '18.11.11-ee.0' },
    },
  }, { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 12.6' } });
  const f = byId((await runChecks(ctx, { depth: DEPTH.FULL })).findings, 'postgres');

  // Предупреждение, а не стоп: подъём можно начинать сегодня.
  assert.equal(f.level, LEVEL.WARN);
  // Барьер — 16.11: это первый шаг, где начинается таблица требований (13.6).
  assert.equal(f.params.target, '16.11.10-ee.0');
  assert.equal(f.params.need, '13.6');
  assert.equal(f.params.step, 4);
  // И у предупреждения обязана быть починка: без неё это просто тревога.
  assert.ok(f.remedy, 'починка нужна и для отложенного барьера');
});

test('барьер на первом же шаге остаётся стопом', async () => {
  // Здесь пакет действительно не установится, и начинать нечего.
  const ctx = base({
    plan: {
      steps: [{ raw: '17.1.8-ee.0' }, { raw: '17.11.7-ee.0' }],
      target: { major: 17, minor: 11, patch: 7, raw: '17.11.7-ee.0' },
    },
  }, { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 13.6' } });
  const f = byId((await runChecks(ctx, { depth: DEPTH.FULL })).findings, 'postgres');
  assert.equal(f.level, LEVEL.CRITICAL);
  assert.equal(f.params.step, 1);
  assert.equal(f.params.need, '14.14');
});
