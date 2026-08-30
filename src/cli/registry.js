import { EXIT } from '../plan/planner.js';

/**
 * Единственный источник правды о командах и флагах.
 *
 * Из него растут три вещи, которые иначе неизбежно разъедутся:
 * человеческая справка, справка по отдельной команде и машинный каталог
 * для агентов. Тексты здесь не живут — только ключи локалей.
 */

export const GROUP = { TARGET: 'target', NETWORK: 'network', OUTPUT: 'output', OTHER: 'other' };

export const FLAGS = {
  from:              { type: 'string',  group: GROUP.TARGET,  value: 'version' },
  to:                { type: 'string',  group: GROUP.TARGET,  value: 'version' },
  'target-major':    { type: 'string',  group: GROUP.TARGET,  value: 'number' },
  'safe-for-os':     { type: 'boolean', group: GROUP.TARGET },
  'patch-only':      { type: 'boolean', group: GROUP.TARGET },

  proxy:             { type: 'string',  group: GROUP.NETWORK, value: 'url' },
  'proxy-ca':        { type: 'string',  group: GROUP.NETWORK, value: 'path' },
  'proxy-all-apt':   { type: 'boolean', group: GROUP.NETWORK },

  lang:              { type: 'string',  group: GROUP.OUTPUT,  value: 'lang', choices: ['ru', 'en'] },
  json:              { type: 'boolean', group: GROUP.OUTPUT },
  events:            { type: 'boolean', group: GROUP.OUTPUT },
  plain:             { type: 'boolean', group: GROUP.OUTPUT },
  'no-color':        { type: 'boolean', group: GROUP.OUTPUT },
  'explain-config':  { type: 'boolean', group: GROUP.OUTPUT },

  config:            { type: 'string',  group: GROUP.OTHER,   value: 'path' },
  yes:               { type: 'boolean', group: GROUP.OTHER,   short: 'y' },
  help:              { type: 'boolean', group: GROUP.OTHER,   short: 'h' },
  version:           { type: 'boolean', group: GROUP.OTHER,   short: 'v' },
};

const COMMON = ['lang', 'json', 'events', 'plain', 'no-color', 'config', 'help'];
const TARGETING = ['from', 'to', 'target-major', 'safe-for-os', 'patch-only'];
const NETWORKING = ['proxy', 'proxy-ca', 'proxy-all-apt'];

/**
 * `mutating` и `requiresRoot` — не украшение: по ним агент понимает,
 * какую команду можно вызвать безопасно, а какая меняет боевой сервер.
 */
export const COMMANDS = {
  check: {
    mutating: false,
    requiresRoot: true,
    flags: [...TARGETING, ...NETWORKING, ...COMMON],
    exits: { [EXIT.CURRENT]: 'current', [EXIT.PATCH]: 'patch', [EXIT.MINOR]: 'minor', [EXIT.MAJOR]: 'major', [EXIT.ERROR]: 'error' },
    // Только типы: описание полей живёт в локалях под ключом result.<команда>.<поле>
    result: { current: 'string', target: 'string|null', updateKind: 'string|null', profile: 'string', steps: 'number' },
  },
  plan: {
    mutating: false,
    requiresRoot: true,
    flags: [...TARGETING, ...NETWORKING, ...COMMON, 'explain-config'],
    exits: { [EXIT.CURRENT]: 'current', [EXIT.PATCH]: 'patch', [EXIT.MINOR]: 'minor', [EXIT.MAJOR]: 'major', [EXIT.ERROR]: 'error' },
    result: {
      current: 'string', target: 'string|null', updateKind: 'string|null', profile: 'string',
      steps: 'array', limitedBy: 'string|null', policy: 'object|null', os: 'object|null', edition: 'string|null',
    },
  },
  'refresh-path': {
    mutating: false,     // трогает только свой файл данных, не сервер
    requiresRoot: false,
    flags: ['proxy', 'proxy-ca', 'yes', ...COMMON],
    exits: { 0: 'ok', 1: 'error' },
    result: { stops: 'number', added: 'array', removed: 'array', applied: 'boolean' },
  },
  api: {
    mutating: false,
    requiresRoot: false,
    flags: ['lang', 'json', 'help'],
    exits: { 0: 'ok' },
    result: { catalog: 'object' },
  },
  version: { mutating: false, requiresRoot: false, flags: ['json', 'help'], exits: { 0: 'ok' }, result: { version: 'string' } },
  help:    { mutating: false, requiresRoot: false, flags: ['lang', 'json'], exits: { 0: 'ok' }, result: null },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);
export const DEFAULT_COMMAND = 'plan';

export const flagsOf = (command) => (COMMANDS[command]?.flags ?? []).map((n) => ({ name: n, ...FLAGS[n] }));

/** Опции для node:util parseArgs — собираются из реестра, а не дублируются рядом. */
export function parseArgsOptions() {
  const out = {};
  for (const [name, def] of Object.entries(FLAGS)) {
    out[name] = { type: def.type, ...(def.short ? { short: def.short } : {}) };
    if (def.type === 'boolean') out[name].default = false;
  }
  return out;
}
