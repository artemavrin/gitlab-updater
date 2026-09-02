import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExec, MODE, ExecError } from '../src/core/exec.js';
import { skipList, backupArgv, runBackup, COMPONENTS, MODE as BACKUP, CONFIG_FILES, DEFAULT_DUMP_DIR, parseArchive } from '../src/steps/backup.js';
import { installArgv, downloadArgv, holdArgv, unholdArgv, updateLists } from '../src/steps/install.js';
import { waitServices, waitMigrations, MigrationsFailed, rateOf, etaMinutes, MIGRATION_QUERY, parseMigrationCounts, FAILED_MIGRATION_QUERY } from '../src/steps/settle.js';
import { ctlStatusHealthy, ctlStatusDegraded } from './fixtures/index.js';
import { execFileSync } from 'node:child_process';

/**
 * Ruby на машине или нет — и ничего больше.
 *
 * Раньше здесь стоял `try { … } catch { return; }`, и он проглотил
 * ReferenceError от невставленного импорта: тесты «проходили» за 0.14 мс, не
 * запустив ruby ни разу. Пропуск обязан ловить ровно отсутствие бинаря, иначе
 * это не пропуск, а зелёная галочка вместо проверки.
 */
function rubyMissing() {
  try {
    return execFileSync('ruby', ['-e', 'print 1'], { encoding: 'utf8' }) !== '1';
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    throw e;
  }
}

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
  const queue = ['9 0 batched', '4 0 batched', '0 0 batched'];
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
test('упавшая миграция прекращает ожидание немедленно и называет себя', async () => {
  // Второй запрос — диагностический, за именем упавшей миграции: цифра без
  // имени не отвечает ни на один вопрос, который в этот момент задают. На
  // живом сервере путь от «упавших 1» до причины занял три захода.
  let polls = 0;
  const exec = async (argv) => {
    const q = argv.at(-1);
    if (q === FAILED_MIGRATION_QUERY) {
      return { code: 0, stdout: 'BackfillSentNotificationsAfterPartition (PG::CheckViolation)\n' };
    }
    polls++;
    return { code: 0, stdout: '5 1 batched' };
  };
  const err = await waitMigrations({ exec, intervalMs: 60_000, ...clock() }).then(
    () => null, (e) => e);
  assert.ok(err instanceof MigrationsFailed, String(err));
  assert.equal(polls, 1, 'не должны продолжать опрашивать после падения');
  assert.equal(err.count, 1);
  assert.match(err.which, /BackfillSentNotificationsAfterPartition \(PG::CheckViolation\)/);
});

test('без имени остановка всё равно происходит', async () => {
  // Диагностика — не условие остановки: если запрос за именем не сработал,
  // подниматься дальше по-прежнему нельзя.
  const exec = async (argv) => (argv.at(-1) === FAILED_MIGRATION_QUERY
    ? { code: 1, stdout: '', stderr: 'boom' }
    : { code: 0, stdout: '0 2 batched' });
  const err = await waitMigrations({ exec, intervalMs: 60_000, ...clock() }).then(() => null, (e) => e);
  assert.ok(err instanceof MigrationsFailed);
  assert.equal(err.count, 2);
  assert.equal(err.which, null);
});

test('неизвестное состояние миграций не считается нулём', async () => {
  const outs = [{ code: 1, stdout: '', stderr: 'boom' }, { code: 0, stdout: 'мусор' }, { code: 0, stdout: '0 0 batched' }];
  let i = 0;
  const seen = [];
  const bus = { emit: (e) => seen.push(e.t) };
  const exec = async () => outs[Math.min(i++, outs.length - 1)];
  const r = await waitMigrations({ exec, bus, intervalMs: 1000, ...clock() });
  assert.equal(r.ok, true);
  assert.equal(seen.filter((t) => t === 'migrations:unknown').length, 2);
});

test('миграции не заканчиваются — выходим по таймауту, а не висим вечно', async () => {
  const exec = async () => ({ code: 0, stdout: '5 0 batched' });
  const r = await waitMigrations({ exec, timeoutMs: 5 * 60_000, intervalMs: 60_000, ...clock() });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});

