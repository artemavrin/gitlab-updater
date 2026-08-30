/** Маскирование секретов перед записью в журнал и на экран. */

const USERINFO = /(^|\s|=|")([a-z0-9+.-]+:\/\/)([^\s/@"]+)@/gi;

/** socks5://user:pass@host → socks5://user:***@host */
export function redactUrl(text) {
  return String(text).replace(USERINFO, (_m, lead, scheme, userinfo) => {
    const user = userinfo.split(':')[0];
    return `${lead}${scheme}${user}:***@`;
  });
}

/**
 * Скрывает userinfo в любых URL плюс явно переданные строки-секреты.
 * Секреты короче 4 символов игнорируются: слишком высок риск испортить текст.
 */
export function redact(text, secrets = []) {
  let out = redactUrl(text);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

export function redactArgv(argv, secrets = []) {
  return argv.map((a) => redact(a, secrets));
}
