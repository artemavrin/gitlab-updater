#!/usr/bin/env node
import { parseCli } from '../src/cli/options.js';
import { resolveConfig } from '../src/cli/config.js';
import { renderHelp, renderCommandHelp } from '../src/cli/help.js';
import { buildCatalog } from '../src/cli/catalog.js';
import { ok, fail, serialize } from '../src/cli/envelope.js';
import { createTranslator, resolveLocale } from '../src/i18n/index.js';
import { createExec, MODE } from '../src/core/exec.js';
import { EventBus } from '../src/core/events.js';
import { createJsonRenderer, createPlainRenderer, createAttachRenderer } from '../src/render/plain.js';
import { inkAvailable } from '../src/ui/available.js';
import { printBlockers } from '../src/render/blockers.js';
import { createPainter, wantsColor } from '../src/render/color.js';
import { commandCheck } from '../src/commands/check.js';
import { commandPlan } from '../src/commands/plan.js';
import { commandRefreshPath } from '../src/commands/refreshPath.js';
import { commandProxyTest } from '../src/commands/proxyTest.js';
import { commandConfig } from '../src/commands/config.js';
import { commandNext } from '../src/commands/next.js';
import { commandDoctor } from '../src/commands/doctor.js';
import { commandRun, commandResume } from '../src/commands/run.js';
import { commandAttach, format as formatEvent } from '../src/commands/attach.js';
import { createJournal } from '../src/core/logger.js';
import { createNotifier, channelsFrom } from '../src/notify/index.js';
import { policyFor } from '../src/plan/planner.js';
import { detach } from '../src/core/detach.js';
import { hostname } from 'node:os';
import { detectOs } from '../src/detect/os.js';
import { detectGitlab } from '../src/detect/gitlab.js';
import { EXIT } from '../src/plan/planner.js';
import { writeAptConf, aptConfPath, removeAptConf } from '../src/net/aptProxy.js';

import pkg from '../package.json' with { type: 'json' };
import upgradePath from '../data/upgrade-path.json' with { type: 'json' };
import osMatrix from '../data/os-matrix.json' with { type: 'json' };
import pgRequirements from '../data/pg-requirements.json' with { type: 'json' };

const VERSION = pkg.version;

// `gitlab-upgrade plan | head` закрывает stdout раньше нас — это не ошибка.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
}

const RUNNERS = {
  check: commandCheck, next: commandNext, plan: commandPlan, doctor: commandDoctor,
  run: commandRun, resume: commandResume, attach: commandAttach,
  'refresh-path': commandRefreshPath, 'proxy-test': commandProxyTest, config: commandConfig,
};

const MUTATING = new Set(['run', 'resume']);
const READINESS = new Set(['doctor', 'plan', 'run', 'resume']);

/**
 * Экраны подключаются динамически. В бандле они лежат рядом, а при запуске
 * из исходников Node не умеет .jsx — и тогда работает построчный вывод.
 * Апгрейд на шесть часов не должен падать из-за формы вывода.
 */
async function loadUi() {
  try {
    return await import('../src/ui/render.jsx');
  } catch (err) {
    if (err.code === 'ERR_UNKNOWN_FILE_EXTENSION') return null;
    throw err;
  }
}

const runStamp = () => {
  const [date, time] = new Date().toISOString().split('T');
  return `${date.replaceAll('-', '')}-${time.slice(0, 8).replaceAll(':', '')}`;
};

