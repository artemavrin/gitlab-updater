import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExec, MODE, ExecError } from '../src/core/exec.js';
import { createTranslator } from '../src/i18n/index.js';
import { commandRun, commandResume } from '../src/commands/run.js';
import { detectGitlab } from '../src/detect/gitlab.js';
import { blockerLines } from '../src/render/findings.js';
import { settingsGrep } from '../src/detect/gitlabRb.js';
import { loadState, saveState, statePath } from '../src/core/state.js';
import { acquireLock } from '../src/core/lock.js';
import { EXIT } from '../src/plan/planner.js';
import { COMMANDS } from '../src/cli/registry.js';
import { MIGRATION_QUERY } from '../src/steps/settle.js';
import { skipList, MODE as BACKUP } from '../src/steps/backup.js';
import { fixturesFor, checkFixtures, ctlStatusHealthy, osReleaseJammy } from './fixtures/index.js';

const data = {
  upgradePath: JSON.parse(readFileSync('data/upgrade-path.json', 'utf8')),
  osMatrix: JSON.parse(readFileSync('data/os-matrix.json', 'utf8')),
  pgRequirements: JSON.parse(readFileSync('data/pg-requirements.json', 'utf8')),
  rbConflicts: JSON.parse(readFileSync('data/gitlab-rb-conflicts.json', 'utf8')),
};
const STAMP = '20260831-0900';

const tickingClock = () => {
  let t = 0;
  return { now: () => t, wait: async (ms) => { t += ms; } };
};
const RUNNER = `gitlab-rails runner -e production ${MIGRATION_QUERY}`;

function bed({ version = '17.11.4-ee.0', extra = {}, flags = {}, dpkgStatus = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glu-run-'));
  writeFileSync(join(dir, 'os-release'), osReleaseJammy);
  const calls = [];
  const fixtures = {
    ...fixturesFor({ version, ...(dpkgStatus ? { dpkgStatus } : {}) }), ...checkFixtures(),
    'apt-get update': { code: 0, stdout: '' },
    'gitlab-ctl status': { code: 0, stdout: ctlStatusHealthy },
    [RUNNER]: { code: 0, stdout: '0 0 batched' },
    'apt-mark hold gitlab-ee': { code: 0, stdout: '' },
    ...extra,
  };
  const base = createExec({ mode: MODE.REPLAY, fixtures });
  // Значение-массив отдаётся по одному ответу за вызов: так проверяется
  // разница между «сломано до старта» и «сломалось во время шага».
  const queues = new Map(Object.entries(fixtures)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => [k, [...v]]));
  const exec = async (argv, opts) => {
    const key = argv.join(' ');
    calls.push(key);
    if (queues.has(key)) {
      const q = queues.get(key);
      return q.length > 1 ? q.shift() : q[0];
    }
    // Явно заданная фикстура всегда побеждает заглушку.
    if (Object.hasOwn(fixtures, key)) return base(argv, opts);
    // Изменяющие команды шага не записаны в фикстуры: важен факт и порядок вызова.
    if (/^(mkdir|cp|chmod|apt-get install|apt-mark|grep|\/root\/)/.test(key)) return { code: 0, stdout: '' };
    if (key.startsWith('gitlab-backup')) {
      return { code: 0, stdout: 'Creating backup archive: 1756600000_2026_08_31_17.11.4_gitlab_backup.tar [DONE]' };
    }
    return base(argv, opts);
  };
  return {
    dir, calls,
    ctx: {
      exec, bus: null, t: createTranslator('ru'), data,
      osPath: join(dir, 'os-release'),
      config: { stateDir: dir, backupDir: join(dir, 'backups'), minFreeGb: 5, proxy: null },
      flags: {
        from: null, to: null, targetMajor: null, safeForOs: false, patchOnly: false,
        force: false, minFreeGb: null, yes: true, backupHook: null, ...flags,
      },
      uid: 0, env: {}, isTty: false,
      gitlabInfo: { package: 'gitlab-ee', edition: 'ee', aptVersion: version },
      stamp: () => STAMP,
      // Часы обязаны идти: замороженные превращают ожидание в вечный цикл.
      settle: { ...tickingClock(), intervalMs: 1_000, timeoutMs: 60_000 },
    },
  };
}

