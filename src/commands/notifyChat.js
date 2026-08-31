import { waitForChats, sendChatId, describeChat } from '../notify/telegram.js';
import { setSetting } from '../cli/settings.js';
import { EXIT } from '../plan/planner.js';

/**
 * Узнать chat id, не доставая его руками.
 *
 * Токен уже в конфиге. Команда ждёт, пока человек нажмёт Start в чате с
 * ботом, и отвечает туда же — id виден там, где его и будут искать, в
 * Telegram. Заодно печатает его в терминале и предлагает записать в конфиг.
 *
 * Ничего не меняет на сервере; с `--yes` меняет только свой конфиг.
 */
export async function commandNotifyChat(ctx) {
  const { t, config, flags } = ctx;
  const paint = ctx.paint ?? ((_role, text) => text);
  const token = config.telegramToken;

  if (!token) {
    return {
      code: EXIT.ERROR,
      errorCode: 'telegram-no-token',
      lines: ['', ` ${paint('error', t('telegram.noToken'))}`, ` ${t('telegram.noTokenHint')}`, ''],
      result: { chats: [], configured: false },
    };
  }

  const out = ctx.stderr ?? process.stderr;
  const found = await waitForChats({
    token,
    proxy: config.notifyProxy ?? config.proxy ?? null,
    ca: config.proxyCa ?? null,
    http: ctx.http,
    now: ctx.now,
    // Ожидание молчаливым быть не должно: две минуты без единой строки
    // выглядят как зависшая команда.
    onWait: () => out.write?.(t('telegram.waiting') + '\n'),
  });

  if (!found.ok) {
    // 409 значит, что на боте висит webhook, и getUpdates не работает в
    // принципе. Это не «ничего не пришло», и лечится это иначе.
    const webhook = found.status === 409;
    return {
      code: EXIT.ERROR,
      errorCode: webhook ? 'telegram-webhook' : 'telegram-failed',
      lines: ['', ` ${paint('error', t(webhook ? 'telegram.webhook' : 'telegram.failed', { detail: found.error }))}`, ''],
      result: { chats: [], configured: false },
    };
  }

  if (!found.chats.length) {
    return {
      code: EXIT.ERROR,
      errorCode: 'telegram-no-chat',
      lines: ['', ` ${paint('warn', t('telegram.nobody'))}`, ` ${t('telegram.nobodyHint')}`, ''],
      result: { chats: [], configured: false },
    };
  }

  const lines = ['', ` ${t('telegram.found', { n: found.chats.length })}`, ''];
  for (const chat of found.chats) {
    lines.push(`   ${paint('ok', chat.id.padEnd(16))} ${describeChat(chat, t)}`);
    // Отвечаем в сам чат: человек смотрит в телефон, а не в терминал.
    await sendChatId(chat, {
      token,
      proxy: config.notifyProxy ?? config.proxy ?? null,
      ca: config.proxyCa ?? null,
      http: ctx.http,
      text: t('telegram.message', { id: chat.id }),
    }).catch(() => null);
  }
  lines.push('');

  // Записываем только когда чат один и это сказано явно: боту могли написать
  // несколько человек, и молча выбрать одного значит однажды слать отчёты об
  // апгрейде постороннему.
  const single = found.chats.length === 1 ? found.chats[0] : null;
  let configured = false;
  if (single && flags.yes) {
    setSetting('telegram-chat', single.id, { path: config.configPath });
    configured = true;
    lines.push(` ${paint('ok', t('telegram.saved', { id: single.id, path: config.configPath }))}`, '');
  } else if (single) {
    lines.push(` ${t('telegram.saveHint', { id: single.id })}`, '');
  } else {
    lines.push(` ${t('telegram.pickOne')}`, '');
  }

  return {
    code: EXIT.CURRENT,
    lines,
    result: { chats: found.chats.map((c) => ({ id: c.id, type: c.type, title: c.title })), configured },
  };
}
