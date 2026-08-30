import ru from './ru.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export const LOCALES = { ru, en };
export const DEFAULT_LOCALE = 'en';

/**
 * Русский требует трёх форм (1 миграция, 2 миграции, 5 миграций),
 * английский двух. Селектор — часть локали, а не вызывающего кода.
 */
const PLURAL = {
  ru: (n) => {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 0;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
    return 2;
  },
  en: (n) => (n === 1 ? 0 : 1),
};

/** Порядок источников тот же, что у остальных настроек; en — конечный запасной. */
export function resolveLocale({ flag, env = process.env, config } = {}) {
  const fromEnvLocale = () => {
    const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
    const tag = raw.split('.')[0].split('_')[0].toLowerCase();
    return Object.hasOwn(LOCALES, tag) ? tag : null;
  };
  for (const candidate of [flag, env.GITLAB_UPGRADE_LANG, config, fromEnvLocale()]) {
    if (candidate && Object.hasOwn(LOCALES, candidate)) return candidate;
  }
  return DEFAULT_LOCALE;
}

export function createTranslator(locale = DEFAULT_LOCALE) {
  const dict = LOCALES[locale] ?? LOCALES[DEFAULT_LOCALE];
  const pick = PLURAL[locale] ?? PLURAL[DEFAULT_LOCALE];

  const t = (key, params = {}) => {
    let value = dict[key];
    if (value === undefined) return key;
    if (Array.isArray(value)) value = value[pick(Number(params.n ?? 0))] ?? value[value.length - 1];
    return String(value).replace(/\{(\w+)\}/g, (m, name) =>
      Object.hasOwn(params, name) ? String(params[name]) : m);
  };

  t.locale = locale;
  t.has = (key) => Object.hasOwn(dict, key);
  return t;
}
