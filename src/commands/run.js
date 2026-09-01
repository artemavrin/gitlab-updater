import { join } from 'node:path';
import { acquireLock, LockedError } from '../core/lock.js';
import { saveState, clearState, loadState, reconcile } from '../core/state.js';
import { runChecks, DEPTH, blocked, gate } from '../checks/index.js';
import { execFailure } from '../core/exec.js';
import { saveFailure } from '../core/logger.js';
import { LOG_DIR } from '../cli/config.js';
import { runBackup, MODE as BACKUP } from '../steps/backup.js';
import { installVersion, predownload, updateLists, holdArgv, releaseHold } from '../steps/install.js';
import { waitServices, waitMigrations, MigrationsFailed } from '../steps/settle.js';
import { detectGitlab } from '../detect/gitlab.js';
import { policyFor, EXIT } from '../plan/planner.js';
import { postgresRange, comparePg } from '../plan/matrices.js';
import { parsePgVersion } from '../detect/services.js';
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

    // Находки уезжают в result в той же форме, что у doctor: экран блокеров
    // и агент не должны разбирать две разные структуры.
    const checksResult = {
      ok: checks.ok, warnings: checks.warnings, critical: checks.critical, blocked: blocked(checks),
      findings: checks.findings.map((f) => ({ id: f.id, check: f.check, level: f.level, params: f.params, remedy: f.remedy ?? null })),
    };
    lines.push('', ...renderFindings(t, checks.findings, { paint: ctx.paint }), '', `   ${t('doctor.summary', checks)}`, '');
    const ready = gate(checks, flags, { resuming });
    if (!ready.ok) {
      lines.push(` ${t(ready.verdict)}`, '');
      return { code: EXIT.ERROR, errorCode: ready.reason, lines, verdict: ready.verdict, result: checksResult };
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
    // Версии оставшихся шагов едут в событии: иначе экран пути знает только
    // пройденное и молчит о том, сколько ещё впереди.
    bus?.emit({
      t: 'run:start', steps: state.steps.length, profile, resuming,
      from: state.from, target: state.target,
      versions: state.steps.map((x) => x.version),
    });

    // Прошлый успешный запуск оставил apt-mark hold; без снятия apt-get install
    // падает уже после того, как бэкап сделан.
    await releaseHold(exec, pkg);
    await updateLists(exec, ctx.confPath ?? null, { bus, ...(ctx.settle?.wait ? { wait: ctx.settle.wait, waitMs: 1 } : {}) });

    if (policy.predownload && state.stepIndex === 0) {
      await predownload({ exec, bus, pkg, versions: state.steps.map((s) => s.version), confPath: ctx.confPath ?? null });
    }

    for (let i = state.stepIndex; i < state.steps.length; i++) {
      const step = state.steps[i];
      const stepStarted = Date.now();

      // Барьер PostgreSQL проверяется перед каждым шагом, а не один раз до
      // цикла. На пути с 13.x версия базы меняется под нами: PostgreSQL 13
      // приносит пакет 15.0, PostgreSQL 14 — 17.0. Проверка «на старте»
      // отвечала бы на вопрос, который к восьмому шагу давно устарел, и
      // `--force` отправлял бы apt ставить 16.3 на PostgreSQL 12 посреди
      // многочасового прогона — в самом неудачном месте из возможных.
      //
      // Останов до бэкапа: делать полный бэкап ради шага, который заведомо не
      // выполнится, значит потратить час впустую.
      const need = await pgBarrier({ exec, data: ctx.data, version: step.version, dry });
      if (need) {
        return stop(t, lines, 'postgres-step', { step: step.version, ...need }, state, bus);
      }

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
      // Длительность шага едет в событии, а не считается в каждом рендерере:
      // иначе экран, лог и уведомление назовут три разных числа.
      bus?.emit({
        t: 'step:done', index: i + 1, of: state.steps.length,
        version: step.version, durationMs: Date.now() - stepStarted,
      });
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
    // Что именно ответила команда — единственное, ради чего в эту строку
    // смотрят. Раньше здесь был машинный err.message, и человек оставался с
    // кодом 100 без слова о причине.
    const said = execFailure(err);
    // Одной строки для dpkg и gitaly не хватает: «returned an error code (1)» —
    // это итог, а причина на несколько строк выше. Полный вывод сохраняем и
    // называем файл: без него человеку нечего читать.
    const saved = saveFailure({
      dir: config.logDir ?? LOG_DIR, stamp: stamp(), err, secrets: ctx.secrets ?? [],
    });
    bus?.emit({ t: 'run:stopped', reason: 'step-failed', detail: said, version: null, backup: null });
    return {
      code: EXIT.ERROR, errorCode: 'step-failed', detail: said,
      lines: [...lines,
        ` ${t('run.stop.step-failed', { detail: said })}`,
        ...(saved ? ['', `   ${t('run.stop.output', { path: saved })}`] : []),
        '', `   ${t('run.stop.resumeHint')}`],
    };
  } finally {
    lock.release();
  }
}

/**
 * Требование PostgreSQL для конкретного шага — или null, если оно выполнено.
 *
 * Версию базы читаем заново на каждом шаге: её меняют и сами пакеты по пути,
 * и человек между шагами через `gitlab-ctl pg-upgrade`. Запомненное на старте
 * значение к середине подъёма — просто неправда.
 *
 * Не смогли определить версию — не мешаем: своим незнанием останавливать
 * апгрейд нельзя, а нехватку заметит сам пакет.
 */
async function pgBarrier({ exec, data, version, dry }) {
  const range = postgresRange(data.pgRequirements, version);
  if (!range || dry) return null;
  const r = await exec(['gitlab-psql', '--version'], { readOnly: true, allowFailure: true });
  const have = parsePgVersion(r.stdout);
  if (r.code !== 0 || !have) return null;
  return comparePg(have, range.min) < 0 ? { have, need: range.min } : null;
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
