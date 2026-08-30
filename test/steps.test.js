import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExec, MODE } from '../src/core/exec.js';
import { skipList, backupArgv, runBackup, COMPONENTS, MODE as BACKUP, CONFIG_FILES, DEFAULT_DUMP_DIR, parseArchive } from '../src/steps/backup.js';
import { installArgv, downloadArgv, holdArgv, unholdArgv } from '../src/steps/install.js';
import { waitServices, waitMigrations, MigrationsFailed, rateOf, etaMinutes, MIGRATION_QUERY } from '../src/steps/settle.js';
import { ctlStatusHealthy, ctlStatusDegraded } from './fixtures/index.js';

/**
 * Инвариант, который нельзя нарушить ни в одном режиме: бэкап без базы
 * перед апгрейдом бесполезен, а обнаруживается это при восстановлении.
 */
test('база не попадает в SKIP ни в одном режиме', () => {
  for (const mode of [BACKUP.DB, BACKUP.FAST, BACKUP.FULL]) {
    assert.ok(!skipList(mode).includes('db'), `${mode} пытается пропустить базу`);
    assert.ok(!backupArgv(mode).join(' ').match(/SKIP=[^ ]*\bdb\b/), `${mode}: db в SKIP`);
  }
});

test('режим db оставляет только базу, fast добавляет репозитории', () => {
  assert.deepEqual(skipList(BACKUP.DB).sort(), COMPONENTS.filter((c) => c !== 'db').sort());
  const fast = skipList(BACKUP.FAST);
  assert.ok(!fast.includes('repositories'));
  assert.ok(fast.includes('registry') && fast.includes('artifacts'));
});

test('полный бэкап ничего не пропускает и использует STRATEGY=copy', () => {
  assert.deepEqual(skipList(BACKUP.FULL), []);
  const argv = backupArgv(BACKUP.FULL);
  assert.ok(argv.includes('STRATEGY=copy'));
  assert.ok(!argv.some((a) => a.startsWith('SKIP=')));
});

test('неизвестный режим бэкапа — ошибка, а не тихий полный', () => {
  assert.throws(() => skipList('быстренько'), /unknown backup mode/);
});

test('бэкап копирует конфиги: без gitlab-secrets.json дамп не восстановить', async () => {
  const calls = [];
  const exec = async (argv) => { calls.push(argv.join(' ')); return { code: 0, stdout: '' }; };
  const r = await runBackup({ exec, mode: BACKUP.DB, backupDir: '/mnt/b', stamp: '20260831-0900' });
  assert.equal(r.configDir, '/mnt/b/20260831-0900');
  for (const file of CONFIG_FILES) {
    assert.ok(calls.some((c) => c.includes(`cp -a ${file}`)), `не скопирован ${file}`);
  }
  // Рекурсивный 0600 сделал бы каталог непроходимым: нужен go-rwx.
  assert.ok(calls.some((c) => c === `chmod -R go-rwx ${r.configDir}`), 'бэкап оставлен с открытыми правами');
});

test('порядок бэкапа: каталог, дамп, конфиги, затем hook', async () => {
  const calls = [];
  const exec = async (argv) => { calls.push(argv[0]); return { code: 0, stdout: '' }; };
  await runBackup({ exec, mode: BACKUP.DB, backupDir: '/mnt/b', hook: '/root/snap.sh', stamp: 's' });
  assert.deepEqual(calls, ['mkdir', 'gitlab-backup', 'grep', 'cp', 'cp', 'chmod', '/root/snap.sh']);
});

/**
 * gitlab-backup кладёт дамп туда, куда настроен GitLab, а не в наш каталог.
 * Сообщать пользователю путь, где дампа нет, — худший вид неправды в бэкапе.
 */
test('каталог дампа читается из gitlab.rb, а не выдумывается', async () => {
  const custom = async (argv) => argv[0] === 'grep'
    ? { code: 0, stdout: "gitlab_rails['backup_path'] = \"/mnt/nfs/gitlab\"\n" }
    : { code: 0, stdout: 'Creating backup archive: 123_gitlab_backup.tar [DONE]' };
  const r = await runBackup({ exec: custom, mode: BACKUP.DB, backupDir: '/mnt/b', stamp: 's' });
  assert.equal(r.dumpDir, '/mnt/nfs/gitlab');
  assert.equal(r.archive, '123_gitlab_backup.tar');

  const missing = async (argv) => argv[0] === 'grep'
    ? { code: 1, stdout: '' }
    : { code: 0, stdout: '' };
  const fallback = await runBackup({ exec: missing, mode: BACKUP.DB, backupDir: '/mnt/b', stamp: 's' });
  assert.equal(fallback.dumpDir, DEFAULT_DUMP_DIR, 'закомментированная настройка означает значение по умолчанию');
  assert.equal(fallback.archive, null);
});

test('провал hook останавливает: снапшот — единственный настоящий откат', async () => {
  const exec = async (argv) => {
    if (argv[0] === '/root/snap.sh') throw new Error('snapshot failed');
    return { code: 0, stdout: '' };
  };
  await assert.rejects(() => runBackup({ exec, mode: BACKUP.DB, backupDir: '/mnt/b', hook: '/root/snap.sh', stamp: 's' }), /snapshot failed/);
});

