#!/usr/bin/env node
import { parseCli } from '../src/cli/options.js';
import { resolveConfig } from '../src/cli/config.js';
import { renderHelp, renderCommandHelp } from '../src/cli/help.js';
import { buildCatalog } from '../src/cli/catalog.js';
import { ok, fail, serialize } from '../src/cli/envelope.js';
import { createTranslator, resolveLocale } from '../src/i18n/index.js';
import { createExec, MODE } from '../src/core/exec.js';
import { EventBus } from '../src/core/events.js';
import { createJsonRenderer } from '../src/render/plain.js';
import { commandCheck } from '../src/commands/check.js';
import { commandPlan } from '../src/commands/plan.js';
import { commandRefreshPath } from '../src/commands/refreshPath.js';
import { detectOs } from '../src/detect/os.js';
import { detectGitlab } from '../src/detect/gitlab.js';
import { EXIT } from '../src/plan/planner.js';

import pkg from '../package.json' with { type: 'json' };
import upgradePath from '../data/upgrade-path.json' with { type: 'json' };
import osMatrix from '../data/os-matrix.json' with { type: 'json' };
import pgRequirements from '../data/pg-requirements.json' with { type: 'json' };

const VERSION = pkg.version;

// `gitlab-upgrade plan | head` закрывает stdout раньше нас — это не ошибка.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
}

const RUNNERS = { check: commandCheck, plan: commandPlan, 'refresh-path': commandRefreshPath };

async function main(argv) {
  const early = createTranslator(resolveLocale({}));
  const { command, topic, flags } = parseCli(argv, { t: early });
  const t = createTranslator(resolveLocale({ flag: flags.lang }));
  const emit = (envelope, lines) => {
    process.stdout.write(flags.json ? serialize(envelope) + '\n' : lines.join('\n') + '\n');
    return envelope.exit;
  };

  if (command === 'version') {
    return emit(ok('version', { version: VERSION, result: { version: VERSION } }), [`gitlab-upgrade ${VERSION}`]);
  }

  if (command === 'api' || (command === 'help' && flags.json)) {
    const catalog = buildCatalog(t, { version: VERSION });
    // `api` без --json всё равно отдаёт JSON: команда существует ради машин.
    process.stdout.write(JSON.stringify(catalog, null, 2) + '\n');
    return 0;
  }

  if (command === 'help') {
    return emit(ok('help', { version: VERSION }), topic ? renderCommandHelp(t, topic) : renderHelp(t));
  }

  const { values: config, sources } = resolveConfig({
    flags: { proxy: flags.proxy, proxyCa: flags.proxyCa, lang: flags.lang },
    path: flags.configPath ?? undefined,
  });

  if (flags.explainConfig) {
    const lines = Object.entries(config).map(([k, v]) => `${k.padEnd(14)} ${String(v ?? '—').padEnd(34)} ← ${sources[k]}`);
    return emit(ok(command, { version: VERSION, result: { config, sources } }), lines);
  }

  const bus = new EventBus();
  const secrets = [config.proxy].filter(Boolean);
  // События идут на stderr, чтобы не смешиваться с результатом на stdout.
  if (flags.events) bus.on(createJsonRenderer({ out: process.stderr, secrets }));

  const exec = createExec({ mode: MODE.REAL, bus, secrets });
  const ctx = {
    exec, t, flags, config, bus,
    data: { upgradePath, osMatrix, pgRequirements },
    osPath: '/etc/os-release',
    dataPath: new URL('../data/upgrade-path.json', import.meta.url).pathname,
  };
  ctx.os = detectOs(ctx.osPath);
  ctx.gitlabInfo = await detectGitlab(exec).catch(() => null);

  const result = await RUNNERS[command](ctx);
  const envelope = result.code === EXIT.ERROR
    ? fail(command, {
        version: VERSION, exit: result.code,
        code: result.errorCode ?? 'precondition-failed',
        message: result.lines.filter(Boolean).join(' '),
        detail: result.detail ?? null,
      })
    : ok(command, { version: VERSION, exit: result.code, result: result.result ?? null, findings: result.plan?.findings ?? [] });

  return emit(envelope, result.lines);
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write(`gitlab-upgrade: ${err.message}\n`);
    process.exitCode = EXIT.ERROR;
  });
