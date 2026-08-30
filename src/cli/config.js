import { readFileSync } from 'node:fs';

export const CONFIG_PATH = '/etc/gitlab-upgrade/config.json';
export const STATE_DIR = '/var/lib/gitlab-upgrade';
export const LOG_DIR = '/var/log/gitlab-upgrade';

/**
 * Приоритет источников: флаг > env > конфиг > дефолт.
 *
 * Конфиг лежит в /etc, а не в ~/.config: инструмент запускается через sudo,
 * и ~ под sudo — это /root, из-за чего настройки «пропадают».
 */
const ENV_KEYS = {
  proxy: 'GITLAB_UPGRADE_PROXY',
  proxyCa: 'GITLAB_UPGRADE_PROXY_CA',
  lang: 'GITLAB_UPGRADE_LANG',
  backupDir: 'GITLAB_UPGRADE_BACKUP_DIR',
  telegramToken: 'TELEGRAM_BOT_TOKEN',
  telegramChat: 'TELEGRAM_CHAT_ID',
  slackWebhook: 'SLACK_WEBHOOK_URL',
  notifyWebhook: 'NOTIFY_WEBHOOK_URL',
};

export const DEFAULTS = {
  proxy: null,
  proxyCa: null,
  proxyAllApt: false,
  lang: null,
  backupDir: '/var/opt/gitlab/backups',
  backupHook: null,
  telegramToken: null,
  telegramChat: null,
  slackWebhook: null,
  notifyWebhook: null,
  notify: true,
  minFreeGb: 5,
  configPath: CONFIG_PATH,
  stateDir: STATE_DIR,
  logDir: LOG_DIR,
};

export function readConfigFile(path = CONFIG_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`config-unreadable path=${path} detail=${err.message}`);
  }
}

/** Возвращает и значения, и источник каждого — это и есть --explain-config. */
export function resolveConfig({ flags = {}, env = process.env, file = null, path = CONFIG_PATH } = {}) {
  const fromFile = file ?? readConfigFile(path);
  const values = {};
  const sources = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (flags[key] !== undefined && flags[key] !== null) { values[key] = flags[key]; sources[key] = 'flag'; continue; }
    const envKey = ENV_KEYS[key];
    if (envKey && env[envKey]) { values[key] = env[envKey]; sources[key] = `env ${envKey}`; continue; }
    if (fromFile[key] !== undefined) { values[key] = fromFile[key]; sources[key] = 'config'; continue; }
    values[key] = DEFAULTS[key];
    sources[key] = 'default';
  }
  return { values, sources };
}