/** Страховка на случай неидущих часов: цикл обязан завершиться в любом случае. */
test('замершие часы не превращают ожидание в вечный цикл', async () => {
  const frozen = { now: () => 0, wait: async () => {} };
  const services = await waitServices({ exec: async () => ({ code: 0, stdout: ctlStatusDegraded }), timeoutMs: 10_000, intervalMs: 1_000, ...frozen });
  assert.equal(services.ok, false);
  const migrations = await waitMigrations({ exec: async () => ({ code: 0, stdout: '5 0 batched' }), timeoutMs: 10_000, intervalMs: 1_000, ...frozen });
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

/**
 * Запрос о миграциях сверен с исходниками GitLab, а не написан по памяти.
 *
 * Дважды был неверен по одной и той же причине — «этот scope, кажется, есть
 * везде»:
 *
 * * `m.failed` — scope с таким именем не существует ни в state_machine-эпохе
 *   (там `with_status(:failed)`), но в enum-эпохе 13.11–13.12 он как раз есть:
 *   Rails-enum сам заводит scope на каждое значение. То есть верны оба вызова,
 *   но каждый в свою эпоху.
 * * `m.queued` — появился только в 14.0. В 13.11 и 13.12 у модели один scope,
 *   queue_order, и запрос падал с NoMethodError на всём пути с 13.x.
 *
 * Поэтому в запросе стоят оба варианта под respond_to?, а не один «правильный».
 * Что они действительно исполняются, проверяет тест ниже — настоящим Ruby на
 * заглушках трёх эпох.
 *
 * Сверено по тегам v13.0.14-ee, v13.11.7-ee, v13.12.15-ee, v14.0.12-ee,
 * v16.11.10-ee, v19.1.7-ee.
 */
test('запрос о миграциях учитывает обе смены API, а не одну', () => {
  // Ни один из двух вариантов не должен вызываться без проверки: голый вызов
  // и есть тот дефект, который дважды ломал проверку целиком.
  assert.match(MIGRATION_QUERY, /respond_to\?\(:queued\) \? m\.queued\.count : \(m\.active\.count \+ m\.paused\.count\)/);
  assert.match(MIGRATION_QUERY, /respond_to\?\(:with_status\) \? m\.with_status\(:failed\)\.count : m\.failed\.count/);
  // Старая очередь Sidekiq — единственный механизм на 13.0–13.10.
  assert.match(MIGRATION_QUERY, /Gitlab::BackgroundMigration/);
  // Сломанный вызов не должен становиться тихим «миграций нет».
  assert.match(MIGRATION_QUERY, /raise if e\.is_a\?\(NoMethodError\)/);
});

test('упавшие миграции останавливают ожидание, а не молчат', async () => {
  // Ровно то, что было сломано: ответ с непустым числом упавших обязан
  // прервать апгрейд, а не пройти незамеченным.
  const exec = createExec({ mode: MODE.REPLAY, fixtures: {
    [`gitlab-rails runner -e production ${MIGRATION_QUERY}`]: { code: 0, stdout: '3 2 batched' },
  } });
  await assert.rejects(
    () => waitMigrations({ exec, timeoutMs: 60_000, intervalMs: 1, wait: async () => {} }),
    (e) => e.name === 'MigrationsFailed' && e.count === 2,
  );
});

/**
 * Разбор ответа. «В порядке» по непонятному выводу — худший из возможных
 * ответов в этом месте: он разрешает ставить пакет поверх незавершённых
 * миграций.
 */
test('ответу о миграциях верим только когда механизм назван', () => {
  assert.deepEqual(parseMigrationCounts('5 1 batched,legacy'), { queued: 5, failed: 1, sources: 'batched,legacy' });
  // 13.0–13.10: класса BatchedMigration ещё нет, считается только очередь.
  assert.deepEqual(parseMigrationCounts('4 0 legacy'), { queued: 4, failed: 0, sources: 'legacy' });
  // Ни один механизм не нашёлся — значит спросили не то, а не «миграций нет».
  assert.equal(parseMigrationCounts('0 0 none'), null);
  // Старый двухпольный ответ тоже не проходит: он мог прийти только от
  // запроса, которого больше нет.
  assert.equal(parseMigrationCounts('0 0'), null);
  assert.equal(parseMigrationCounts('мусор'), null);
  assert.equal(parseMigrationCounts(''), null);
});

test('запрос о миграциях работает и там, где BatchedMigration ещё нет', () => {
  // Инструмент обещает подъём с 13.x, а класс появился только в 13.11: на
  // 13.0–13.10 обращение к нему даёт NameError, и проверка не работала вовсе.
  // Старые миграции там живут в очереди Sidekiq, и с 13.x подниматься, не
  // дождавшись их, нельзя.
  assert.match(MIGRATION_QUERY, /rescue NameError/);
  assert.match(MIGRATION_QUERY, /Gitlab::BackgroundMigration/);
  assert.match(MIGRATION_QUERY, /respond_to\?\(:remaining\)/);
  // NoMethodError наследуется от NameError: без этой строки сломанный вызов
  // стал бы тихим «0 0», то есть «миграций нет».
  assert.match(MIGRATION_QUERY, /raise if e\.is_a\?\(NoMethodError\)/);
});

/**
 * Запрос о миграциях проверяется настоящим Ruby на заглушках трёх эпох модели.
 *
 * Иначе проверять нечем: инстанса GitLab нет, а строка запроса — единственное
 * место в проекте, которое исполняется чужим интерпретатором. Одна опечатка
 * здесь стоила бы всей проверки миграций, и ровно это уже случилось дважды:
 * `m.failed` не существовал никогда, а `m.queued` появился только в 14.0 —
 * на 13.11 и 13.12 запрос падал с NoMethodError.
 *
 * Заглушки повторяют API из исходников GitLab по тегам, а не выдуманы.
 */
const RUBY_ERAS = [
  {
    name: '13.11–13.12: Rails-enum, есть active/paused/failed, queued нет',
    stub: `module Gitlab; module Database; module BackgroundMigration
      class BatchedMigration
        def self.active; Struct.new(:count).new(2); end
        def self.paused; Struct.new(:count).new(1); end
        def self.failed; Struct.new(:count).new(0); end
      end
    end; end; end
    module Gitlab; module BackgroundMigration; def self.remaining; 5; end; end; end`,
    expect: '8 0 batched,legacy',
  },
  {
    name: '14.0 и выше: state_machine, есть queued и with_status',
    stub: `module Gitlab; module Database; module BackgroundMigration
      class BatchedMigration
        def self.queued; Struct.new(:count).new(7); end
        def self.with_status(s); raise "unexpected status" unless s == :failed; Struct.new(:count).new(3); end
      end
    end; end; end
    module Gitlab; module BackgroundMigration; def self.remaining; 0; end; end; end`,
    expect: '7 3 batched,legacy',
  },
  {
    name: 'до 13.11: класса нет, только очередь Sidekiq',
    stub: 'module Gitlab; module BackgroundMigration; def self.remaining; 4; end; end; end',
    expect: '4 0 legacy',
  },
];

test('запрос о миграциях исполняется на всех трёх версиях модели', () => {
  if (rubyMissing()) return;
  for (const era of RUBY_ERAS) {
    const out = execFileSync('ruby', ['-e', `${era.stub}\n${MIGRATION_QUERY}`], { encoding: 'utf8' }).trim();
    assert.equal(out, era.expect, era.name);
    const counts = parseMigrationCounts(out);
    assert.ok(counts, `${era.name}: разбор ответа не должен давать null`);
  }
});

test('неизвестная смена API падает громко, а не отвечает «миграций нет»', () => {
  if (rubyMissing()) return;
  // Класс есть, но ни queued, ни active: так выглядит очередная смена API.
  // Тихое «0 0» здесь означало бы «можно продолжать» — худший из ответов.
  const stub = `module Gitlab; module Database; module BackgroundMigration
    class BatchedMigration; end
  end; end; end`;
  assert.throws(
    () => execFileSync('ruby', ['-e', `${stub}\n${MIGRATION_QUERY}`], { stdio: 'pipe' }),
    (e) => /NoMethodError/.test(String(e.stderr)),
  );
});

/**
 * Чужой apt-get update валит наш кодом 100 на первом же действии подъёма.
 *
 * Воспроизведено на живом apt: два `apt-get update` одновременно дают
 * «E: Could not get lock /var/lib/apt/lists/lock», код 100. Именно так умер
 * настоящий девятнадцатишаговый подъём, не начавшись, — и проверка готовности
 * этого не видела, потому что смотрела только dpkg-блокировку.
 */
const LOCK_ERROR = 'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 11507 (apt-get)\n'
  + 'E: Unable to lock directory /var/lib/apt/lists/\n';

const lockedOnce = (times) => {
  let left = times;
  return async (argv) => {
    if (!argv.join(' ').startsWith('apt-get update')) return { code: 0, stdout: '', stderr: '' };
    if (left-- > 0) throw new ExecError('exec-failed', { code: 100, argv: argv.join(' '), stdout: '', stderr: LOCK_ERROR });
    return { code: 0, stdout: 'Reading package lists... Done', stderr: '' };
  };
};

test('на занятой блокировке apt ждём и повторяем, а не падаем', async () => {
  const waited = [];
  const events = [];
  const r = await updateLists(lockedOnce(2), null, {
    bus: { emit: (e) => events.push(e) },
    waitMs: 1000,
    wait: async (ms) => { waited.push(ms); },
  });
  assert.equal(r.code, 0);
  assert.equal(waited.length, 2, 'два отказа — два ожидания');
  // Молчаливая пауза неотличима от зависания.
  assert.deepEqual(events.map((e) => e.t), ['apt:locked', 'apt:locked']);
  assert.equal(events[0].attempt, 1);
});

test('настоящая ошибка apt не повторяется, а поднимается сразу', async () => {
  // Повтор поверх «репозиторий не подписан» прячет причину и тратит время.
  let calls = 0;
  const gpg = async (argv) => {
    calls++;
    throw new ExecError('exec-failed', {
      code: 100, argv: argv.join(' '), stdout: '',
      stderr: "E: The repository 'https://packages.gitlab.com/… focal InRelease' is not signed.\n",
    });
  };
  await assert.rejects(() => updateLists(gpg, null, { waitMs: 1, wait: async () => {} }));
  assert.equal(calls, 1, 'повторять здесь нечего');
});

test('бесконечно ждать не станем: у ожидания есть предел', async () => {
  let calls = 0;
  const always = async (argv) => {
    calls++;
    throw new ExecError('exec-failed', { code: 100, argv: argv.join(' '), stdout: '', stderr: LOCK_ERROR });
  };
  await assert.rejects(() => updateLists(always, null, { attempts: 3, waitMs: 1, wait: async () => {} }));
  assert.equal(calls, 3);
});
