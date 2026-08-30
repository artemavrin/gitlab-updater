import { runChecks, DEPTH, blocked } from '../checks/index.js';
import { LEVEL } from '../core/events.js';
import { table } from '../render/format.js';
import { EXIT } from '../plan/planner.js';
import { commandCheck } from './check.js';

const MARK = { [LEVEL.OK]: '✓', [LEVEL.WARN]: '!', [LEVEL.CRITICAL]: '✗' };

export function renderFindings(t, findings) {
  return table(findings.map((f) => [
    MARK[f.level] ?? '?',
    t(`check.${f.check}.title`),
    t(`check.${f.id}.${f.level}`, f.params),
  ]), { indent: '   ' });
}

/**
 * Готов ли инстанс к обновлению. Ничего не меняет, безопасно запускать когда угодно.
 *
 * Глубина зависит от того, куда собираемся: для патча гонять
 * полный набор — это четыре минуты церемонии ради двенадцати минут работы.
 */
export async function commandDoctor(ctx) {
  const { t, flags } = ctx;
  const probe = await commandCheck(ctx);
  const plan = probe.code === EXIT.ERROR ? null : probe.plan;
  const depth = !plan || plan.steps.length > 1 ? DEPTH.FULL : DEPTH.FAST;

  const summary = await runChecks({
    ...ctx,
    plan,
    uid: ctx.uid ?? process.getuid?.() ?? 0,
    env: ctx.env ?? process.env,
    isTty: ctx.isTty ?? Boolean(process.stdout.isTTY),
    minFreeGb: Number(flags.minFreeGb ?? ctx.config?.minFreeGb ?? 5),
    safeForOs: flags.safeForOs,
  }, { depth });

  const lines = ['', ...renderFindings(t, summary.findings), ''];
  lines.push(`   ${t('doctor.summary', summary)}`);
  if (blocked(summary)) lines.push('', ` ${t('doctor.blocked')}`);
  else if (summary.warnings && !flags.force) lines.push('', ` ${t('doctor.warned')}`);
  else lines.push('', ` ${t('doctor.clean')}`);
  lines.push('');

  return {
    code: blocked(summary) ? EXIT.ERROR : EXIT.CURRENT,
    errorCode: blocked(summary) ? 'checks-failed' : undefined,
    lines,
    result: {
      ok: summary.ok,
      warnings: summary.warnings,
      critical: summary.critical,
      blocked: blocked(summary),
      findings: summary.findings.map((f) => ({ id: f.id, check: f.check, level: f.level, params: f.params })),
    },
  };
}
