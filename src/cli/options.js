import { parseArgs } from 'node:util';
import { COMMAND_NAMES, COMMANDS, DEFAULT_COMMAND, parseArgsOptions } from './registry.js';

export { COMMAND_NAMES, COMMANDS, DEFAULT_COMMAND };

export function parseCli(argv, { t } = {}) {
  const { values, positionals } = parseArgs({
    args: argv, options: parseArgsOptions(), allowPositionals: true, strict: true,
  });

  let command = positionals[0];
  let topic = positionals[1] ?? null;

  if (command === 'help') { topic = positionals[1] ?? null; command = 'help'; }
  else if (values.help) { topic = command ?? null; command = 'help'; }
  else if (values.version || command === 'version') command = 'version';
  else if (!command) command = DEFAULT_COMMAND;
  else if (!COMMAND_NAMES.includes(command)) {
    const list = COMMAND_NAMES.join(', ');
    throw new Error(t ? t('error.unknownCommand', { command, list }) : `unknown command: ${command}. Available: ${list}`);
  }

  return {
    command,
    topic,
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
      events: values.events,
      plain: values.plain,
      noColor: values['no-color'],
      explainConfig: values['explain-config'],
      configPath: values.config ?? null,
      yes: values.yes,
    },
  };
}
