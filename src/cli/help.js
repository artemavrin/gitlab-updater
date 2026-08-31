import { COMMANDS, COMMAND_NAMES, FLAGS, GROUP, flagsOf, DEFAULT_COMMAND } from './registry.js';
import { pad, width } from '../render/format.js';

const flagLabel = (name, def) => {
  const dashes = `--${name}`;
  const short = def.short ? `-${def.short}, ` : '';
  const value = def.value ? ` <${def.value}>` : '';
  return `${short}${dashes}${value}`;
};

function flagBlock(t, names, indent = '  ') {
  const defs = names.map((n) => ({ name: n, ...FLAGS[n] })).filter((d) => d.type);
  if (!defs.length) return [];
  const labels = defs.map((d) => flagLabel(d.name, d));
  const w = width(labels) + 2;
  return defs.map((d, i) => `${indent}${pad(labels[i], w)}${t(`flag.${d.name}.desc`)}`);
}

/** Общая справка. Список флагов собирается из реестра — разъехаться не с чем. */
export function renderHelp(t) {
  const lines = [t('help.tagline'), '', `  gitlab-upgrade [${t('help.word.command')}] [${t('help.word.options')}]`, ''];

  lines.push(t('help.section.commands'));
  const names = COMMAND_NAMES.filter((n) => n !== 'help');
  const labels = names.map((n) => (n === DEFAULT_COMMAND ? `${n} (${t('help.default')})` : n));
  const w = width(labels) + 2;
  names.forEach((n, i) => lines.push(`  ${pad(labels[i], w)}${t(`cmd.${n}.summary`)}`));
  lines.push(`  ${pad('help [' + t('help.word.command') + ']', w)}${t('cmd.help.summary')}`);
  lines.push('');

  for (const group of [GROUP.TARGET, GROUP.NETWORK, GROUP.OUTPUT, GROUP.OTHER]) {
    const names = Object.entries(FLAGS).filter(([, d]) => d.group === group).map(([n]) => n);
    const block = flagBlock(t, names);
    if (!block.length) continue;
    lines.push(t(`help.section.${group}`), ...block, '');
  }

  lines.push(t('help.exits'), '');
  lines.push(t('help.agents'));
  return lines;
}

/** Справка по одной команде: что делает, меняет ли что-то, чем управляется, чем отвечает. */
export function renderCommandHelp(t, name) {
  const cmd = COMMANDS[name];
  if (!cmd) return [t('error.unknownCommand', { command: name, list: COMMAND_NAMES.join(', ') })];

  // Форма позиционных аргументов приходит из локали: `config set <ключ>`
  // без неё пришлось бы угадывать по справке.
  const args = COMMANDS[name]?.args && t.has(`cmd.${name}.args`) ? ` ${t(`cmd.${name}.args`)}` : '';
  const lines = [`  gitlab-upgrade ${name}${args}`, '', `  ${t(`cmd.${name}.summary`)}`, ''];
  lines.push(`  ${t('help.mutating')}: ${t(cmd.mutating ? 'help.yes' : 'help.no')}`);
  lines.push(`  ${t('help.requiresRoot')}: ${t(cmd.requiresRoot ? 'help.yes' : 'help.no')}`);
  lines.push('');

  const block = flagBlock(t, cmd.flags, '    ');
  if (block.length) lines.push(`  ${t('help.section.options')}`, ...block, '');

  const exits = Object.entries(cmd.exits);
  if (exits.length) {
    lines.push(`  ${t('help.section.exits')}`);
    const w = width(exits.map(([c]) => c)) + 2;
    for (const [code, meaning] of exits) lines.push(`    ${pad(code, w)}${t(`exit.${meaning}`)}`);
    lines.push('');
  }

  if (cmd.result) {
    lines.push(`  ${t('help.section.result')}`);
    const keys = Object.keys(cmd.result);
    const w = width(keys) + 2;
    for (const key of keys) lines.push(`    ${pad(key, w)}${cmd.result[key]} — ${t(`result.${name}.${key}`)}`);
    lines.push('');
  }
  return lines;
}

export { flagsOf };
