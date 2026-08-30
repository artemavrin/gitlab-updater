import { postJson, parseProxy } from '../core/http.js';

/**
 * Уведомления.
 *
 * Каждое сообщение самодостаточно: имя сервера и текущая версия есть в
 * каждом. Их читают с телефона, без контекста, возможно про несколько
 * серверов сразу — «шаг 3 готов» без имени хоста бесполезно.
 */
export const CHANNELS = ['telegram', 'slack', 'webhook'];

/** Какие события уходят наружу — зависит от профиля (см. docs/FLOWS.md). */
export const EVENTS = { START: 'start', STEP: 'step', SLOW: 'slow', DONE: 'done', ERROR: 'error' };

export function channelsFrom(config, env = process.env) {
  const out = [];
  const token = config.telegramToken ?? env.TELEGRAM_BOT_TOKEN;
  const chat = config.telegramChat ?? env.TELEGRAM_CHAT_ID;
  if (token && chat) out.push({ kind: 'telegram', token, chat });
  const slack = config.slackWebhook ?? env.SLACK_WEBHOOK_URL;
  if (slack) out.push({ kind: 'slack', url: slack });
  const hook = config.notifyWebhook ?? env.NOTIFY_WEBHOOK_URL;
  if (hook) out.push({ kind: 'webhook', url: hook });
  return out;
}

export async function send(channel, { text, event, http = postJson, proxy = null, ca = null, timeout = 15_000 }) {
  const opts = { proxy: parseProxy(proxy), ca, timeout };
  if (channel.kind === 'telegram') {
    return http(`https://api.telegram.org/bot${channel.token}/sendMessage`,
      { chat_id: channel.chat, text, disable_web_page_preview: true }, opts);
  }
  if (channel.kind === 'slack') return http(channel.url, { text }, opts);
  // Универсальный webhook получает событие целиком: интеграции нужнее поля,
  // чем готовая фраза.
  return http(channel.url, { text, ...event }, opts);
}

const HEAD = {
  [EVENTS.START]: '🚀', [EVENTS.STEP]: '✅', [EVENTS.SLOW]: '⏳',
  [EVENTS.DONE]: '🎉', [EVENTS.ERROR]: '⛔',
};

export function compose(t, kind, params) {
  // Тело есть не у всех событий: «шаг 3/6 готов» самодостаточно.
  const bodyKey = `notify.${kind}.body`;
  return [
    `${HEAD[kind] ?? ''} ${t(`notify.${kind}.title`, params)}`.trim(),
    t('notify.context', params),
    t.has(bodyKey) ? t(bodyKey, params) : null,
  ].filter(Boolean).join('\n');
}

/**
 * Подписка на шину. Отправка никогда не роняет апгрейд: недоставленное
 * сообщение — потеря информации, прерванный апгрейд — потеря вечера.
 */
export function createNotifier({ bus, t, channels, allow = null, allowFor = null, host, proxy = null, ca = null, http = postJson, onError = null }) {
  if (!channels.length) return { pending: () => Promise.resolve(), sent: [] };

  const sent = [];
  const inflight = [];
  // Профиль известен только когда путь построен, поэтому набор событий
  // приходит с run:start. Иначе патч слал бы «старт» и «финиш» — спам ради
  // двенадцати минут работы.
  let allowed = new Set(allow ?? []);

  const push = (kind, params) => {
    if (!allowed.has(kind)) return;
    const text = compose(t, kind, { host, ...params });
    sent.push({ kind, text });
    for (const channel of channels) {
      inflight.push(
        send(channel, { text, event: { kind, ...params }, http, proxy, ca })
          .catch((err) => onError?.({ channel: channel.kind, error: err.message }))
      );
    }
  };

  bus.on((e) => {
    if (e.t === 'run:start') {
      if (allowFor) allowed = new Set(allowFor(e.profile));
      push(EVENTS.START, { steps: e.steps, profile: e.profile, target: e.target, version: e.from });
    }
    else if (e.t === 'step:done') push(EVENTS.STEP, { index: e.index, of: e.of, version: e.version });
    else if (e.t === 'migrations:slow') push(EVENTS.SLOW, { version: e.version, queued: e.queued, elapsed: e.elapsedMin });
    else if (e.t === 'run:done') push(EVENTS.DONE, { target: e.target, elapsed: e.elapsedMin });
    else if (e.t === 'run:stopped') push(EVENTS.ERROR, { version: e.version, reason: e.reason, backup: e.backup, detail: e.detail });
  });

  return { pending: () => Promise.allSettled(inflight), sent };
}