test('патч выполняется целиком: бэкап, установка, ожидание, закрепление', async () => {
  const { ctx, calls, dir } = bed();
  const r = await commandRun(ctx);
  assert.equal(r.code, EXIT.CURRENT, r.lines.join('\n'));
  assert.equal(r.result.target, '17.11.6-ee.0');

  const order = calls.filter((c) => /^(gitlab-backup|apt-get install|apt-mark)/.test(c));
  assert.match(order[0], /^apt-mark unhold/, 'без снятия hold установка упадёт уже после бэкапа');
  assert.match(order[1], /^gitlab-backup/, 'бэкап обязан быть до установки');
  assert.match(order[2], /gitlab-ee=17\.11\.6-ee\.0/);
  assert.match(order[3], /^apt-mark hold/);
  assert.equal(loadState(dir).state, null, 'состояние обязано очиститься после успеха');
});

test('патч бэкапит только базу и конфиги, а не 187 ГБ блобов', async () => {
  const { ctx, calls } = bed();
  await commandRun(ctx);
  const backup = calls.find((c) => c.startsWith('gitlab-backup'));
  assert.match(backup, /SKIP=/);
  for (const c of skipList(BACKUP.DB)) assert.ok(backup.includes(c), `${c} должен быть в SKIP`);
  assert.ok(!/STRATEGY=copy/.test(backup), 'полная стратегия для патча — восемьдесят минут впустую');
});

test('без --yes ничего не меняется', async () => {
  const { ctx, calls } = bed({ flags: { yes: false } });
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'confirmation-required');
  assert.ok(!calls.some((c) => /^(gitlab-backup|apt-get install)/.test(c)), 'выполнены изменяющие команды без --yes');
});

test('критическая проверка не пускает к установке', async () => {
  const { ctx, calls } = bed({ extra: { 'test -f /etc/gitlab/gitlab-secrets.json': { code: 1, stdout: '' } } });
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'checks-failed');
  assert.ok(!calls.some((c) => c.startsWith('apt-get install')));
});

test('предупреждения останавливают, пока не сказано --force', async () => {
  const warned = { 'systemctl is-active apt-daily.timer': { code: 0, stdout: 'active' } };
  const strict = bed({ extra: warned });
  assert.equal((await commandRun(strict.ctx)).errorCode, 'warnings-not-accepted');
  const forced = bed({ extra: warned, flags: { force: true } });
  assert.equal((await commandRun(forced.ctx)).code, EXIT.CURRENT);
});

/**
 * Упавшая миграция — единственная остановка, которую не снимает ничто:
 * следующий шаг мигрировал бы поверх незавершённых данных.
 */
test('упавшая миграция до старта не пускает к установке вовсе', async () => {
  const { ctx, calls } = bed({ extra: { [RUNNER]: { code: 0, stdout: '0 1 batched' } } });
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'checks-failed');
  assert.ok(!calls.some((c) => c.startsWith('apt-get install')), 'установка началась поверх упавшей миграции');
});

test('упавшая во время шага миграция останавливает и оставляет состояние для resume', async () => {
  // Перед стартом чисто, падение случается уже после установки.
  const { ctx, dir } = bed({ extra: { [RUNNER]: [{ code: 0, stdout: '0 0 batched' }, { code: 0, stdout: '3 1 batched' }] } });
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'migrations-failed');
  assert.match(r.lines.join('\n'), /ОСТАНОВЛЕНО/);
  const { state } = loadState(dir);
  assert.ok(state, 'состояние обязано остаться — иначе resume невозможен');
  assert.equal(state.phase, 'settle');
  assert.equal(state.expectedVersion, '17.11.6-ee.0');
});

test('не поднявшиеся после установки сервисы останавливают до следующего шага', async () => {
  const { ctx } = bed({
    version: '15.11.13-ee.0',
    extra: { 'gitlab-ctl status': [{ code: 0, stdout: ctlStatusHealthy }, { code: 1, stdout: '' }] },
    flags: { force: true },
  });
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'services-down');
});

test('второй экземпляр не запускается поверх первого', async () => {
  const { ctx, dir } = bed();
  // Родительский процесс жив на любой машине, в отличие от process.pid + 1:
  // на раннере CI такого pid нет, и замок справедливо признавался мёртвым.
  const held = acquireLock(join(dir, 'lock'), { pid: process.ppid });
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'already-running');
  held.release();
});

test('замок освобождается даже когда шаг упал', async () => {
  const { ctx, dir } = bed({ extra: { [RUNNER]: [{ code: 0, stdout: '0 0 batched' }, { code: 0, stdout: '0 2 batched' }] } });
  await commandRun(ctx);
  assert.equal(existsSync(join(dir, 'lock')), false, 'замок остался висеть после ошибки');
});

test('resume без сохранённого состояния не выдумывает работу', async () => {
  const { ctx } = bed();
  const r = await commandResume(ctx);
  assert.equal(r.errorCode, 'no-state');
});

