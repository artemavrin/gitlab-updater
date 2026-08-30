import { runChecks, DEPTH, blocked } from '../checks/index.js';
import { width, pad, wrap } from '../render/format.js';
import { describeFinding, groupFindings } from '../render/findings.js';
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

/**
 * Развёрнутый блок того, что мешает начать.
 *
 * Отдельно от списка, потому что вопрос другой: список отвечает «что
 * проверили», блок — «что мне сейчас чинить». Пять critical, размазанных
 * между пройденными галочками, на второй вопрос не отвечают.
 */
export function renderBlockers(t, findings, { limit = LINE } = {}) {
  const { critical, warnings } = groupFindings(findings);
  const lines = [];
  for (const f of [...critical, ...warnings].map((x) => describeFinding(x, t))) {
    lines.push(` ${f.mark} ${f.title}`);
    lines.push(...wrap(f.message, limit - 4).map((l) => `    ${l}`));
    if (f.remedy) {
      lines.push(`    ${t('remedy.title')}`);
      // Починка бывает без команды: там, где она зависит от версии сильнее,
      // чем мы можем угадать, остаётся объяснение и ссылка.
      const action = f.remedy.command ?? f.remedy.flag;
      if (action) lines.push(`      ${action}`);
      lines.push(...wrap(f.remedy.what, limit - 8).map((l) => `      ${l}`));
      // Ссылка отдельной строкой и без переноса: с подписью в той же строке
      // самый длинный URL из таблицы вылезает за 78 колонок, а рвать URL нельзя.
      if (f.remedy.docs) lines.push(`      ${t('remedy.docs')}`, `      ${f.remedy.docs}`);
    }
    lines.push('');
  }
  return lines;
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
      findings: summary.findings.map((f) => ({ id: f.id, check: f.check, level: f.level, params: f.params, remedy: f.remedy ?? null })),
    },
  };
}
