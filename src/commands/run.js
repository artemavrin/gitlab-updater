import { join } from 'node:path';
import { acquireLock, LockedError } from '../core/lock.js';
import { saveState, clearState, loadState, reconcile } from '../core/state.js';
import { runChecks, DEPTH, blocked } from '../checks/index.js';
import { LEVEL } from '../core/events.js';
import { runBackup, MODE as BACKUP } from '../steps/backup.js';
import { installVersion, predownload, updateLists, holdArgv, releaseHold } from '../steps/install.js';
import { waitServices, waitMigrations, MigrationsFailed } from '../steps/settle.js';
import { detectGitlab } from '../detect/gitlab.js';
import { policyFor, EXIT } from '../plan/planner.js';
import { renderFindings } from './doctor.js';
import { commandCheck } from './check.js';

/**
 * Режим бэкапа шага. `first-full` означает «полный только первый»: делать
 * полный на каждом из восьми шагов — это восемь раз по восемьдесят минут
 * и восемь копий блобов, которые апгрейд не трогает.
 */
export function backupModeFor(policy, stepIndex) {
  if (policy === 'none') return BACKUP.NONE;
  if (policy === 'first-full') return stepIndex === 0 ? BACKUP.FULL : BACKUP.FAST;
  return BACKUP.DB;
}
/** YYYYMMDD-HHMMSS: срез по ISO-строке резал бы посреди секунд. */
const defaultStamp = (d = new Date()) => {
  const [date, time] = d.toISOString().split('T');
  return `${date.replaceAll('-', '')}-${time.slice(0, 8).replaceAll(':', '')}`;
};

/**
 * Выполнение пути.
 *
 * Порядок внутри шага зафиксирован и не переставляется: бэкап строго до
 * установки, ожидание миграций строго до следующего шага. Каждая фаза
 * записывается в state до того, как начнётся следующая, — иначе после
 * kill -9 невозможно понять, что уже сделано.
 */
