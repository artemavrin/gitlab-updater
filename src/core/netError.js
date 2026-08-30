/**
 * Сетевая ошибка кодом, а не фразой.
 *
 * До `proxy test` тексты исключений жили прямо в коде по-русски: они были
 * видны только в диагностике, и это сходило с рук. `proxy test` показывает
 * их пользователю — значит фраза обязана прийти из локали, а по коду ещё и
 * агент сможет отличить «прокси отклонил логин» от «хост недоступен», не
 * разбирая текст.
 *
 * `message` остаётся машинным: он уезжает в журнал, где язык только мешает.
 */
export class NetError extends Error {
  constructor(code, params = {}) {
    const detail = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ');
    super(detail ? `${code} ${detail}` : code);
    this.name = 'NetError';
    this.code = code;
    this.params = params;
  }
}

/** Текст ошибки для человека. Незнакомый код показываем как есть, а не молчим. */
export function netMessage(err, t) {
  if (!(err instanceof NetError)) return err?.message ?? String(err);
  const key = `error.net.${err.code}`;
  return t.has(key) ? t(key, err.params) : err.message;
}

/** Коды, которые встречаются в socks5.js и http.js. Список — контракт с локалями. */
export const NET = {
  PROXY_SCHEME: 'proxy-scheme',
  PROXY_CONNECT: 'proxy-connect',
  PROXY_TIMEOUT: 'proxy-timeout',
  TCP_TIMEOUT: 'tcp-timeout',
  READ_TIMEOUT: 'read-timeout',
  TRUNCATED: 'truncated',
  SOCKS_TIMEOUT: 'socks-timeout',
  SOCKS_AUTH_REQUIRED: 'socks-auth-required',
  SOCKS_NO_METHOD: 'socks-no-method',
  SOCKS_AUTH_REJECTED: 'socks-auth-rejected',
  SOCKS_REFUSED: 'socks-refused',
};

/**
 * Причины отказа SOCKS5 (RFC 1928, поле REP). Ключ локали, а не фраза:
 * «хост недоступен» и «соединение запрещено правилами» ведут к разным
 * действиям, и подменять их общим «не удалось» — терять час на диагностике.
 */
export const SOCKS_REPLY = {
  0x01: 'socks.general',
  0x02: 'socks.forbidden',
  0x03: 'socks.network-unreachable',
  0x04: 'socks.host-unreachable',
  0x05: 'socks.refused',
  0x06: 'socks.ttl',
  0x07: 'socks.command',
  0x08: 'socks.address-type',
};