/**
 * Между падением и resume сервер могли обновить руками — сохранённый план
 * тогда рассчитан не от той версии.
 */
test('resume отказывается продолжать при расхождении версии', async () => {
  const { ctx, dir } = bed({ version: '17.11.6-ee.0' });
  saveState(dir, {
    pkg: 'gitlab-ee', edition: 'ee', expectedVersion: '16.11.10-ee.0',
    steps: [{ version: '17.11.6-ee.0' }], stepIndex: 0, phase: 'settle', backups: [],
  });
  ctx.gitlabInfo = { package: 'gitlab-ee', edition: 'ee', aptVersion: '17.11.6-ee.0' };
  const r = await commandResume(ctx);
  assert.equal(r.errorCode, 'resume-version-mismatch');
  assert.match(r.lines.join('\n'), /plan --from/);
  assert.ok(existsSync(statePath(dir)), 'состояние нельзя удалять при расхождении');
});

test('resume продолжает с сохранённого шага, а не начинает заново', async () => {
  const { ctx, dir, calls } = bed({ version: '17.11.4-ee.0' });
  saveState(dir, {
    pkg: 'gitlab-ee', edition: 'ee', expectedVersion: '17.11.4-ee.0',
    from: '17.11.4-ee.0', target: '17.11.6-ee.0', profile: 'patch',
    steps: [{ version: '17.11.6-ee.0', reason: 'target' }],
    stepIndex: 0, phase: 'backup', backups: [],
  });
  const r = await commandResume(ctx);
  assert.equal(r.code, EXIT.CURRENT);
  assert.equal(calls.filter((c) => c.startsWith('apt-get install')).length, 1);
});

test('состояние пишется до каждой фазы, а не после шага', async () => {
  const phases = [];
  const { ctx, dir } = bed();
  const realExec = ctx.exec;
  ctx.exec = async (argv, opts) => {
    const s = loadState(dir).state;
    if (s) phases.push(`${argv[0]}:${s.phase}`);
    return realExec(argv, opts);
  };
  await commandRun(ctx);
  assert.ok(phases.includes('gitlab-backup:backup'), 'фаза backup не записана до бэкапа');
  assert.ok(phases.some((p) => p.startsWith('apt-get') && p.endsWith(':install')), 'фаза install не записана до установки');
});

/**
 * Проверки на каждое исправление после ревью — иначе дефект вернётся
 * при следующей правке, а обнаружится на боевом сервере.
 */

test('первый бэкап полный, последующие дешёвые: восемь полных — это восемь раз по 80 минут', async () => {
  const { ctx, calls } = bed({ version: '15.11.13-ee.0', flags: { force: true } });
  await commandRun(ctx);
  const backups = calls.filter((c) => c.startsWith('gitlab-backup'));
  assert.equal(backups.length, 8, 'ожидали по бэкапу на каждый шаг пути');
  assert.match(backups[0], /STRATEGY=copy/, 'первый обязан быть полным');
  for (const b of backups.slice(1)) {
    assert.ok(!/STRATEGY=copy/.test(b), `лишний полный бэкап: ${b}`);
    assert.ok(!b.includes('repositories'), 'быстрый бэкап сохраняет репозитории');
  }
});

test('снятие hold идёт до установки, возврат — после последнего шага', async () => {
  const { ctx, calls } = bed();
  await commandRun(ctx);
  const marks = calls.filter((c) => c.startsWith('apt-mark'));
  assert.deepEqual(marks, ['apt-mark unhold gitlab-ee', 'apt-mark hold gitlab-ee']);
});

test('бэкап сообщает каталог дампа отдельно от каталога конфигов', async () => {
  const { ctx } = bed();
  const r = await commandRun(ctx);
  const b = r.result.backups[0];
  assert.match(b.configDir, /backups\/20260831-0900$/);
  assert.equal(b.dumpDir, '/var/opt/gitlab/backups', 'дамп кладёт GitLab, а не мы');
  assert.match(b.archive, /_gitlab_backup\.tar$/);
});

/**
 * Нас убили после установки последнего шага: свежий план пуст, но миграции
 * ещё не дождались и пакет не закреплён. Выйти с «обновляться некуда» —
 * значит бросить инстанс в незавершённом состоянии.
 */
