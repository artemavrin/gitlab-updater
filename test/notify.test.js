import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/core/events.js';
import { createTranslator, LOCALES } from '../src/i18n/index.js';
import { createNotifier, channelsFrom, compose, send, EVENTS } from '../src/notify/index.js';
import { createJournal, latestJournal, journalName } from '../src/core/logger.js';
import { detachArgv, UNIT } from '../src/core/detach.js';
import { commandAttach, format } from '../src/commands/attach.js';
import { policyFor, PROFILE, EXIT } from '../src/plan/planner.js';

const t = createTranslator('ru');
const dir = () => mkdtempSync(join(tmpdir(), 'glu-notify-'));

test('каналы собираются из конфига и окружения', () => {
  assert.deepEqual(channelsFrom({}, {}), []);
  const fromEnv = channelsFrom({}, { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '-100', SLACK_WEBHOOK_URL: 'https://s' });
  assert.deepEqual(fromEnv.map((c) => c.kind), ['telegram', 'slack']);
  // Токен без чата бесполезен — канал не должен собираться наполовину.
  assert.deepEqual(channelsFrom({}, { TELEGRAM_BOT_TOKEN: 'tok' }), []);
});

/**
 * Сообщения читают с телефона, без контекста, возможно про несколько
 * серверов сразу: «шаг 3 готов» без имени хоста бесполезно.
 */
test('каждое сообщение самодостаточно: хост и версия внутри', () => {
  for (const kind of Object.values(EVENTS)) {
    const text = compose(t, kind, { host: 'gitlab.corp.local', version: '17.11.4-ee.0', target: 'x', steps: 1, profile: 'patch', index: 1, of: 1, queued: 3, elapsed: 90, reason: 'r', backup: '/b', detail: 'd' });
    assert.match(text, /gitlab\.corp\.local/, `${kind}: нет имени сервера`);
    assert.match(text, /17\.11\.4-ee\.0/, `${kind}: нет версии`);
    assert.ok(!/\{\w+\}/.test(text), `${kind}: незаполненная подстановка в «${text}»`);
  }
});

test('сообщение об остановке — инструкция, а не сигнал тревоги', () => {
  const text = compose(t, EVENTS.ERROR, { host: 'h', version: '16.11.10-ee.0', reason: 'migrations-failed', backup: '/mnt/b/2026', detail: 'BackfillX' });
  assert.match(text, /\/mnt\/b\/2026/, 'не сказано, где бэкап');
  assert.match(text, /resume --yes/, 'не сказано, чем продолжить');
});

test('сообщения собираются в обеих локалях без утечки ключей', () => {
  for (const lang of Object.keys(LOCALES)) {
    const tt = createTranslator(lang);
    for (const kind of Object.values(EVENTS)) {
      const text = compose(tt, kind, { host: 'h', version: 'v', target: 'x', steps: 1, profile: 'p', index: 1, of: 2, queued: 1, elapsed: 1, reason: 'r', backup: 'b', detail: 'd' });
      assert.ok(!text.includes('notify.'), `${lang}/${kind}: ключ вместо текста`);
    }
  }
});

test('профиль патча шлёт только ошибку — старт и финиш были бы спамом', () => {
  assert.deepEqual(policyFor(PROFILE.PATCH).notify, ['error']);
  assert.ok(policyFor(PROFILE.LONG).notify.includes('step'));
});

/**
 * Профиль известен только когда путь построен, поэтому набор событий
 * приходит с run:start. Иначе патч слал бы «старт» и «финиш» — спам ради
 * двенадцати минут работы.
 */
test('набор событий берётся из профиля запуска, а не задаётся заранее', async () => {
  const posts = [];
  const http = async (url, data) => { posts.push(data.text); return { status: 200 }; };
  const drive = async (profile) => {
    posts.length = 0;
    const bus = new EventBus();
    const n = createNotifier({
      bus, t, host: 'h', channels: [{ kind: 'slack', url: 'https://s' }],
      allowFor: (p) => policyFor(p).notify, http,
    });
    bus.emit({ t: 'run:start', steps: 1, profile, from: 'a', target: 'b' });
    bus.emit({ t: 'step:done', index: 1, of: 1, version: 'v' });
    bus.emit({ t: 'run:done', target: 'b', elapsedMin: 12 });
    await n.pending();
    return posts.length;
  };
  assert.equal(await drive(PROFILE.PATCH), 0, 'для патча старт и финиш — спам');
  assert.ok(await drive(PROFILE.LONG) >= 3, 'длинный путь обязан сообщать о ходе');
});

test('уведомитель шлёт только разрешённые профилем события', async () => {
  const bus = new EventBus();
  const posts = [];
  const n = createNotifier({
    bus, t, host: 'h', channels: [{ kind: 'slack', url: 'https://s' }],
    allow: ['error'], http: async (url, data) => { posts.push(data.text); return { status: 200 }; },
  });
  bus.emit({ t: 'run:start', steps: 3, profile: 'long', from: 'a', target: 'b' });
  bus.emit({ t: 'step:done', index: 1, of: 3, version: 'v' });
  bus.emit({ t: 'run:stopped', reason: 'migrations-failed', version: 'v', backup: '/b', detail: 'd' });
  await n.pending();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /ОСТАНОВЛЕНО/);
});

