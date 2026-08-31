import { request, parseProxy } from '../core/http.js';
import { httpFailure } from './index.js';
import { errorDetail } from '../core/exec.js';

/**
 * Поиск chat id по ответу getUpdates.
 *
 * Доставать id руками — три шага с curl, grep по JSON и подстановкой токена в
 * командную строку, где его увидит `ps` и история шелла. Токен уже лежит в
 * конфиге; спросить у Telegram, кто боту написал, инструмент может сам.
 *
 * Разбор отделён от сети: у Telegram обновление бывает пяти видов, и путать
 * их не хочется, а проверить это без сети можно только чистой функцией.
 */

export const TELEGRAM_API = 'https://api.telegram.org';

/** Виды обновлений, в которых есть чат. my_chat_member — «бота добавили в группу». */
const WITH_CHAT = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member'];

/**
 * Чаты из ответа getUpdates — по одному на id, в порядке появления.
 *
 * Никакой «первый попавшийся»: боту могли написать несколько человек, и молча
 * выбрать одного значит однажды слать отчёты об апгрейде постороннему.
 */
export function chatsFromUpdates(updates) {
  const seen = new Map();
  for (const update of Array.isArray(updates) ? updates : []) {
    for (const kind of WITH_CHAT) {
      const chat = update?.[kind]?.chat;
      if (!chat || chat.id === undefined || chat.id === null) continue;
      const id = String(chat.id);
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        type: chat.type ?? 'unknown',
        title: chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || ''),
        from: update?.[kind]?.from?.username ?? null,
      });
    }
  }
  return [...seen.values()];
}

/** Человеку: «личный чат с Артём» или «группа Ops». */
export function describeChat(chat, t) {
  const kind = t.has(`telegram.chat.${chat.type}`) ? t(`telegram.chat.${chat.type}`) : chat.type;
  return chat.title ? `${kind} · ${chat.title}` : kind;
}

const api = (token, method) => `${TELEGRAM_API}/bot${token}/${method}`;

/**
 * Запрос к API с прокси и разбором ответа.
 *
 * Ошибку описываем через httpFailure: токен лежит прямо в URL, и он не должен
 * попасть ни в сообщение, ни в журнал.
 */
async function call(token, method, { params = {}, proxy = null, ca = null, timeout = 20_000, http = request } = {}) {
  const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  const url = `${api(token, method)}${query ? `?${query}` : ''}`;
  const res = await http(url, { proxy: parseProxy(proxy), ca, timeout });
  const failure = httpFailure(res, { token });
  if (failure) return { ok: false, error: failure, status: res?.status };
  try {
    const body = JSON.parse(res.body);
    return body.ok ? { ok: true, result: body.result } : { ok: false, error: String(body.description ?? 'no description') };
  } catch {
    // Не фраза, а данные: текст отказа живёт в локалях, сюда попадает только
    // то, что действительно ответил сервер.
    return { ok: false, error: errorDetail(res?.body) || `HTTP ${res?.status ?? '?'}` };
  }
}

/**
 * Ждём, пока кто-нибудь напишет боту.
 *
 * Длинный опрос, а не цикл с паузами: Telegram держит соединение и отвечает в
 * ту же секунду, когда человек нажимает Start. Смещение не подтверждаем —
 * обновления остаются в очереди: если у бота есть настоящий обработчик, мы не
 * должны съедать его сообщения.
 */
export async function waitForChats({
  token, proxy = null, ca = null, http = request,
  pollSeconds = 25, deadlineMs = 120_000, now = () => Date.now(), onWait = null,
}) {
  const until = now() + deadlineMs;
  let first = true;
  do {
    // Первый запрос без ожидания: сообщение могло прийти до запуска команды.
    const wait = first ? 0 : pollSeconds;
    first = false;
    const res = await call(token, 'getUpdates', {
      params: { timeout: wait, limit: 100 },
      proxy, ca, http, timeout: (wait + 15) * 1000,
    });
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    const chats = chatsFromUpdates(res.result);
    if (chats.length) return { ok: true, chats };
    onWait?.();
  } while (now() < until);
  return { ok: true, chats: [] };
}

/** Ответ в сам чат: id виден там, где его будут искать — в Telegram. */
export function sendChatId(chat, { token, proxy = null, ca = null, http = request, text }) {
  return call(token, 'sendMessage', {
    params: { chat_id: chat.id, text, parse_mode: 'HTML' },
    proxy, ca, http,
  });
}