test('resume дожимает последний шаг, когда свежий план уже пуст', async () => {
  const { ctx, dir, calls } = bed({ version: '17.11.6-ee.0' });
  saveState(dir, {
    pkg: 'gitlab-ee', edition: 'ee', expectedVersion: '17.11.6-ee.0',
    from: '17.11.4-ee.0', target: '17.11.6-ee.0', profile: 'patch',
    steps: [{ version: '17.11.6-ee.0', reason: 'target' }],
    stepIndex: 0, phase: 'settle', backups: [],
  });
  const r = await commandResume(ctx);
  assert.equal(r.code, EXIT.CURRENT, r.lines.join('\n'));
  assert.ok(calls.some((c) => c === 'apt-mark hold gitlab-ee'), 'пакет остался незакреплённым');
  assert.equal(loadState(dir).state, null);
});

test('resume после падения в середине установки принимает обе версии', async () => {
  for (const onDisk of ['17.11.4-ee.0', '17.11.6-ee.0']) {
    const { ctx, dir } = bed({ version: onDisk });
    saveState(dir, {
      pkg: 'gitlab-ee', edition: 'ee',
      expectedVersion: '17.11.4-ee.0', installing: '17.11.6-ee.0',
      from: '17.11.4-ee.0', target: '17.11.6-ee.0', profile: 'patch',
      steps: [{ version: '17.11.6-ee.0', reason: 'target' }],
      stepIndex: 0, phase: 'install', backups: [],
    });
    const r = await commandResume(ctx);
    assert.notEqual(r.errorCode, 'resume-version-mismatch', `на диске ${onDisk}: resume отказал зря`);
  }
});

test('resume не требует --force из-за миграций, ради которых его и запускают', async () => {
  const { ctx, dir } = bed({ extra: { [RUNNER]: [{ code: 0, stdout: '4 0 batched' }, { code: 0, stdout: '0 0 batched' }] } });
  saveState(dir, {
    pkg: 'gitlab-ee', edition: 'ee', expectedVersion: '17.11.4-ee.0',
    from: '17.11.4-ee.0', target: '17.11.6-ee.0', profile: 'patch',
    steps: [{ version: '17.11.6-ee.0', reason: 'target' }],
    stepIndex: 0, phase: 'backup', backups: [],
  });
  const r = await commandResume(ctx);
  assert.notEqual(r.errorCode, 'warnings-not-accepted');
});

test('--dry-run не трогает состояние чужого прерванного запуска', async () => {
  const { ctx, dir, calls } = bed({ flags: { dryRun: true } });
  const foreign = {
    pkg: 'gitlab-ee', edition: 'ee', expectedVersion: '16.11.10-ee.0',
    steps: [{ version: '17.1.8-ee.0' }], stepIndex: 0, phase: 'settle', backups: [],
  };
  saveState(dir, foreign);
  await commandRun(ctx);
  const after = loadState(dir).state;
  assert.ok(after, 'состояние прерванного запуска стёрто в dry-run');
  assert.equal(after.expectedVersion, '16.11.10-ee.0');
});

/** Поставить gitlab-ee поверх CE — потеря инстанса. */
test('CE-инстанс не получает пакет EE', async () => {
  const { ctx, calls } = bed();
  ctx.gitlabInfo = { package: null, edition: 'ce', aptVersion: '17.11.4-ce.0' };
  await commandRun(ctx);
  const install = calls.find((c) => c.startsWith('apt-get install'));
  assert.match(install, /gitlab-ce=/, 'на CE поставили EE');
});

test('неопределимый пакет — отказ, а не установка наугад', async () => {
  const { ctx, calls } = bed();
  ctx.gitlabInfo = { package: null, edition: null, aptVersion: '17.11.4-ee.0' };
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'package-unknown');
  assert.ok(!calls.some((c) => c.startsWith('apt-get install')));
});

test('--dry-run не рапортует об успехе и не говорит, что пакет закреплён', async () => {
  const { ctx, calls } = bed({ flags: { dryRun: true, yes: false } });
  const r = await commandRun(ctx);
  const text = r.lines.join('\n');
  assert.match(text, /Ничего не изменено/);
  assert.ok(!/закреплён/.test(text), 'предпросмотр читается как завершённое обновление');
  assert.equal(r.result.steps, 0);
});

test('падение установки доносит подсказку про resume, а не теряется', async () => {
  const { ctx } = bed();
  const real = ctx.exec;
  ctx.exec = async (argv, opts) => {
    if (argv.join(' ').startsWith('apt-get install')) throw new Error('dpkg was interrupted');
    return real(argv, opts);
  };
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'step-failed');
  assert.match(r.lines.join('\n'), /resume --yes/);
  assert.match(r.lines.join('\n'), /dpkg was interrupted/);
});

