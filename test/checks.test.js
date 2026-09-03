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
import { parseVersion } from '../src/plan/version.js';
import { FAILED_MIGRATION_QUERY } from '../src/steps/settle.js';
import { checkFixtures, fixturesFor, ctlStatusDegraded, dfTight, osReleaseJammy, osReleaseFocal } from './fixtures/index.js';

const data = {
  upgradePath: JSON.parse(readFileSync('data/upgrade-path.json', 'utf8')),
  osMatrix: JSON.parse(readFileSync('data/os-matrix.json', 'utf8')),
  pgRequirements: JSON.parse(readFileSync('data/pg-requirements.json', 'utf8')),
  rbConflicts: JSON.parse(readFileSync('data/gitlab-rb-conflicts.json', 'utf8')),
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
  // Иначе результат зависел бы от того, запущены ли сами тесты в tmux.
  inTmux: () => false,
  minFreeGb: 5,
  safeForOs: false,
  data,
  os: { id: 'ubuntu', versionId: '22.04', codename: 'jammy', pretty: 'Ubuntu 22.04.4 LTS', supported: true },
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

/** Внешняя база: строка postgresql['enable'] = false в gitlab.rb. */
const EXTERNAL_PG = { "grep -E ^\\s*postgresql\\['enable'\\] /etc/gitlab/gitlab.rb": { code: 0, stdout: "postgresql['enable'] = false\n" } };
const pgVersion = (v) => ({ 'gitlab-psql --version': { code: 0, stdout: `psql (PostgreSQL) ${v}` } });

test('старый PostgreSQL сверяется с конечной версией пути, а не со следующим шагом', async () => {
  const s = await runChecks(base({}, pgVersion('12.14')), { depth: DEPTH.FULL });
  const f = byId(s.findings, 'postgres');
  assert.equal(f.level, LEVEL.CRITICAL);
  // Встроенная база: барьер — мажорная из кода GitLab, а не число из таблицы
  // требований к внешней БД.
  assert.equal(f.params.need, '14');
  assert.equal(f.params.target, '17.11.6-ee.0');
});

/**
 * Минимум у встроенной и внешней базы разный, и путать их дорого.
 *
 * Живой случай: на 17.1.8 подъём встал на PostgreSQL 14.11 с требованием
 * 14.14. 14.14 — настоящее число из таблицы требований, но таблица написана
 * про внешний PostgreSQL, а пакет omnibus 17.1.8 несёт ровно 14.11
 * (config/software/postgresql.rb, default_version). То есть встроенной базе
 * взять 14.14 неоткуда, и остановка была вечной: сам же инструмент поставил
 * эту 14.11 шагом раньше.
 */
test('встроенной базе хватает мажорной из кода GitLab', async () => {
  // Ровно та версия, что встала колом на живом сервере.
  const s = await runChecks(base({}, pgVersion('14.11')), { depth: DEPTH.FULL });
  assert.equal(byId(s.findings, 'postgres').level, LEVEL.OK, 'пакет 17.1.8 сам несёт 14.11 — требовать больше нечего');

  const low = await runChecks(base({}, pgVersion('13.14')), { depth: DEPTH.FULL });
  assert.equal(byId(low.findings, 'postgres').level, LEVEL.CRITICAL, 'мажорная 13 для GitLab 17 действительно не годится');
  assert.equal(byId(low.findings, 'postgres').params.need, '14');
});

test('внешней базе требование остаётся точным до минорной', async () => {
  // Здесь таблица требований применима, и округление до мажорной пропустило
  // бы 14.2 как подходящую.
  const low = await runChecks(base({}, { ...pgVersion('14.2'), ...EXTERNAL_PG }), { depth: DEPTH.FULL });
  const f = byId(low.findings, 'postgres-external');
  assert.equal(f.level, LEVEL.CRITICAL, '14.2 ниже требуемых 14.14');
  assert.equal(f.params.need, '14.14');

  const fine = await runChecks(base({}, { ...pgVersion('14.14'), ...EXTERNAL_PG }), { depth: DEPTH.FULL });
  assert.equal(byId(fine.findings, 'postgres').level, LEVEL.OK);
});

/**
 * Имя упавшей миграции в самой находке.
 *
 * Живой случай на 18.2.8: находка сказала «упавших 1» и всё. Дорога от неё до
 * причины — три захода (rake status, запрос в журнал переходов, чтение
 * исходников GitLab), из которых два инструмент делает сам.
 */
test('упавшая миграция называется по имени, а не только числом', async () => {
  const counts = Object.keys(checkFixtures()).find((k) => k.startsWith('gitlab-rails'));
  const s = await runChecks(base({}, {
    [counts]: { code: 0, stdout: '0 1 batched' },
    [`gitlab-rails runner -e production ${FAILED_MIGRATION_QUERY}`]: {
      code: 0, stdout: 'BackfillSentNotificationsAfterPartition (PG::CheckViolation)\n',
    },
  }));
  const f = byId(s.findings, 'migrations-failed-named');
  assert.ok(f, JSON.stringify(s.findings.map((x) => x.id)));
  assert.equal(f.level, LEVEL.CRITICAL);
  assert.match(f.params.detail, /BackfillSentNotificationsAfterPartition/);
  assert.match(f.params.detail, /PG::CheckViolation/);
  // И починка на месте: находка с новым id не должна её потерять.
  assert.ok(f.remedy, 'у критической находки обязана быть починка');
});

/**
 * Починка выбирается по версии — а версия в ctx лежит РАЗОБРАННЫМ объектом.
 *
 * parseVersion принимает строку и делает String(input): на объекте это
 * «[object Object]», и выбор молча сваливался в самый общий вариант. То есть
 * на любом инстансе с определённой версией человек получал ссылку на
 * документацию вместо готовой команды. Ровно это и увидел живой сервер на
 * 18.2.8.
 */
test('версия из ctx доезжает до выбора починки', async () => {
  const counts = Object.keys(checkFixtures()).find((k) => k.startsWith('gitlab-rails'));
  const s = await runChecks(base({
    // Та же форма, что кладёт detectGitlab: объект, а не строка.
    gitlabInfo: { version: parseVersion('18.2.8-ee.0'), aptVersion: '18.2.8-ee.0', package: 'gitlab-ee' },
  }, { [counts]: { code: 0, stdout: '0 0 batched' }, ...pgVersion('16.8') }));
  const f = byId(s.findings, 'migrations');
  assert.equal(f.level, LEVEL.OK, 'подготовка теста: миграции должны быть в порядке');

  // Сама проверка — на находке, у которой починка зависит от версии.
  const pending = await runChecks(base({
    gitlabInfo: { version: parseVersion('18.2.8-ee.0'), aptVersion: '18.2.8-ee.0', package: 'gitlab-ee' },
  }, { [counts]: { code: 0, stdout: '3 0 batched' } }));
  const warn = byId(pending.findings, 'migrations-pending');
  assert.deepEqual(warn.remedy.argv, ['gitlab-rake', 'gitlab:background_migrations:status'],
    'на 18.2.8 команда есть, и она обязана быть названа');
});

test('без имени остаётся прежняя находка, а не пустые скобки', async () => {
  const counts = Object.keys(checkFixtures()).find((k) => k.startsWith('gitlab-rails'));
  const s = await runChecks(base({}, {
    [counts]: { code: 0, stdout: '0 1 batched' },
    [`gitlab-rails runner -e production ${FAILED_MIGRATION_QUERY}`]: { code: 1, stdout: '' },
  }));
  assert.equal(byId(s.findings, 'migrations-failed').level, LEVEL.CRITICAL);
  assert.equal(byId(s.findings, 'migrations-failed-named'), undefined);
});

test('PostgreSQL выше протестированного максимума — предупреждение, а не остановка', async () => {
  const s = await runChecks(base({}, { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 17.2' } }), { depth: DEPTH.FULL });
  const f = byId(s.findings, 'postgres-above');
  assert.equal(f.level, LEVEL.WARN);
  assert.equal(f.params.max, '16');
});

/**
 * Репозиторий против ОС.
 *
 * После апгрейда дистрибутива строка в sources.list остаётся от прежнего
 * выпуска, и дальше всё тихо: apt ставит пакеты под старую glibc, потолок
 * версий не двигается — то есть ради чего ОС обновляли, не случается, — а
 * план считается по НОВОЙ ОС и обрывается посреди подъёма, когда нужной
 * версии в старом репозитории нет.
 */
const FOCAL_MADISON = `
   gitlab-ee | 18.11.11-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu focal/main amd64 Packages
   gitlab-ee | 18.2.8-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu focal/main amd64 Packages
`;

test('репозиторий от прежнего выпуска ОС — предупреждение', async () => {
  const s = await runChecks(base({
    gitlabInfo: { package: 'gitlab-ee', aptVersion: '18.2.8-ee.0' },
  }, { 'apt-cache madison gitlab-ee': { code: 0, stdout: FOCAL_MADISON } }), { depth: DEPTH.FULL });
  const f = byId(s.findings, 'apt-suite');
  assert.equal(f.level, LEVEL.WARN, JSON.stringify(f));
  assert.equal(f.params.suite, 'focal');
  assert.equal(f.params.os, 'jammy');
  assert.ok(f.remedy, 'без починки это просто тревога');
});

test('совпавший выпуск проверку не трогает', async () => {
  // Фикстура madison — с jammy, как и ОС в base().
  const s = await runChecks(base({
    gitlabInfo: { package: 'gitlab-ee', aptVersion: '18.2.8-ee.0' },
  }), { depth: DEPTH.FULL });
  assert.equal(byId(s.findings, 'apt-suite').level, LEVEL.OK);
});

test('лишний старый репозиторий рядом с нужным не считается ошибкой', async () => {
  // Репозиториев может быть несколько, и apt возьмёт подходящий.
  const both = FOCAL_MADISON + '   gitlab-ee | 18.11.11-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages\n';
  const s = await runChecks(base({
    gitlabInfo: { package: 'gitlab-ee', aptVersion: '18.2.8-ee.0' },
  }, { 'apt-cache madison gitlab-ee': { code: 0, stdout: both } }), { depth: DEPTH.FULL });
  assert.equal(byId(s.findings, 'apt-suite').level, LEVEL.OK);
});

test('без кодового имени ОС сверять нечего, и мы молчим', async () => {
  // Дистрибутив без VERSION_CODENAME: выдумать выпуск здесь нельзя.
  const s = await runChecks(base({
    os: { id: 'ubuntu', versionId: '22.04', codename: null, pretty: 'Ubuntu', supported: true },
    gitlabInfo: { package: 'gitlab-ee', aptVersion: '18.2.8-ee.0' },
  }, { 'apt-cache madison gitlab-ee': { code: 0, stdout: FOCAL_MADISON } }), { depth: DEPTH.FULL });
  assert.equal(byId(s.findings, 'apt-suite-unknown').level, LEVEL.OK);
  assert.equal(byId(s.findings, 'apt-suite'), undefined);
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
  // Барьер — 16.11: это первый шаг, где начинается таблица требований.
  // Число — мажорная из кода GitLab (MINIMUM_POSTGRES_VERSION = 13 в 16.0):
  // база встроенная, и документированные для внешней 13.6 к ней не применимы.
  assert.equal(f.params.target, '16.11.10-ee.0');
  assert.equal(f.params.need, '13');
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
  assert.equal(f.params.need, '14');
});

test('версия, которую принёс сам пакет, барьером не становится', async () => {
  // 17.1.8 несёт PostgreSQL 14.11. Если требовать с него 14.14, подъём встаёт
  // навсегда: следующую версию базы приносит следующий пакет, а поставить его
  // мешает этот же барьер. Ровно так и случилось на живом сервере.
  const ctx = base({
    plan: {
      steps: [{ raw: '17.1.8-ee.0' }, { raw: '17.11.7-ee.0' }],
      target: { major: 17, minor: 11, patch: 7, raw: '17.11.7-ee.0' },
    },
  }, pgVersion('14.11'));
  const s = await runChecks(ctx, { depth: DEPTH.FULL });
  assert.equal(byId(s.findings, 'postgres').level, LEVEL.OK, JSON.stringify(byId(s.findings, 'postgres')));
});

/**
 * Отложенный барьер PostgreSQL не должен требовать --force.
 *
 * Находка сама говорит «подъём можно начинать сейчас», а ворота отвечали
 * «нельзя без --force» — противоречие, которое человек разрешает единственным
 * доступным способом: привыкает писать --force. А он гасит и всё остальное,
 * включая предупреждения на следующем resume.
 *
 * Безопасно это потому, что run проверяет барьер перед каждым шагом и
 * останавливается сам. Барьер на первом шаге — critical, и его --force не
 * снимает.
 */
test('отложенный барьер PostgreSQL не требует --force, а первый шаг требует', () => {
  const summary = (findings) => ({
    findings,
    critical: findings.filter((f) => f.level === LEVEL.CRITICAL).length,
    warnings: findings.filter((f) => f.level === LEVEL.WARN).length,
  });
  const deferred = { id: 'postgres', level: LEVEL.WARN, params: { step: 8 } };
  const external = { id: 'postgres-external', level: LEVEL.WARN, params: { step: 8 } };
  const blocking = { id: 'postgres', level: LEVEL.CRITICAL, params: { step: 1 } };
  const timer = { id: 'apt-timer', level: LEVEL.WARN, params: {} };

  assert.equal(gate(summary([deferred]), {}).ok, true, 'старт не должен требовать флага');
  assert.equal(gate(summary([external]), {}).ok, true);
  // Критический барьер — стоп, и --force его не снимает.
  assert.equal(gate(summary([blocking]), { force: true }).ok, false);
  // Прочие предупреждения по-прежнему требуют осознанного --force.
  assert.equal(gate(summary([deferred, timer]), {}).ok, false, 'таймер apt сам собой не прощается');
  assert.equal(gate(summary([deferred, timer]), { force: true }).ok, true);
});

test('занятость apt ловится по той блокировке, которую берёт update', async () => {
  // Проверка смотрела только dpkg-блокировку и отвечала «свободен», пока рядом
  // шёл apt-get update — а он валит наш кодом 100. Проверено на живом apt:
  // fuser на /var/lib/apt/lists/lock возвращает 0, на dpkg-блокировке — 1.
  const busy = await runChecks(base({}, {
    'fuser /var/lib/apt/lists/lock': { code: 0, stdout: '11507\n' },
  }));
  const f = byId(busy.findings, 'apt-busy');
  assert.equal(f.level, LEVEL.CRITICAL);
  // Кто именно держит — половина ответа: иначе искать процесс руками.
  assert.equal(f.params.pid, '11507');
  assert.match(f.params.path, /lists\/lock/);
});
