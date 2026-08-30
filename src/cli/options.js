import { parseArgs } from 'node:util';

export const COMMANDS = ['check', 'plan', 'run', 'resume', 'doctor', 'config', 'version', 'help'];

const OPTIONS = {
  // цель
  from: { type: 'string' },
  to: { type: 'string' },
  'target-major': { type: 'string' },
  'safe-for-os': { type: 'boolean', default: false },
  'patch-only': { type: 'boolean', default: false },
  // сеть
  proxy: { type: 'string' },
  'proxy-ca': { type: 'string' },
  'proxy-all-apt': { type: 'boolean', default: false },
  // вывод
  lang: { type: 'string' },
  json: { type: 'boolean', default: false },
  plain: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  'explain-config': { type: 'boolean', default: false },
  // прочее
  config: { type: 'string' },
  yes: { type: 'boolean', short: 'y', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

export function parseCli(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  let command = positionals[0];
  if (values.help || command === 'help') command = 'help';
  else if (values.version || command === 'version') command = 'version';
  else if (!command) command = 'default';
  else if (!COMMANDS.includes(command)) {
    throw new Error(`неизвестная команда: ${command}. Доступны: ${COMMANDS.join(', ')}`);
  }
  return {
    command,
    rest: positionals.slice(1),
    flags: {
      from: values.from ?? null,
      to: values.to ?? null,
      targetMajor: values['target-major'] ?? null,
      safeForOs: values['safe-for-os'],
      patchOnly: values['patch-only'],
      proxy: values.proxy ?? null,
      proxyCa: values['proxy-ca'] ?? null,
      proxyAllApt: values['proxy-all-apt'],
      lang: values.lang ?? null,
      json: values.json,
      plain: values.plain,
      noColor: values['no-color'],
      explainConfig: values['explain-config'],
      configPath: values.config ?? null,
      yes: values.yes,
    },
  };
}