test('итог называет каталог дампа из gitlab.rb, а не наш', async () => {
  const { ctx } = bed({ extra: { "grep -E ^\\s*gitlab_rails\\['backup_path'\\] /etc/gitlab/gitlab.rb": { code: 0, stdout: "gitlab_rails['backup_path'] = \"/mnt/nfs/gl\"" } } });
  const r = await commandRun(ctx);
  assert.match(r.lines.join('\n'), /\/mnt\/nfs\/gl/);
});

test('форма result соответствует объявленной в реестре и на пустом пути', async () => {
  const { ctx } = bed({ version: '17.11.6-ee.0' });
  const r = await commandRun(ctx);
  assert.deepEqual(Object.keys(r.result).sort(), Object.keys(COMMANDS.run.result).sort());
});

test('--dry-run работает без --yes: он ничего не меняет', async () => {
  const { ctx } = bed({ flags: { dryRun: true, yes: false } });
  const r = await commandRun(ctx);
  assert.notEqual(r.errorCode, 'confirmation-required');
  assert.equal(r.code, EXIT.CURRENT);
});

test('--dry-run не ждёт миграции по-настоящему', async () => {
  // Ожидание readOnly, значит dry-режим exec его не пропустил бы: без явной
  // ветки предпросмотр честно ждал бы до 72 часов.
  const { ctx, calls } = bed({ flags: { dryRun: true, yes: false }, extra: { [RUNNER]: { code: 0, stdout: '99 0 batched' } } });
  await commandRun(ctx);
  assert.ok(!calls.some((c) => c.startsWith('apt-mark hold')), 'закрепление в предпросмотре');
});

/**
 * Свежий план при resume может схлопнуться до «обновляться некуда», и тогда
 * политика дала бы backup: none — оставшиеся шаги встали бы без бэкапа.
 */
test('resume берёт режим бэкапа из сохранённого профиля, а не из свежего плана', async () => {
  const { ctx, dir, calls } = bed({ version: '17.11.6-ee.0' });
  saveState(dir, {
    pkg: 'gitlab-ee', edition: 'ee', expectedVersion: '17.11.6-ee.0',
    from: '15.11.13-ee.0', target: '17.11.6-ee.0', profile: 'long',
    steps: [{ version: '17.11.6-ee.0', reason: 'target' }],
    stepIndex: 0, phase: 'backup', backups: [],
  });
  await commandResume(ctx);
  assert.ok(calls.some((c) => c.startsWith('gitlab-backup')), 'шаг выполнен без бэкапа');
});

/**
 * Барьер PostgreSQL на длинном пути: проверка на старте к восьмому шагу
 * устаревает.
 *
 * Настоящий случай: 13.12.15 на PostgreSQL 12.6, девятнадцать шагов, барьер на
 * 16.3.9 (нужен 13.6). Проверки выполнялись один раз до цикла, поэтому с
 * --force apt получил бы 16.3 на PostgreSQL 12 посреди многочасового прогона.
 * А `gitlab-ctl pg-upgrade` заранее не помогает: на 13.12 он отвечает «12.6
 * уже стоит, делать нечего» — нужную версию приносит пакет по пути.
 */
