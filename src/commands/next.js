import { commandCheck } from './check.js';
import { EXIT, exitCodeFor, changesDocUrl } from '../plan/planner.js';

/**
 * Следующий релиз — и почему именно он.
 *
 * `plan` показывает весь путь; в скрипте и агенту нужен ровно один
 * ближайший шаг: какую версию ставить прямо сейчас. Обоснование берётся
 * из официального upgrade_path.yml, а не из наших соображений.
 */
export async function commandNext(ctx) {
  const { t, flags, data } = ctx;
  const res = await commandCheck(ctx);
  if (res.code === EXIT.ERROR) return res;

  const plan = res.plan;
  if (!plan?.steps.length) {
    return {
      code: EXIT.CURRENT,
      lines: flags.quiet ? [] : [t('next.none', { version: plan.current.raw })],
      result: { version: null, current: plan.current.raw, remaining: 0, final: true, reason: null, stop: null, conditional: false, note: null, docs: null, source: data.upgradePath.source, verifiedAt: data.upgradePath.verified_at },
    };
  }

  const step = plan.steps[0];
  const remaining = plan.steps.length - 1;
  const result = {
    version: step.raw,
    current: plan.current.raw,
    remaining,
    final: remaining === 0,
    reason: step.reason,
    stop: step.stop,
    conditional: step.conditional,
    note: step.note,
    docs: changesDocUrl(step.major),
    source: data.upgradePath.source,
    verifiedAt: data.upgradePath.verified_at,
  };

  if (flags.quiet) return { code: exitCodeFor(plan.current, step), lines: [step.raw], result };

  const lines = [
    '',
    ` ${step.raw}`,
    ` ${t(`plan.reason.${step.reason}`)}${remaining ? ` · ${t('next.remaining', { n: remaining })}` : ` · ${t('next.final')}`}`,
  ];
  if (step.note) lines.push('', `   ${step.note}`);
  lines.push('', `   ${result.docs}`, '');

  return { code: exitCodeFor(plan.current, step), lines, result };
}
