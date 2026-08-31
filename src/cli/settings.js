import { writeFileSync, mkdirSync, renameSync, statSync, accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { parseProxy } from '../core/http.js';
import { CONFIG_PATH, DEFAULTS, readConfigFile } from './config.js';

/**
 * Настройки, которые можно менять командой.
 *
 * Не всё из `DEFAULTS`: `stateDir`, `logDir` и `configPath` — расположение
 * самого инструмента, их правят пакетом или флагом, а не через `config set`.
 *
 * `secret: true` означает, что значение не показывается целиком нигде — ни
 * в `config list`, ни в `--json`. Токен бота в выводе команды однажды
 * окажется в чужом тикете вместе со всей вставленной простынёй.
 */
export const SETTINGS = {
  proxy: { kind: 'proxy', secret: true },
  'proxy-ca': { kind: 'file', key: 'proxyCa' },
  'proxy-all-apt': { kind: 'boolean', key: 'proxyAllApt' },
  lang: { kind: 'enum', choices: ['ru', 'en'] },
  'backup-dir': { kind: 'dir', key: 'backupDir' },
  'backup-hook': { kind: 'file', key: 'backupHook' },
  'min-free-gb': { kind: 'number', key: 'minFreeGb', min: 1 },
  notify: { kind: 'boolean' },
  'telegram-token': { kind: 'string', key: 'telegramToken', secret: true },
  'telegram-chat': { kind: 'string', key: 'telegramChat' },
  'slack-webhook': { kind: 'string', key: 'slackWebhook', secret: true },
  'notify-webhook': { kind: 'string', key: 'notifyWebhook', secret: true },
};

/** Имя в командной строке → ключ конфига. Дефис снаружи, camelCase внутри. */
export const settingKey = (name) => SETTINGS[name]?.key ?? name;

export const SETTING_NAMES = Object.keys(SETTINGS);

export class SettingError extends Error {
  constructor(code, params = {}) {
    super(`${code} ${JSON.stringify(params)}`);
    this.code = code;
    this.params = params;
  }
}

/**
 * Разбор и проверка значения.
 *
 * Проверяем на месте, а не при следующем запуске: настройка, которая не
 * работает, не должна тихо записаться и обнаружиться через месяц посреди
 * апгрейда.
 */
export function parseSetting(name, raw) {
  const spec = SETTINGS[name];
  if (!spec) throw new SettingError('setting-unknown', { name });
  const value = String(raw);

  switch (spec.kind) {
    case 'boolean': {
      if (['true', 'yes', '1', 'on'].includes(value.toLowerCase())) return true;
      if (['false', 'no', '0', 'off'].includes(value.toLowerCase())) return false;
      throw new SettingError('setting-not-boolean', { name, value });
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n) || (spec.min !== undefined && n < spec.min)) {
        throw new SettingError('setting-not-number', { name, value, min: spec.min ?? 0 });
      }
      return n;
    }
    case 'enum': {
      if (!spec.choices.includes(value)) {
        throw new SettingError('setting-not-choice', { name, value, choices: spec.choices.join(', ') });
      }
      return value;
    }
    case 'proxy': {
      try {
        parseProxy(value);
      } catch {
        throw new SettingError('setting-not-proxy', { name, value: redactUrlValue(value) });
      }
      return value;
    }
    case 'file': {
      readable(value, name);
      return value;
    }
    case 'dir': {
      const st = statOrThrow(value, name);
      if (!st.isDirectory()) throw new SettingError('setting-not-dir', { name, value });
      return value;
    }
    default:
      if (!value) throw new SettingError('setting-empty', { name });
      return value;
  }
}

function statOrThrow(path, name) {
  try {
    return statSync(path);
  } catch {
    throw new SettingError('setting-missing-path', { name, value: path });
  }
}

function readable(path, name) {
  const st = statOrThrow(path, name);
  if (st.isDirectory()) throw new SettingError('setting-not-file', { name, value: path });
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new SettingError('setting-unreadable', { name, value: path });
  }
}

/** Пароль из URL убираем до того, как он попадёт в сообщение об ошибке. */
function redactUrlValue(value) {
  return String(value).replace(/(:\/\/[^:/@]+:)[^@]*@/, '$1***@');
}

/** Показываемое значение: секрет — только длиной, чтобы отличить «задан» от «пуст». */
export function displayValue(name, value, t) {
  if (value === null || value === undefined) return t('config.unset');
  if (!SETTINGS[name]?.secret) return String(value);
  if (name === 'proxy') return redactUrlValue(String(value));
  return t('config.secret', { n: String(value).length });
}

/**
 * Запись конфига: временный файл рядом, fsync и переименование.
 *
 * Иначе прерванная запись оставляет обрезанный JSON, и следующий запуск
 * падает на разборе — на сервере, куда за этим и пришли.
 */
export function writeConfig(path, data) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  // 0600: в конфиге лежат токен бота и пароль прокси.
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

export function setSetting(name, raw, { path = CONFIG_PATH } = {}) {
  const value = parseSetting(name, raw);
  const file = readConfigFile(path);
  const next = { ...file, [settingKey(name)]: value };
  writeConfig(path, next);
  return { key: settingKey(name), value };
}

export function unsetSetting(name, { path = CONFIG_PATH } = {}) {
  if (!SETTINGS[name]) throw new SettingError('setting-unknown', { name });
  const file = readConfigFile(path);
  const key = settingKey(name);
  const had = Object.hasOwn(file, key);
  delete file[key];
  writeConfig(path, file);
  return { key, had, value: DEFAULTS[key] ?? null };
}