test('подъём останавливается перед шагом, которому не хватает PostgreSQL', async () => {
  // Барьер должен стоять НЕ на первом шаге: на первом это критическая находка,
  // и до цикла дело не доходит. Здесь 15.4.6 → 15.11.13 → 16.3.9, и требование
  // 13.6 появляется только на втором шаге — ровно как у пути с 13.x.
  const { ctx, calls } = bed({
    version: '15.4.6-ee.0',
    flags: { force: true, to: '16.3.9-ee.0' },
    extra: { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 12.6' } },
  });
  const r = await commandRun(ctx);
  assert.equal(r.code, EXIT.ERROR, r.lines.join('\n'));
  assert.equal(r.errorCode, 'postgres-step');
  const text = r.lines.join('\n');
  assert.match(text, /16\.3\.9-ee\.0/);
  assert.match(text, /12\.6/);
  assert.match(text, /13\.6/);

  // Установка — это не `--download-only`: пакеты профиль long скачивает все
  // сразу, и заранее скачанный 16.3.9 ничего не меняет на сервере.
  const installed = calls.filter((c) => c.startsWith('apt-get install') && !c.includes('--download-only'));
  assert.ok(installed.some((c) => c.includes('gitlab-ee=15.11.13-ee.0')), installed.join('\n'));
  // А второй шаг не начинали: ни установки, ни бэкапа под него.
  assert.ok(!installed.some((c) => c.includes('gitlab-ee=16.3.9-ee.0')), installed.join('\n'));
  const backups = calls.filter((c) => c.startsWith('gitlab-backup')).length;
  assert.equal(backups, 1, 'бэкап под невыполнимый шаг — час впустую');
  // Состояние сохранено: после pg-upgrade продолжают через resume.
  assert.match(text, /resume/);
});

test('достаточная версия PostgreSQL шаг не задерживает', async () => {
  const { ctx, calls } = bed({
    version: '15.4.6-ee.0',
    flags: { force: true, to: '16.3.9-ee.0' },
    extra: { 'gitlab-psql --version': { code: 0, stdout: 'psql (PostgreSQL) 13.11' } },
  });
  const r = await commandRun(ctx);
  assert.equal(r.code, EXIT.CURRENT, r.lines.join('\n'));
  assert.ok(calls.some((c) => c.includes('gitlab-ee=16.3.9-ee.0')), calls.join('\n'));
});

test('неопределимая версия PostgreSQL не останавливает подъём', async () => {
  // Своим незнанием мешать апгрейду нельзя: нехватку заметит сам пакет.
  const { ctx } = bed({
    version: '15.4.6-ee.0',
    flags: { force: true, to: '16.3.9-ee.0' },
    extra: { 'gitlab-psql --version': { code: 1, stdout: '', stderr: 'нет такой команды' } },
  });
  const r = await commandRun(ctx);
  assert.equal(r.code, EXIT.CURRENT, r.lines.join('\n'));
});

/**
 * Настоящая остановка с боевой машины:
 *
 *   ОСТАНОВЛЕНО: шаг не выполнился — exec-failed code=100
 *   argv=apt-get -c /var/lib/gitlab-upgrade/apt-proxy.2130032.conf update
 *
 * В строке есть всё, кроме того единственного, ради чего в неё смотрят: что
 * ответил apt. Причина всё это время лежала в err.result.stderr, и её просто
 * не выводили — человек оставался с кодом 100 и без слова о том, что чинить.
 */
test('отказ шага показывает, что ответила команда, а не только её код', async () => {
  const { ctx } = bed();
  const real = ctx.exec;
  ctx.exec = async (argv, opts) => {
    if (argv.join(' ').startsWith('apt-get update')) {
      throw new ExecError('exec-failed', {
        code: 100,
        argv: 'apt-get -c /var/lib/gitlab-upgrade/apt-proxy.42.conf update',
        stdout: '',
        stderr: 'W: GPG error: https://packages.gitlab.com/… InRelease: NO_PUBKEY 3F01618A51312F3F\n'
          + "E: The repository 'https://packages.gitlab.com/… focal InRelease' is not signed.\n",
      });
    }
    return real(argv, opts);
  };
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'step-failed');
  const text = r.lines.join('\n');
  assert.match(text, /is not signed|NO_PUBKEY/, `причина обязана быть видна:\n${text}`);
  assert.match(text, /100/, 'код тоже нужен');
  assert.match(text, /resume --yes/);
});

test('пароль прокси не утекает из жалобы apt', async () => {
  // apt охотно печатает URL прокси целиком, а строка уходит на экран, в
  // журнал и в уведомление на телефон.
  const { ctx } = bed();
  const real = ctx.exec;
  ctx.exec = async (argv, opts) => {
    if (argv.join(' ').startsWith('apt-get update')) {
      throw new ExecError('exec-failed', {
        code: 100, argv: 'apt-get update', stdout: '',
        stderr: 'E: Failed to fetch via socks5h://svc:s3cret@10.0.0.5:1080 — 407\n',
      });
    }
    return real(argv, opts);
  };
  const r = await commandRun(ctx);
  const text = r.lines.join('\n');
  assert.ok(!text.includes('s3cret'), text);
  assert.match(text, /svc:\*\*\*@/);
});

/**
 * Настоящие остановки с боевой машины:
 *
 *   apt-get install … → 100: E: Sub-process /usr/bin/dpkg returned an error code (1)
 *   gitlab-backup create SKIP=… → 1: Backup::Error: gitaly-backup exit status 1
 *
 * Обе строки — итог, а не причина: настоящая ошибка на несколько строк выше и
 * до сих пор пропадала целиком. exec собирал вывод, отдавал одну строку на
 * экран и терял остальное — человек оставался с констатацией отказа и без
 * единой зацепки, посреди девятнадцатишагового подъёма.
 */
