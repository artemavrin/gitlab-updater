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
  'probe-host':      { type: 'string',  group: GROUP.NETWORK, value: 'host' },
  'probe-timeout':   { type: 'string',  group: GROUP.NETWORK, value: 'ms' },

  'min-free-gb':     { type: 'string',  group: GROUP.TARGET,  value: 'number' },
  force:             { type: 'boolean', group: GROUP.TARGET },
  'allow-unsupported-os': { type: 'boolean', group: GROUP.TARGET },
  'backup-dir':      { type: 'string',  group: GROUP.TARGET,  value: 'path' },
  'backup-hook':     { type: 'string',  group: GROUP.TARGET,  value: 'path' },
  'dry-run':         { type: 'boolean', group: GROUP.TARGET },
  detach:            { type: 'boolean', group: GROUP.OTHER },
  notify:            { type: 'boolean', group: GROUP.OUTPUT },
  'no-notify':       { type: 'boolean', group: GROUP.OUTPUT },
  follow:            { type: 'boolean', group: GROUP.OUTPUT,  short: 'f' },
  journal:           { type: 'string',  group: GROUP.OUTPUT,  value: 'path' },

  lang:              { type: 'string',  group: GROUP.OUTPUT,  value: 'lang', choices: ['ru', 'en'] },
  quiet:             { type: 'boolean', group: GROUP.OUTPUT,  short: 'q' },
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
const READINESS = ['min-free-gb', 'force', 'allow-unsupported-os', 'backup-dir', 'backup-hook'];
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
  run: {
    mutating: true,      // единственная команда, которая меняет сервер
    requiresRoot: true,
    flags: [...TARGETING, ...NETWORKING, ...READINESS, 'yes', 'dry-run', 'detach', 'notify', 'no-notify', ...COMMON],
    exits: { 0: 'done', 1: 'error' },
    result: { target: 'string', steps: 'number', backups: 'array' },
  },
  resume: {
    mutating: true,
    requiresRoot: true,
    flags: [...NETWORKING, ...READINESS, 'yes', 'dry-run', 'detach', 'notify', 'no-notify', ...COMMON],
    exits: { 0: 'done', 1: 'error' },
    result: { target: 'string', steps: 'number', backups: 'array' },
  },
  attach: {
    mutating: false,
    requiresRoot: true,
    flags: ['follow', 'journal', ...COMMON],
    exits: { 0: 'ok', 1: 'no-journal' },
    result: { path: 'string', events: 'number' },
  },
  doctor: {
    mutating: false,
    requiresRoot: true,
    flags: [...TARGETING, ...NETWORKING, 'min-free-gb', 'force', ...COMMON],
    exits: { 0: 'ok', 1: 'checks-failed' },
    result: { ok: 'number', warnings: 'number', critical: 'number', blocked: 'boolean', findings: 'array' },
  },
  next: {
    mutating: false,
    requiresRoot: true,
    flags: [...TARGETING, ...NETWORKING, ...COMMON, 'quiet'],
    // У check код описывает весь разрыв до цели, у next — размер ближайшего шага.
    // С 16.3 следующий шаг 16.7 — минорный, хотя весь путь мажорный.
    exits: { [EXIT.CURRENT]: 'step-current', [EXIT.PATCH]: 'step-patch', [EXIT.MINOR]: 'step-minor', [EXIT.MAJOR]: 'step-major', [EXIT.ERROR]: 'error' },
    result: {
      version: 'string|null', current: 'string', remaining: 'number', final: 'boolean',
      reason: 'string|null', stop: 'string|null', conditional: 'boolean',
      note: 'string|null', docs: 'string|null', source: 'string', verifiedAt: 'string',
    },
  },
  plan: {
    mutating: false,
    requiresRoot: true,
    flags: [...TARGETING, ...NETWORKING, ...READINESS, ...COMMON, 'explain-config'],
    // Код 1 означает не «нет плана», а «план есть, но выполнить его нельзя»:
    // проверки готовности не пройдены.
    exits: { [EXIT.CURRENT]: 'current', [EXIT.PATCH]: 'patch', [EXIT.MINOR]: 'minor', [EXIT.MAJOR]: 'major', [EXIT.ERROR]: 'checks-failed' },
    result: {
      current: 'string', target: 'string|null', updateKind: 'string|null', profile: 'string',
      steps: 'array', limitedBy: 'string|null', policy: 'object|null', os: 'object|null', edition: 'string|null',
      checks: 'object',
    },
  },
  'refresh-path': {
    mutating: false,     // трогает только свой файл данных, не сервер
    requiresRoot: false,
    flags: ['proxy', 'proxy-ca', 'yes', 'dry-run', ...COMMON],
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
  config: {
    // Пишет только в свой конфиг, не в систему: сервер от `config set` не
    // меняется, поэтому mutating здесь ложью не будет.
    mutating: false,
    requiresRoot: false,
    args: true,
    flags: ['config', 'lang', 'json', 'quiet', 'no-color', 'help'],
    exits: { 0: 'ok', 1: 'config-bad-request' },
    result: { path: 'string', settings: 'object' },
  },

  'proxy-test': {
    mutating: false,
    // Диагностику запускают до того, как получили sudo, — иначе она бесполезна.
    requiresRoot: false,
    flags: [...NETWORKING, 'probe-host', 'probe-timeout', ...COMMON],
    exits: { 0: 'ok', 1: 'proxy-unreachable' },
    result: { proxy: 'string', ok: 'number', warnings: 'number', critical: 'number', findings: 'array' },
  },

  'notify-chat': {
    mutating: false,
    // Пишет только в свой конфиг, и только с --yes. Токен берётся оттуда же,
    // а не из флага: аргумент командной строки виден в `ps` любому на машине.
    requiresRoot: false,
    flags: ['yes', ...COMMON],
    exits: { 0: 'ok', 1: 'telegram-failed' },
    result: { chats: 'array', configured: 'boolean' },
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