async function main(argv) {
  const early = createTranslator(resolveLocale({}));
  const { command, topic, flags, args } = parseCli(argv, { t: early });
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
    flags: {
      proxy: flags.proxy, proxyCa: flags.proxyCa, lang: flags.lang,
      // Без этого значение из конфига разрешалось бы, показывалось
      // в --explain-config и молча игнорировалось.
      proxyAllApt: flags.proxyAllApt || undefined,
      backupDir: flags.backupDir ?? undefined,
      backupHook: flags.backupHook ?? undefined,
    },
    path: flags.configPath ?? undefined,
  });

  if (flags.explainConfig) {
    const lines = Object.entries(config).map(([k, v]) => `${k.padEnd(14)} ${String(v ?? '—').padEnd(34)} ← ${sources[k]}`);
    return emit(ok(command, { version: VERSION, result: { config, sources } }), lines);
  }

  const bus = new EventBus();
  const secrets = [config.proxy, config.telegramToken, config.slackWebhook, config.notifyWebhook].filter(Boolean);
  // События идут на stderr, чтобы не смешиваться с результатом на stdout.
  if (flags.events) bus.on(createJsonRenderer({ out: process.stderr, secrets }));

  // Журнал ведётся только для меняющих команд: он и есть то, к чему
  // подключается attach, и то, что остаётся после падения.
  let journal = null;
  let notifier = null;
  if (MUTATING.has(command)) {
    journal = createJournal({ dir: config.logDir, stamp: runStamp(), secrets });
    bus.on(journal.write);

    const wantsNotify = flags.notify ?? config.notify;
    if (wantsNotify) {
      notifier = createNotifier({
        bus, t, host: hostname(),
        channels: channelsFrom(config),
        allowFor: (profile) => policyFor(profile).notify,
        proxy: config.notifyProxy ?? config.proxy, ca: config.proxyCa ?? null,
        onError: (e) => process.stderr.write(t('notify.failed', e) + '\n'),
      });
    }
  }

  // Увод в фон: обрыв SSH на пятом часу миграций не должен губить апгрейд.
  if (flags.detach && MUTATING.has(command)) {
    // Запускаем интерпретатором явно: полагаться на шебанг у скопированного
    // файла нельзя — бит выполнения теряется при scp чаще, чем кажется.
    const r = await detach({
      exec: createExec({ mode: MODE.REAL }),
      argv: [process.execPath, process.argv[1], ...argv],
    });
    const line = r.ok ? t('detach.started', r) : t('detach.unavailable', r);
    return emit(r.ok ? ok(command, { version: VERSION, result: { unit: r.unit } })
                     : fail(command, { version: VERSION, code: 'detach-failed', message: line }), [line]);
  }

  // --dry-run пропускает изменяющие команды, но выполняет читающие:
  // иначе план был бы построен на выдуманных данных.
  const exec = createExec({ mode: flags.dryRun ? MODE.DRY : MODE.REAL, bus, secrets });

  // Прокси обязан реально дойти до apt. Настройки уходят во временный файл,
  // передаваемый через `apt-get -c`, а не в /etc/apt/apt.conf.d/: после kill -9
  // система не остаётся перенастроенной, и пароль не виден в `ps aux`.
  let confPath = null;
  if (config.proxy) {
    try {
      confPath = writeAptConf(aptConfPath(config.stateDir), {
        proxy: config.proxy, all: config.proxyAllApt, ca: config.proxyCa ?? null,
      });
    } catch (err) {
      // Молча ходить мимо прокси нельзя: на закрытом контуре это тихий провал.
      const envelope = fail(command, {
        version: VERSION, exit: EXIT.ERROR,
        code: 'proxy-conf-unwritable', message: t('error.proxyConf', { path: config.stateDir, detail: err.code ?? err.message }),
      });
      return emit(envelope, [t('error.proxyConf', { path: config.stateDir, detail: err.code ?? err.message })]);
    }
  }

  // Цвет решается там, где известен приёмник: команда его не выбирает.
  const paint = createPainter({
    color: wantsColor({ flag: flags.noColor ? false : undefined, stream: process.stdout }) && !flags.json,
  });

  const ctx = {
    exec, t, flags, args, config, sources, bus, confPath, paint,
    data: { upgradePath, osMatrix, pgRequirements },
    osPath: '/etc/os-release',
    dataPath: new URL('../data/upgrade-path.json', import.meta.url).pathname,
  };
  ctx.os = detectOs(ctx.osPath);
  ctx.gitlabInfo = await detectGitlab(exec).catch(() => null);

  if (command === 'attach') {
    // --events отдаёт сырое событие для разбора полётов, обычный вызов —
    // тот же текст, что видел бы человек у работающего апгрейда.
    ctx.render = flags.events
      ? (e) => process.stdout.write(formatEvent(e) + '\n')
      : createAttachRenderer({ t, secrets });
  }

  // Экран включается только там, где он есть. Иначе — построчный вывод на том
  // же потоке событий: `run > log.txt` должен давать лог, а не перерисовки.
  let screen = null;
  if (MUTATING.has(command)) {
    const ui = inkAvailable({ flags }) ? await loadUi() : null;
    if (ui) screen = ui.mountRun({ bus, t, flags });
    else if (!flags.json) bus.on(createPlainRenderer({ t, secrets }));
  }

  let result;
  try {
    result = await RUNNERS[command](ctx);
  } finally {
    // Экран гасим до печати итога: иначе <Static> допишет кадр поверх него.
    await screen?.stop();
    if (confPath) removeAptConf(confPath);
    await notifier?.pending();
  }

  // Блок блокеров отвечает на вопрос «можно ли начать» — и принадлежит
  // только тем командам, которые этот вопрос задают. У `proxy test` вопрос
  // другой: «где рвётся», и там важен порядок рубежей, который блок теряет.
  const findings = READINESS.has(command) ? result.result?.findings ?? null : null;
  const wantsBlockers = Array.isArray(findings) && !flags.json
    && findings.some((f) => f.level === 'critical' || f.level === 'warn');
  if (wantsBlockers) {
    const count = (level) => findings.filter((f) => f.level === level).length;
    printBlockers({
      findings, t, color: flags.noColor ? false : undefined,
      summary: t('doctor.summary', { ok: count('ok'), warnings: count('warn'), critical: count('critical') }),
    });
    // Список уже показан блоком — из строк остаётся вердикт, и только он.
    result = { ...result, lines: result.verdict ? ['', ` ${t(result.verdict)}`] : [] };
  }

  const envelope = result.code === EXIT.ERROR
    ? fail(command, {
        version: VERSION, exit: result.code,
        code: result.errorCode ?? 'precondition-failed',
        // Одна фраза, а не весь отрисованный экран: подробности лежат в
        // result.findings, где их можно разобрать, а не читать глазами.
        message: result.verdict ? t(result.verdict) : result.lines.filter(Boolean).join(' ').trim(),
        detail: result.detail ?? null,
        result: result.result ?? null,
        findings: result.result?.findings ?? [],
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