test('полный вывод упавшей команды сохраняется и называется', async () => {
  const { ctx, dir } = bed();
  const real = ctx.exec;
  ctx.exec = async (argv, opts) => {
    if (argv.join(' ').startsWith('gitlab-backup')) {
      throw new ExecError('exec-failed', {
        code: 1, argv: argv.join(' '),
        stdout: 'Dumping repositories ...\nERROR: repository /var/opt/gitlab/git-data/x.git is broken\n',
        stderr: 'Backup::Error: gitaly-backup exit status 1\n',
      });
    }
    return real(argv, opts);
  };
  ctx.config.logDir = dir;
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'step-failed');

  const text = r.lines.join('\n');
  const path = /(\S*failed-\S+\.log)/.exec(text)?.[1];
  assert.ok(path, `путь к выводу не назван:\n${text}`);
  const saved = readFileSync(path, 'utf8');
  // В файле обязана быть та строка, которой нет на экране.
  assert.match(saved, /repository .* is broken/);
  assert.match(saved, /gitaly-backup exit status 1/);
  assert.match(saved, /gitlab-backup create/);
});

test('в сохранённом выводе нет пароля прокси', async () => {
  // Туда попадает всё, что напечатала команда, — включая её аргументы и
  // жалобы на сеть. Файл потом целиком уходит в тикет.
  const { ctx, dir } = bed();
  const real = ctx.exec;
  ctx.exec = async (argv, opts) => {
    if (argv.join(' ').startsWith('gitlab-backup')) {
      throw new ExecError('exec-failed', {
        code: 1, argv: argv.join(' '), stdout: '',
        stderr: 'E: не дошло через socks5h://svc:s3cret@10.0.0.5:1080\n',
      });
    }
    return real(argv, opts);
  };
  ctx.config.logDir = dir;
  const r = await commandRun(ctx);
  const path = /(\S*failed-\S+\.log)/.exec(r.lines.join('\n'))?.[1];
  const saved = readFileSync(path, 'utf8');
  assert.ok(!saved.includes('s3cret'), saved);
  assert.match(saved, /svc:\*\*\*@/);
});

/**
 * Недонастроенный пакет.
 *
 * На живом сервере установка 15.11.13 упала на `Sub-process /usr/bin/dpkg
 * returned an error code (1)`: новый код распакован, `gitlab-ctl reconfigure`
 * с миграциями не отработал, схема осталась старой. `dpkg-query -W
 * -f=${Version}` при этом отвечал «15.11.13», инструмент считал шаг
 * выполненным, и `resume` пошёл делать бэкап — который упал на `relation
 * "design_management_repositories" does not exist`. То есть в момент, когда
 * бэкап был нужнее всего, его не сделали.
 *
 * gitlabInfo здесь берётся настоящим детектором, а не собирается руками:
 * проверка обязана ломаться вместе с детектором, а не переживать его.
 */
test('распакованный, но не настроенный пакет останавливает до бэкапа', async () => {
  const { ctx, calls } = bed({ dpkgStatus: 'install ok unpacked' });
  ctx.gitlabInfo = await detectGitlab(ctx.exec);
  assert.equal(ctx.gitlabInfo.installed, false);

  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'checks-failed', r.lines.join('\n'));
  assert.ok(!calls.some((c) => /^(gitlab-backup|apt-get install)/.test(c)),
    'поверх недоделанной установки выполнены изменяющие команды');
  // Починку человек видит блоком блокеров, который bin печатает по
  // result.findings, — там она и проверяется.
  const found = r.result.findings.find((f) => f.id === 'dpkg-broken');
  assert.deepEqual(found.remedy.argv, ['dpkg', '--configure', '-a']);
  const shown = blockerLines(r.result.findings, ctx.t).map((l) => l.text).join('\n');
  assert.match(shown, /dpkg --configure -a/, 'человеку не сказано, чем это чинится');
});

test('resume тоже не идёт поверх недоделанной установки', async () => {
  // Ровно тот путь, которым и прошло падение: `run` упал на установке,
  // человек запускает `resume`, а первый же шаг resume — бэкап.
  const { ctx, dir, calls } = bed({ version: '17.11.4-ee.0', dpkgStatus: 'install ok half-configured' });
  ctx.gitlabInfo = await detectGitlab(ctx.exec);
  saveState(dir, {
    pkg: 'gitlab-ee', edition: 'ee', expectedVersion: '17.11.4-ee.0',
    from: '17.11.4-ee.0', target: '17.11.6-ee.0', profile: 'patch',
    steps: [{ version: '17.11.6-ee.0', reason: 'target' }],
    stepIndex: 0, phase: 'backup', backups: [],
  });
  const r = await commandResume(ctx);
  assert.equal(r.errorCode, 'checks-failed', r.lines.join('\n'));
  assert.ok(!calls.some((c) => c.startsWith('gitlab-backup')), 'бэкап новым кодом по старой схеме');
});

