import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatsFromUpdates, waitForChats, describeChat } from '../src/notify/telegram.js';
import { commandNotifyChat } from '../src/commands/notifyChat.js';
import { createTranslator, LOCALES } from '../src/i18n/index.js';
import { COMMANDS } from '../src/cli/registry.js';
import { EXIT } from '../src/plan/planner.js';

const t = createTranslator('ru');
const TOKEN = '123456:AAbbCCddEEffGG';

const update = (over = {}) => ({
  update_id: 1,
  message: { message_id: 1, from: { username: 'artem' }, chat: { id: 42, type: 'private', first_name: 'Артём' }, text: '/start' },
  ...over,
});

/** Ответ Telegram, как его отдаёт наш request(): status, headers, body. */
const reply = (body, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) });

function ctx(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-'));
  return {
    t,
    flags: {},
    config: { telegramToken: TOKEN, configPath: join(dir, 'config.json'), proxy: null },
    stderr: { write: () => {} },
    dir,
    ...over,
  };
}

test('чат достаётся из всех видов обновлений, а не только из message', () => {
  // Бота добавили в группу и не написали ни слова — у Telegram это
  // my_chat_member. Пропустить его значит потребовать лишнего действия там,
  // где id уже известен.
  const chats = chatsFromUpdates([
    update(),
    { update_id: 2, my_chat_member: { chat: { id: -1001234, type: 'supergroup', title: 'Ops' } } },
    { update_id: 3, channel_post: { chat: { id: -100999, type: 'channel', title: 'Релизы' } } },
    { update_id: 4, poll: { id: 'x' } },
  ]);
  assert.deepEqual(chats.map((c) => c.id), ['42', '-1001234', '-100999']);
  assert.equal(chats[0].title, 'Артём');
  assert.equal(chats[1].type, 'supergroup');
});

test('один и тот же чат не двоится, а мусор не роняет разбор', () => {
  const chats = chatsFromUpdates([update(), update({ update_id: 2 }), null, {}, 'ерунда']);
  assert.equal(chats.length, 1);
  assert.deepEqual(chatsFromUpdates(undefined), []);
});