/**
 * Недоставленное сообщение — потеря информации, прерванный апгрейд —
 * потеря вечера. Отправка не имеет права ронять апгрейд.
 */
test('падение канала не роняет апгрейд', async () => {
  const bus = new EventBus();
  const errors = [];
  const n = createNotifier({
    bus, t, host: 'h', channels: [{ kind: 'slack', url: 'https://s' }],
    allow: ['done'], http: async () => { throw new Error('network down'); },
    onError: (e) => errors.push(e),
  });
  bus.emit({ t: 'run:done', target: 'x', elapsedMin: 5 });
  await n.pending();
  assert.equal(errors[0].error, 'network down');
});

test('без каналов уведомитель не подписывается вовсе', async () => {
  const bus = new EventBus();
  const n = createNotifier({ bus, t, host: 'h', channels: [], allow: ['done'] });
  bus.emit({ t: 'run:done', target: 'x' });
  await n.pending();
  assert.deepEqual(n.sent, []);
});

test('telegram и slack получают свою форму запроса', async () => {
  const seen = [];
  const http = async (url, data) => { seen.push({ url, data }); return { status: 200 }; };
  await send({ kind: 'telegram', token: 'T', chat: '-100' }, { text: 'привет', http });
  await send({ kind: 'slack', url: 'https://hooks' }, { text: 'привет', http });
  await send({ kind: 'webhook', url: 'https://w' }, { text: 'привет', event: { kind: 'done', target: 'x' }, http });
  assert.match(seen[0].url, /api\.telegram\.org\/botT\/sendMessage/);
  assert.equal(seen[0].data.chat_id, '-100');
  assert.equal(seen[1].data.text, 'привет');
  assert.equal(seen[2].data.target, 'x', 'webhook должен получать поля события, а не только фразу');
});

test('журнал пишет JSONL и маскирует секреты', () => {
  const d = dir();
  const j = createJournal({ dir: d, stamp: '20260831-090000', secrets: ['s3cret'] });
  j.write({ t: 'run:start', proxy: 'socks5h://u:s3cret@10.0.0.5:1080' });
  const body = readFileSync(j.path, 'utf8');
  assert.ok(!body.includes('s3cret'), 'секрет утёк в журнал');
  assert.equal(JSON.parse(body.trim()).t, 'run:start');
  assert.match(j.path, new RegExp(journalName('20260831-090000') + '$'));
});

test('самый свежий журнал — то, к чему подключается attach', () => {
  const d = dir();
  writeFileSync(join(d, journalName('20260101-000000')), '{}\n');
  const newer = join(d, journalName('20260831-090000'));
  writeFileSync(newer, '{}\n');
  assert.equal(latestJournal(d), newer);
  assert.equal(latestJournal(join(d, 'нет-такого')), null);
});

test('attach показывает журнал и сообщает, сколько событий', async () => {
  const d = dir();
  const path = join(d, journalName('20260831-090000'));
  writeFileSync(path, ['{"t":"run:start","steps":2}', '{"t":"step:done","index":1}', 'оборванная строка'].join('\n') + '\n');
  const seen = [];
  const r = await commandAttach({
    t, config: { logDir: d }, flags: { follow: false, journal: null }, render: (e) => seen.push(e.t),
  });
  assert.equal(r.code, EXIT.CURRENT);
  assert.deepEqual(seen, ['run:start', 'step:done']);
  assert.equal(r.result.events, 2, 'битая строка не должна считаться событием');
});

test('attach без журналов не притворяется, что подключился', async () => {
  const r = await commandAttach({ t, config: { logDir: join(dir(), 'пусто') }, flags: {} });
  assert.equal(r.errorCode, 'no-journal');
});

test('формат строки журнала читаем и не теряет полей', () => {
  const line = format({ ts: '2026-08-31T09:05:00.000Z', t: 'step:done', index: 3, of: 6, version: '17.1.8-ee.0' });
  assert.match(line, /^09:05:00 step:done/);
  assert.match(line, /version=17\.1\.8-ee\.0/);
});

test('увод в фон переживает выход из сессии, с запасным вариантом без systemd', () => {
  const argv = ['/usr/local/bin/gitlab-upgrade', 'run', '--yes', '--detach'];
  const withSystemd = detachArgv(argv, { useSystemd: true });
  assert.equal(withSystemd[0], 'systemd-run');
  assert.ok(withSystemd.includes(`--unit=${UNIT}`));
  assert.ok(!withSystemd.includes('--detach'), '--detach обязан быть убран, иначе бесконечная рекурсия');
  const fallback = detachArgv(argv, { useSystemd: false });
  assert.equal(fallback[0], 'setsid');
  assert.ok(!fallback.includes('--detach'));
});