test('исправный пакет проверку не задевает', async () => {
  // Обратная сторона: проверка, которая останавливает здоровый сервер, хуже
  // отсутствующей — её снимут вместе со всеми остальными через --force.
  const { ctx } = bed();
  ctx.gitlabInfo = await detectGitlab(ctx.exec);
  assert.equal(ctx.gitlabInfo.installed, true);
  assert.equal((await commandRun(ctx)).code, EXIT.CURRENT);
});

test('--force не снимает недоделанную установку', async () => {
  // Это не «шум, который можно проигнорировать»: продолжение отсюда ведёт к
  // бэкапу, которого не будет.
  const { ctx, calls } = bed({ dpkgStatus: 'install ok unpacked', flags: { force: true } });
  ctx.gitlabInfo = await detectGitlab(ctx.exec);
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'checks-failed');
  assert.ok(!calls.some((c) => /^(gitlab-backup|apt-get install)/.test(c)));
});

/**
 * Несовместимая настройка gitlab.rb на пути.
 *
 * Тот же живой случай с другой стороны: шаг 7 из 19 упал не в apt, а внутри
 * reconfigure — `smtp_tls` и `smtp_enable_starttls_auto` включены оба, и с
 * 15.11.4 это отвергается. Настройка лежит в файле, версия запрета известна:
 * узнать об этом можно было до первого бэкапа.
 */
test('несовместимая настройка gitlab.rb останавливает до старта', async () => {
  const both = [
    "gitlab_rails['smtp_enable'] = true",
    "gitlab_rails['smtp_tls'] = true",
    "gitlab_rails['smtp_enable_starttls_auto'] = true",
  ].join('\n');
  const keys = [...new Set(data.rbConflicts.rules.flatMap((r) => r.all_true))];
  const { ctx, calls } = bed({
    version: '15.11.4-ee.0',
    extra: { [settingsGrep(keys).join(' ')]: { code: 0, stdout: both } },
  });
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'checks-failed', r.lines.join('\n'));
  assert.ok(!calls.some((c) => /^(gitlab-backup|apt-get install)/.test(c)), 'начали подъём, который оборвётся внутри reconfigure');

  const found = r.result.findings.find((f) => f.id === 'rb-smtp-tls-starttls');
  assert.ok(found, JSON.stringify(r.result.findings.map((f) => f.id)));
  assert.equal(found.params.since, '15.11.4');
  // Человеку названы обе половины: что выключить и по какому признаку выбрать.
  const shown = blockerLines(r.result.findings, ctx.t).map((l) => l.text).join('\n');
  assert.match(shown, /465/);
  assert.match(shown, /587/);
  assert.match(shown, /docs\.gitlab\.com/);
});

test('нечитаемый gitlab.rb — предупреждение, а не запрет', async () => {
  // Отсутствие ответа не приговор: объявить сервер сломанным из-за того, что
  // мы чего-то не прочитали, хуже, чем сказать об этом вслух. Но и молчать
  // нельзя — непроверенное не то же самое, что проверенное.
  const keys = [...new Set(data.rbConflicts.rules.flatMap((r) => r.all_true))];
  const unreadable = { [settingsGrep(keys).join(' ')]: { code: 2, stdout: '' } };

  const { ctx } = bed({ extra: unreadable });
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'warnings-not-accepted', r.lines.join('\n'));
  assert.ok(r.result.findings.some((f) => f.id === 'gitlab-rb-unreadable' && f.level === 'warn'));

  // И --force его снимает — в отличие от самого конфликта.
  const forced = bed({ extra: unreadable, flags: { force: true } });
  assert.equal((await commandRun(forced.ctx)).code, EXIT.CURRENT);
});

test('--force не снимает несовместимую настройку gitlab.rb', async () => {
  // Это не шум: продолжение отсюда обрывается внутри reconfigure, уже после
  // установки пакета, и оставляет его ненастроенным.
  const both = [
    "gitlab_rails['smtp_enable'] = true",
    "gitlab_rails['smtp_tls'] = true",
    "gitlab_rails['smtp_enable_starttls_auto'] = true",
  ].join('\n');
  const keys = [...new Set(data.rbConflicts.rules.flatMap((r) => r.all_true))];
  const { ctx, calls } = bed({
    version: '15.11.4-ee.0', flags: { force: true },
    extra: { [settingsGrep(keys).join(' ')]: { code: 0, stdout: both } },
  });
  const r = await commandRun(ctx);
  assert.equal(r.errorCode, 'checks-failed');
  assert.ok(!calls.some((c) => /^(gitlab-backup|apt-get install)/.test(c)));
});
