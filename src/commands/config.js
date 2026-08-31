import { SETTINGS, SETTING_NAMES, settingKey, displayValue, setSetting, unsetSetting, SettingError } from '../cli/settings.js';
import { width, pad } from '../render/format.js';
import { EXIT } from '../plan/planner.js';

/**
 * Настройки командой, а не редактором.
 *
 * Смысл не в удобстве: конфиг лежит в /etc с правами 0600 и содержит пароль
 * прокси и токен бота. Править его руками — значит однажды оставить его
 * читаемым всем, записать невалидный JSON или обнаружить опечатку в адресе
 * прокси посреди апгрейда.
 *
 * Колонка «источник» здесь та же, что в `--explain-config`: половина
 * обращений «оно не видит мою настройку» закрывается тем, что видно —
 * значение пришло из env, а под sudo окружение другое.
 */
export async function commandConfig(ctx) {
  const { t, config, sources, flags, paint } = ctx;
  const [action = 'list', name, ...rest] = ctx.args ?? [];
  const path = flags.configPath ?? config.configPath;

  try {
    if (action === 'list') return list(ctx, path);
    if (action === 'get') return get(ctx, name);
    if (action === 'set') return set(ctx, name, rest.join(' '), path);
    if (action === 'unset') return unset(ctx, name, path);
    return fail(t, 'config.badAction', { action, actions: 'list, get, set, unset' });
  } catch (err) {
    if (err instanceof SettingError) {
      return {
        code: EXIT.ERROR, errorCode: err.code,
        lines: ['', ` ${paintOr(paint, 'error', t(`error.setting.${err.code}`, err.params))}`, ''],
      };
    }
    throw err;
  }
}

const paintOr = (paint, role, text) => (paint ? paint(role, text) : text);

function list(ctx, path) {
  const { t, config, sources, paint } = ctx;
  const w = width(SETTING_NAMES) + 2;
  const lines = ['', ` ${paintOr(paint, 'dim', path)}`, ''];
  for (const name of SETTING_NAMES) {
    const key = settingKey(name);
    const shown = displayValue(name, config[key], t);
    lines.push(`   ${pad(name, w)}${pad(shown, 34)}${paintOr(paint, 'dim', `← ${sourceLabel(sources?.[key], t)}`)}`);
  }
  lines.push('', ` ${t('config.hint')}`, '');
  return { code: EXIT.CURRENT, lines, result: { path, settings: dump(ctx) } };
}

function get(ctx, name) {
  const { t, config, sources, flags } = ctx;
  if (!name || !SETTINGS[name]) return fail(t, 'config.unknown', { name: name ?? '—', names: SETTING_NAMES.join(', ') });
  const key = settingKey(name);
  const shown = displayValue(name, config[key], t);
  // --quiet печатает только значение: это то, что уходит в скрипт.
  const lines = flags.quiet ? [shown] : ['', `   ${shown}`, `   ${t('config.from', { source: sourceLabel(sources?.[key], t) })}`, ''];
  return { code: EXIT.CURRENT, lines, result: { path: ctx.config.configPath, settings: { [name]: shown } } };
}

function set(ctx, name, raw, path) {
  const { t, paint } = ctx;
  if (!name) return fail(t, 'config.unknown', { name: '—', names: SETTING_NAMES.join(', ') });
  if (!raw) return fail(t, 'config.needsValue', { name });
  const { key } = setSetting(name, raw, { path });
  const shown = displayValue(name, raw, t);
  return {
    code: EXIT.CURRENT,
    lines: ['', ` ${paintOr(paint, 'ok', t('config.saved', { name, value: shown }))}`,
      ` ${paintOr(paint, 'dim', path)}`, '', ...advice(ctx, name)],
    result: { path, settings: { [key]: shown } },
  };
}

function unset(ctx, name, path) {
  const { t, paint } = ctx;
  const { key, had } = unsetSetting(name, { path });
  return {
    code: EXIT.CURRENT,
    lines: ['', ` ${paintOr(paint, had ? 'ok' : 'dim', t(had ? 'config.removed' : 'config.wasUnset', { name }))}`, ''],
    result: { path, settings: { [key]: null } },
  };
}

/** После записи прокси имеет смысл ровно одно действие — проверить его. */
function advice(ctx, name) {
  if (!['proxy', 'proxy-ca', 'proxy-all-apt'].includes(name)) return [];
  return [` ${ctx.t('config.checkProxy')}`, '   gitlab-upgrade proxy test', ''];
}

const dump = ({ t, config }) => Object.fromEntries(
  SETTING_NAMES.map((n) => [n, displayValue(n, config[settingKey(n)], t)]),
);

function sourceLabel(source, t) {
  if (!source) return t('source.default');
  const key = `source.${String(source).split(' ')[0]}`;
  return t.has(key) ? `${t(key)}${source.startsWith('env ') ? ` ${source.slice(4)}` : ''}` : source;
}

const fail = (t, key, params) => ({
  code: EXIT.ERROR, errorCode: 'config-bad-request',
  lines: ['', ` ${t(key, params)}`, ''],
});
