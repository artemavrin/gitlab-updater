import { COMMANDS, COMMAND_NAMES, FLAGS, DEFAULT_COMMAND } from './registry.js';
import { LOCALES, DEFAULT_LOCALE } from '../i18n/index.js';

const errorCodeKeys = () => Object.keys(LOCALES[DEFAULT_LOCALE])
  .filter((k) => k.startsWith('error.code.'))
  .map((k) => k.slice('error.code.'.length))
  .sort();

/**
 * Машинный каталог для агентов: `gitlab-upgrade api` либо `--help --json`.
 *
 * Ключи (`id`, `code`, имена команд и флагов) стабильны и не переводятся —
 * агент опирается на них. Переводится только `summary`, чтобы агент мог
 * показать человеку понятный текст, не выдумывая его сам.
 */
export function buildCatalog(t, { version }) {
  return {
    tool: 'gitlab-upgrade',
    version,
    contract: 1,
    locale: t.locale,
    defaultCommand: DEFAULT_COMMAND,
    usage: {
      workflow: ['check', 'plan', 'run'],
      readOnly: COMMAND_NAMES.filter((n) => !COMMANDS[n].mutating),
      mutating: COMMAND_NAMES.filter((n) => COMMANDS[n].mutating),
      notes: [t('api.note.exitCodes'), t('api.note.envelope'), t('api.note.events'), t('api.note.ids')],
    },
    // Список выводится из локалей, а не дублируется здесь: захардкоженный
    // перечень молча отстал бы от кодов, которые команды реально возвращают.
    errorCodes: Object.fromEntries(errorCodeKeys().map((code) => [code, t(`error.code.${code}`)])),
    envelope: {
      tool: 'string', version: 'string', command: 'string',
      ok: 'boolean', exit: 'number',
      result: 'object|null', findings: 'array', error: 'object|null',
    },
    commands: Object.fromEntries(COMMAND_NAMES.map((name) => {
      const c = COMMANDS[name];
      return [name, {
        summary: t(`cmd.${name}.summary`),
        mutating: c.mutating,
        requiresRoot: c.requiresRoot,
        flags: c.flags.map((f) => ({
          name: f,
          type: FLAGS[f].type,
          ...(FLAGS[f].value ? { value: FLAGS[f].value } : {}),
          ...(FLAGS[f].choices ? { choices: FLAGS[f].choices } : {}),
          description: t(`flag.${f}.desc`),
        })),
        exits: Object.fromEntries(Object.entries(c.exits).map(([code, meaning]) => [code, { id: meaning, description: t(`exit.${meaning}`) }])),
        result: c.result && Object.fromEntries(Object.entries(c.result).map(
          ([field, type]) => [field, { type, description: t(`result.${name}.${field}`) }])),
      }];
    })),
  };
}
