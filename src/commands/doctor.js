import { runChecks, DEPTH, blocked, gate } from '../checks/index.js';
import { findingLines, blockerLines } from '../render/findings.js';
import { EXIT } from '../plan/planner.js';
import { commandCheck } from './check.js';

const LINE = 78;

/**
 * Список находок строками. `paint` красит маркер и заголовок, когда
 * приёмник — терминал; в редиректе он тождественный, и текст тот же.
 */
export function renderFindings(t, findings, { limit = LINE, paint = null } = {}) {
  return findingLines(findings, t, { limit }).map((l) => (paint
    ? paint(l.role, l.mark) + l.title + paint('dim', l.message)
    : l.mark + l.title + l.message));
}

/** Тот же блок, что на экране, склеенный в строки: цвета в не-TTY нет. */
export function renderBlockers(t, findings, { limit = LINE } = {}) {
  return blockerLines(findings, t, { limit }).map((l) => l.text);
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

  // Тот же вердикт, что вынесет run: иначе doctor скажет «всё в порядке»
  // там, где апгрейд не начнётся.
  const { verdict } = gate(summary, flags);

  const lines = ['', ...renderFindings(t, summary.findings, { paint: ctx.paint }), ''];
  lines.push(`   ${t('doctor.summary', summary)}`, '', ` ${t(verdict)}`, '');

  return {
    code: blocked(summary) ? EXIT.ERROR : EXIT.CURRENT,
    errorCode: blocked(summary) ? 'checks-failed' : undefined,
    lines, verdict,
    result: {
      ok: summary.ok,
      warnings: summary.warnings,
      critical: summary.critical,
      blocked: blocked(summary),
      findings: summary.findings.map((f) => ({ id: f.id, check: f.check, level: f.level, params: f.params, remedy: f.remedy ?? null })),
    },
  };
}
