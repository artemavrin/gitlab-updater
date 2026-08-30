import { runChecks, DEPTH, blocked } from '../checks/index.js';
import { width, pad, wrap } from '../render/format.js';
import { describeFinding, blockerLines } from '../render/findings.js';
import { EXIT } from '../plan/planner.js';
import { commandCheck } from './check.js';

const LINE = 78;

/**
 * Список находок по строке на каждую. Продолжение переносится под колонку
 * сообщения: раньше здесь стояла обрезка, и резалось именно объяснение,
 * почему нельзя идти дальше.
 */
export function renderFindings(t, findings, { limit = LINE } = {}) {
  const said = findings.map((f) => describeFinding(f, t));
  const col = width(said.map((f) => f.title)) + 2;
  const head = 3 + 1 + 2 + col;
  return said.flatMap((f) =>
    wrap(f.message, Math.max(20, limit - head)).map((line, i) =>
      (i === 0 ? `   ${f.mark}  ${pad(f.title, col)}` : ' '.repeat(head)) + line));
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

  const verdict = blocked(summary) ? 'doctor.blocked'
    : (summary.warnings && !flags.force) ? 'doctor.warned' : 'doctor.clean';

  const lines = ['', ...renderFindings(t, summary.findings), ''];
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