test('ожидание прекращается на первом же найденном чате', async () => {
  let calls = 0;
  const res = await waitForChats({
    token: TOKEN,
    http: async () => { calls++; return reply({ ok: true, result: [update()] }); },
    deadlineMs: 10_000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.chats[0].id, '42');
  assert.equal(calls, 1, 'лишний запрос — лишняя минута ожидания у человека');
});

test('пустая очередь — не отказ, а «пока никто не написал»', async () => {
  let now = 0;
  const res = await waitForChats({
    token: TOKEN,
    http: async () => reply({ ok: true, result: [] }),
    deadlineMs: 100,
    now: () => (now += 60),
  });
  assert.deepEqual(res, { ok: true, chats: [] });
});

test('webhook на боте — отдельный диагноз, а не «никто не написал»', async () => {
  // 409 значит, что getUpdates не заработает никогда, сколько ни жди.
  const res = await waitForChats({
    token: TOKEN,
    http: async () => reply({ ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active' }, 409),
    deadlineMs: 1000,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /409/);
});

test('токена нет — команда говорит об этом, а не ждёт две минуты', async () => {
  const c = ctx({ config: { telegramToken: null, configPath: '/nope' } });
  const r = await commandNotifyChat(c);
  assert.equal(r.code, EXIT.ERROR);
  assert.equal(r.errorCode, 'telegram-no-token');
  assert.match(r.lines.join('\n'), /config set telegram-token/);
});

test('найденный id и печатается, и отправляется в сам чат', async () => {
  const sent = [];
  const c = ctx({
    http: async (url) => {
      sent.push(url);
      return url.includes('getUpdates') ? reply({ ok: true, result: [update()] }) : reply({ ok: true, result: {} });
    },
  });
  const r = await commandNotifyChat(c);
  assert.equal(r.code, EXIT.CURRENT);
  assert.deepEqual(r.result.chats.map((x) => x.id), ['42']);
  // В терминале — id, в Telegram — сообщение с ним же: человек смотрит в телефон.
  assert.match(r.lines.join('\n'), /\b42\b/);
  assert.ok(sent.some((u) => u.includes('sendMessage') && u.includes('chat_id=42')), sent.join('\n'));
  rmSync(c.dir, { recursive: true, force: true });
});

test('в конфиг пишем только по --yes и только когда чат один', async () => {
  const http = async (url) => (url.includes('getUpdates')
    ? reply({ ok: true, result: [update()] })
    : reply({ ok: true, result: {} }));

  // Без --yes — только подсказка: запись в конфиг человек должен разрешить.
  const quiet = ctx({ http });
  const a = await commandNotifyChat(quiet);
  assert.equal(a.result.configured, false);
  assert.match(a.lines.join('\n'), /config set telegram-chat 42/);

  const saving = ctx({ http, flags: { yes: true } });
  const b = await commandNotifyChat(saving);
  assert.equal(b.result.configured, true);
  assert.equal(JSON.parse(readFileSync(saving.config.configPath, 'utf8')).telegramChat, '42');
  for (const c of [quiet, saving]) rmSync(c.dir, { recursive: true, force: true });
});

test('несколько чатов не выбираются молча даже с --yes', async () => {
  // Боту могли написать несколько человек. Выбрать одного за человека значит
  // однажды слать отчёты об апгрейде постороннему.
  const c = ctx({
    flags: { yes: true },
    http: async (url) => (url.includes('getUpdates')
      ? reply({ ok: true, result: [update(), { update_id: 9, message: { chat: { id: 77, type: 'private', first_name: 'Кто-то' } } }] })
      : reply({ ok: true, result: {} })),
  });
  const r = await commandNotifyChat(c);
  assert.equal(r.result.configured, false);
  assert.equal(r.result.chats.length, 2);
  assert.match(r.lines.join('\n'), /больше одного/);
  rmSync(c.dir, { recursive: true, force: true });
});

test('токен не появляется ни в выводе, ни в ошибке', async () => {
  const c = ctx({
    http: async () => reply({ ok: false, error_code: 401, description: `bot ${TOKEN} unauthorized` }, 401),
  });
  const r = await commandNotifyChat(c);
  const printed = r.lines.join('\n') + JSON.stringify(r.result);
  assert.ok(!printed.includes('AAbbCCddEEff'), printed);
  rmSync(c.dir, { recursive: true, force: true });
});

test('поля result совпадают с объявленными в реестре', async () => {
  const c = ctx({
    http: async (url) => (url.includes('getUpdates') ? reply({ ok: true, result: [update()] }) : reply({ ok: true, result: {} })),
  });
  const r = await commandNotifyChat(c);
  assert.deepEqual(Object.keys(r.result).sort(), Object.keys(COMMANDS['notify-chat'].result).sort());
  rmSync(c.dir, { recursive: true, force: true });
});

for (const locale of Object.keys(LOCALES)) {
  test(`тексты команды переведены и укладываются в 78 колонок — ${locale}`, async () => {
    const tr = createTranslator(locale);
    for (const key of ['telegram.noToken', 'telegram.waiting', 'telegram.found', 'telegram.message',
      'telegram.saved', 'telegram.saveHint', 'telegram.pickOne', 'telegram.nobody',
      'telegram.nobodyHint', 'telegram.webhook', 'telegram.failed', 'exit.telegram-failed']) {
      assert.ok(tr.has(key), `${locale}: нет ключа ${key}`);
    }
    for (const type of ['private', 'group', 'supergroup', 'channel']) {
      assert.ok(tr.has(`telegram.chat.${type}`), `${locale}: нет названия для ${type}`);
      assert.ok(describeChat({ type, title: '' }, tr).length > 0);
    }
    const c = ctx({
      t: tr,
      http: async (url) => (url.includes('getUpdates') ? reply({ ok: true, result: [update()] }) : reply({ ok: true, result: {} })),
    });
    for (const line of (await commandNotifyChat(c)).lines) {
      assert.ok([...line].length <= 78, `${locale}: строка длиннее 78 колонок: «${line}»`);
    }
    rmSync(c.dir, { recursive: true, force: true });
  });
}