test('режим none ничего не делает', async () => {
  let called = false;
  const r = await runBackup({ exec: async () => { called = true; }, mode: BACKUP.NONE, backupDir: '/x', stamp: 's' });
  assert.equal(r.skipped, true);
  assert.equal(called, false);
});

/**
 * Без точной версии apt поставит последнюю и перепрыгнет обязательную
 * остановку; без --force-confold dpkg спросит про gitlab.rb и повиснет.
 */
test('установка фиксирует версию и не задаёт вопросов', () => {
  const argv = installArgv('gitlab-ee', '17.1.8-ee.0', '/tmp/apt.conf').join(' ');
  assert.match(argv, /gitlab-ee=17\.1\.8-ee\.0/);
  assert.match(argv, /--force-confold/);
  assert.match(argv, /-c \/tmp\/apt\.conf/);
  assert.ok(downloadArgv('gitlab-ee', '17.1.8-ee.0', null).includes('--download-only'));
  assert.deepEqual(holdArgv('gitlab-ee'), ['apt-mark', 'hold', 'gitlab-ee']);
  assert.deepEqual(unholdArgv('gitlab-ee'), ['apt-mark', 'unhold', 'gitlab-ee']);
  assert.equal(parseArchive('Creating backup archive: 17_gitlab_backup.tar [DONE]'), '17_gitlab_backup.tar');
  assert.equal(parseArchive('ничего похожего'), null);
});

const clock = () => {
  let now = 0;
  return { now: () => now, wait: async (ms) => { now += ms; } };
};

test('ожидание сервисов завершается, когда поднялись ключевые', async () => {
  let call = 0;
  const exec = async () => ({ code: 0, stdout: call++ === 0 ? ctlStatusDegraded : ctlStatusHealthy });
  const r = await waitServices({ exec, intervalMs: 1000, ...clock() });
  assert.equal(r.ok, true);
  assert.equal(r.running, 9);
});

test('сервисы не поднялись за отведённое время — не бесконечное ожидание', async () => {
  const exec = async () => ({ code: 0, stdout: ctlStatusDegraded });
  const r = await waitServices({ exec, timeoutMs: 10_000, intervalMs: 1000, ...clock() });
  assert.equal(r.ok, false);
});

test('ожидание миграций завершается на нуле', async () => {
  const queue = ['9 0', '4 0', '0 0'];
  let i = 0;
  const exec = async (argv) => {
    assert.equal(argv.join(' '), `gitlab-rails runner -e production ${MIGRATION_QUERY}`);
    return { code: 0, stdout: queue[Math.min(i++, queue.length - 1)] };
  };
  const r = await waitMigrations({ exec, intervalMs: 60_000, ...clock() });
  assert.equal(r.ok, true);
});

/**
 * Упавшую миграцию бессмысленно ждать: она не «догонит», а каждая минута
 * ожидания — минута простоя впустую.
 */
test('упавшая миграция прекращает ожидание немедленно', async () => {
  let calls = 0;
  const exec = async () => { calls++; return { code: 0, stdout: '5 1' }; };
  await assert.rejects(() => waitMigrations({ exec, intervalMs: 60_000, ...clock() }), MigrationsFailed);
  assert.equal(calls, 1, 'не должны продолжать опрашивать после падения');
});

test('неизвестное состояние миграций не считается нулём', async () => {
  const outs = [{ code: 1, stdout: '', stderr: 'boom' }, { code: 0, stdout: 'мусор' }, { code: 0, stdout: '0 0' }];
  let i = 0;
  const seen = [];
  const bus = { emit: (e) => seen.push(e.t) };
  const exec = async () => outs[Math.min(i++, outs.length - 1)];
  const r = await waitMigrations({ exec, bus, intervalMs: 1000, ...clock() });
  assert.equal(r.ok, true);
  assert.equal(seen.filter((t) => t === 'migrations:unknown').length, 2);
});

test('миграции не заканчиваются — выходим по таймауту, а не висим вечно', async () => {
  const exec = async () => ({ code: 0, stdout: '5 0' });
  const r = await waitMigrations({ exec, timeoutMs: 5 * 60_000, intervalMs: 60_000, ...clock() });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});

/** Страховка на случай неидущих часов: цикл обязан завершиться в любом случае. */
test('замершие часы не превращают ожидание в вечный цикл', async () => {
  const frozen = { now: () => 0, wait: async () => {} };
  const services = await waitServices({ exec: async () => ({ code: 0, stdout: ctlStatusDegraded }), timeoutMs: 10_000, intervalMs: 1_000, ...frozen });
  assert.equal(services.ok, false);
  const migrations = await waitMigrations({ exec: async () => ({ code: 0, stdout: '5 0' }), timeoutMs: 10_000, intervalMs: 1_000, ...frozen });
  assert.equal(migrations.ok, false);
});

test('темп считается по окну, а не по всей истории', () => {
  const h = [{ at: 0, queued: 100 }, { at: 600_000, queued: 60 }, { at: 1_200_000, queued: 50 }];
  const rate = rateOf(h, 10 * 60_000);
  assert.equal(rate.closed, 10, 'за последние десять минут закрыто 10, а не 50');
  // 10 миграций за 10 минут — одна в минуту, значит 50 штук это 50 минут.
  assert.equal(etaMinutes(50, rate), 50);
  assert.equal(etaMinutes(50, { closed: 0, windowMs: 600_000 }), null, 'нулевой темп не даёт оценки');
  assert.equal(rateOf([{ at: 0, queued: 1 }]), null);
});
