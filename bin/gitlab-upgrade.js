#!/usr/bin/env node
import { parseCli } from '../src/cli/options.js';
import { resolveConfig } from '../src/cli/config.js';
import { createTranslator, resolveLocale } from '../src/i18n/index.js';
import { createExec, MODE } from '../src/core/exec.js';
import { EventBus } from '../src/core/events.js';
import { createJsonRenderer } from '../src/render/plain.js';
import { commandCheck } from '../src/commands/check.js';
import { commandPlan } from '../src/commands/plan.js';
import { detectOs } from '../src/detect/os.js';
import { detectGitlab } from '../src/detect/gitlab.js';
import { EXIT } from '../src/plan/planner.js';

// `gitlab-upgrade plan | head` закрывает stdout раньше нас — это не ошибка.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
}

// JSON импортируется, а не читается с диска: так esbuild инлайнит данные
// в единственный файл, который уезжает на сервер.
import pkg from '../package.json' with { type: 'json' };
import upgradePath from '../data/upgrade-path.json' with { type: 'json' };
import osMatrix from '../data/os-matrix.json' with { type: 'json' };
import pgRequirements from '../data/pg-requirements.json' with { type: 'json' };

const VERSION = pkg.version;

async function main(argv) {
  const { command, flags } = parseCli(argv);
  const t = createTranslator(resolveLocale({ flag: flags.lang }));

  if (command === 'help') { process.stdout.write(t('help.text')); return 0; }
  if (command === 'version') { process.stdout.write(`gitlab-upgrade ${VERSION}\n`); return 0; }

  const { values: config, sources } = resolveConfig({
    flags: { proxy: flags.proxy, proxyCa: flags.proxyCa, lang: flags.lang },
    path: flags.configPath ?? undefined,
  });

  if (flags.explainConfig) {
    for (const [k, v] of Object.entries(config)) {
      process.stdout.write(`${k.padEnd(14)} ${String(v ?? '—').padEnd(34)} ← ${sources[k]}\n`);
    }
    return 0;
  }

  const bus = new EventBus();
  const secrets = [config.proxy].filter(Boolean);
  if (flags.json) bus.on(createJsonRenderer({ secrets }));

  const exec = createExec({ mode: MODE.REAL, bus, secrets });
  const data = { upgradePath, osMatrix, pgRequirements };

  const ctx = { exec, t, flags, config, data, bus, osPath: '/etc/os-release' };
  ctx.os = detectOs(ctx.osPath);
  ctx.gitlabInfo = await detectGitlab(exec).catch(() => null);

  const run = command === 'check' ? commandCheck : commandPlan;
  const result = await run(ctx);
  if (!flags.json) process.stdout.write(result.lines.join('\n') + '\n');
  return result.code;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write(`gitlab-upgrade: ${err.message}\n`);
    process.exitCode = EXIT.ERROR;
  });