export async function commandRun(ctx, { resuming = false } = {}) {
  const { t, flags, config, exec, bus } = ctx;
  // Часы, сон и метка времени внедряются: иначе тест на многочасовое
  // ожидание миграций сам шёл бы многочасово.
  const stamp = ctx.stamp ?? defaultStamp;
  const settle = ctx.settle ?? {};
  // В dry-run изменяющие команды не выполняются — значит и состояние
  // прерванного запуска трогать нельзя: перезапись убила бы чужой resume.
  const dry = Boolean(flags.dryRun);
  const persist = (patch) => { if (!dry) saveState(config.stateDir, patch); };
  const forget = () => { if (!dry) clearState(config.stateDir); };
  const lines = [];

  let lock;
  try {
    lock = acquireLock(join(config.stateDir, 'lock'));
  } catch (err) {
    if (err instanceof LockedError) {
      return { code: EXIT.ERROR, errorCode: 'already-running', lines: [t('run.locked', { pid: err.pid })] };
    }
    throw err;
  }

  try {
    const probe = await commandCheck(ctx);
    if (probe.code === EXIT.ERROR) return probe;
    const plan = probe.plan;

    const saved = resuming ? loadState(config.stateDir) : { state: null };
    if (resuming) {
      if (saved.error) return { code: EXIT.ERROR, errorCode: saved.error, lines: [t(`run.${saved.error}`)] };
      if (!saved.state) return { code: EXIT.ERROR, errorCode: 'no-state', lines: [t('run.no-state')] };
      const actual = await detectGitlab(exec).catch(() => null);
      const check = reconcile(saved.state, actual ? { version: actual.aptVersion, edition: actual.edition } : null);
      if (!check.ok) {
        // Продолжать по сохранённому плану нельзя: он рассчитан не от той версии.
        return {
          code: EXIT.ERROR, errorCode: `resume-${check.reason}`,
          lines: [t(`run.resume.${check.reason}`, check), '', `   ${t('run.resume.hint', { version: check.actual ?? '' })}`],
          result: { reconcile: check, state: saved.state },
        };
      }
    }

    // При resume ведёт сохранённое состояние: свежий план может оказаться
    // пустым, если нас убили после установки последнего шага, — а миграции
    // тогда ещё не дождались и пакет не закреплён.
    const unfinished = resuming && saved.state && saved.state.stepIndex < saved.state.steps.length;
    if (!plan.steps.length && !unfinished) {
      if (resuming && !flags.dryRun) clearState(config.stateDir);
      return {
        code: EXIT.CURRENT, lines: [t('plan.nothing')],
        result: { target: plan.current.raw, steps: 0, backups: [] },
      };
    }

    // При resume ведёт сохранённый профиль. Свежий план может схлопнуться
    // до `current` — и тогда политика дала бы backup: 'none', то есть
    // оставшиеся шаги поставились бы вообще без бэкапа.
    const profile = (resuming && saved.state?.profile) || plan.profile;
    const stepCount = (resuming && saved.state?.steps.length) || plan.steps.length;
    const policy = policyFor(profile);
    const depth = stepCount > 1 ? DEPTH.FULL : DEPTH.FAST;
    const checks = await runChecks({
      ...ctx, plan,
      uid: ctx.uid ?? process.getuid?.() ?? 0,
      env: ctx.env ?? process.env,
      isTty: ctx.isTty ?? Boolean(process.stdout.isTTY),
      minFreeGb: Number(flags.minFreeGb ?? config.minFreeGb ?? 5),
      safeForOs: flags.safeForOs,
    }, { depth });

    lines.push('', ...renderFindings(t, checks.findings), '', `   ${t('doctor.summary', checks)}`, '');
    if (blocked(checks)) {
      lines.push(` ${t('doctor.blocked')}`, '');
      return { code: EXIT.ERROR, errorCode: 'checks-failed', lines, result: { checks } };
    }
    // Незавершённые миграции при resume — ровно то состояние, ради выхода
    // из которого resume и запускают. Требовать за него --force бессмысленно.
    const blocking = checks.findings.filter((f) =>
      f.level === LEVEL.WARN && !(resuming && f.id === 'migrations-pending'));
    if (blocking.length && !flags.force) {
      lines.push(` ${t('doctor.warned')}`, '');
      return { code: EXIT.ERROR, errorCode: 'warnings-not-accepted', lines, result: { checks } };
    }

    if (!flags.yes && !dry) {
      lines.push(` ${t('run.needsYes')}`, '');
      return { code: EXIT.ERROR, errorCode: 'confirmation-required', lines, result: { steps: plan.steps.length } };
    }

    // Ставить gitlab-ee поверх CE — потеря инстанса. Пакет берём из состояния,
    // затем из dpkg, и только потом выводим из редакции; неизвестность — отказ.
    const pkg = saved.state?.pkg
      ?? ctx.gitlabInfo?.package
      ?? (ctx.gitlabInfo?.edition ? `gitlab-${ctx.gitlabInfo.edition}` : null);
    if (!pkg) {
      return { code: EXIT.ERROR, errorCode: 'package-unknown', lines: [t('run.package-unknown')] };
    }
    const state = saved.state ?? {
      startedAt: new Date().toISOString(),
      pkg, edition: ctx.gitlabInfo?.edition ?? null,
      from: plan.current.raw, target: plan.target.raw, profile: plan.profile,
      steps: plan.steps.map((s) => ({ version: s.raw, reason: s.reason })),
      stepIndex: 0, phase: 'backup',
      expectedVersion: ctx.gitlabInfo?.aptVersion ?? plan.current.raw,
      backups: [], pid: process.pid,
    };

    const runStarted = Date.now();
    bus?.emit({ t: 'run:start', steps: state.steps.length, profile, resuming, from: state.from, target: state.target });

    // Прошлый успешный запуск оставил apt-mark hold; без снятия apt-get install
    // падает уже после того, как бэкап сделан.
    await releaseHold(exec, pkg);
    await updateLists(exec, ctx.confPath ?? null);

    if (policy.predownload && state.stepIndex === 0) {
      await predownload({ exec, bus, pkg, versions: state.steps.map((s) => s.version), confPath: ctx.confPath ?? null });
    }

    for (let i = state.stepIndex; i < state.steps.length; i++) {
      const step = state.steps[i];
      bus?.emit({ t: 'step:start', index: i + 1, of: state.steps.length, version: step.version });

      // Первый бэкап полный, дальше дешёвые: апгрейд меняет базу и код,
      // а блобы шаги не трогают.
      const mode = backupModeFor(policy.backup, i);
      state.phase = 'backup';
      persist({ ...state, stepIndex: i });
      const backup = await runBackup({
        exec, bus, mode, backupDir: config.backupDir, hook: flags.backupHook ?? config.backupHook ?? null, stamp: stamp(),
      });
      if (backup.configDir) {
        state.backups.push({
          step: step.version, configDir: backup.configDir,
          dumpDir: backup.dumpDir, archive: backup.archive, at: new Date().toISOString(),
        });
      }

      // installing фиксируется ДО установки: между началом и концом dpkg
      // на диске может быть любая из двух версий, и resume обязан принять обе.
      state.phase = 'install';
      state.installing = step.version;
      persist({ ...state, stepIndex: i });
      await installVersion({ exec, bus, pkg, version: step.version, confPath: ctx.confPath ?? null });

      state.phase = 'settle';
      state.expectedVersion = step.version;
      state.installing = null;
      persist({ ...state, stepIndex: i });

      // Ожидания — читающие операции, поэтому dry-режим exec их не пропускает:
      // предпросмотр честно ждал бы миграции до 72 часов. Пропускаем явно.
      if (!dry) {
        const services = await waitServices({ exec, bus, ...settle });
        if (!services.ok) {
          return stop(t, lines, 'services-down', { step: step.version, running: services.running, total: services.total }, state, bus);
        }
        const migrations = await waitMigrations({ exec, bus, version: step.version, ...settle });
        if (!migrations.ok) {
          return stop(t, lines, 'migrations-timeout', { step: step.version }, state, bus);
        }
      }

      state.stepIndex = i + 1;
      state.phase = 'done-step';
      persist(state);
      bus?.emit({ t: 'step:done', index: i + 1, of: state.steps.length, version: step.version });
    }

    if (!dry) await exec(holdArgv(pkg));
    forget();
    bus?.emit({ t: 'run:done', target: state.target, elapsedMin: Math.round((Date.now() - runStarted) / 60_000) });

    if (dry) {
      // Предпросмотр не должен читаться как завершённое обновление.
      lines.push(` ${t('run.dryDone', { target: state.target, steps: state.steps.length })}`, '');
      return { code: EXIT.CURRENT, lines, result: { target: state.target, steps: 0, backups: [] } };
    }

    lines.push(` ${t('run.done', { target: state.target, steps: state.steps.length })}`, '');
    if (state.backups.length) {
      // Каталог дампа читается из gitlab.rb: называть свой, где дампа нет, —
      // худший вид неправды в разговоре про бэкапы.
      const dumps = [...new Set(state.backups.map((b) => b.dumpDir).filter(Boolean))].join(', ');
      lines.push(`   ${t('run.backups', { n: state.backups.length, dir: dumps || config.backupDir })}`, '');
      lines.push(`   ${t('run.configs', { dir: config.backupDir })}`, '');
    }
    lines.push(`   ${t('run.held', { pkg })}`, '');
    return { code: EXIT.CURRENT, lines, result: { target: state.target, steps: state.steps.length, backups: state.backups } };
  } catch (err) {
    if (err instanceof MigrationsFailed) {
      bus?.emit({ t: 'run:stopped', reason: 'migrations-failed', detail: err.message, version: null, backup: null });
      return { code: EXIT.ERROR, errorCode: 'migrations-failed', lines: [...lines, ` ${t('run.stop.migrations-failed', { n: err.count })}`, '', `   ${t('run.stop.resumeHint')}`] };
    }
    // Падение apt-get или gitlab-backup — самый вероятный исход, и именно
    // там подсказка про resume нужнее всего. Терять её в общем обработчике
    // значит бросать человека с состоянием на диске и без объяснений.
    bus?.emit({ t: 'run:stopped', reason: 'step-failed', detail: err.message, version: null, backup: null });
    return {
      code: EXIT.ERROR, errorCode: 'step-failed', detail: err.message,
      lines: [...lines, ` ${t('run.stop.step-failed', { detail: err.message })}`, '', `   ${t('run.stop.resumeHint')}`],
    };
  } finally {
    lock.release();
  }
}

function stop(t, lines, reason, params, state, bus) {
  bus?.emit({
    t: 'run:stopped', reason, version: params.step ?? null,
    backup: state.backups.at(-1)?.configDir ?? null, detail: '',
  });
  return {
    code: EXIT.ERROR,
    errorCode: reason,
    lines: [...lines, ` ${t(`run.stop.${reason}`, params)}`, '', `   ${t('run.stop.resumeHint')}`],
    result: { stoppedAt: state.stepIndex, phase: state.phase, backups: state.backups },
  };
}

export const commandResume = (ctx) => commandRun(ctx, { resuming: true });
