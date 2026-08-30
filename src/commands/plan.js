import { commandCheck } from './check.js';
import { policyFor, PROFILE } from '../plan/planner.js';
import { table, pad, width } from '../render/format.js';
import { redactUrl } from '../core/redact.js';
import { EXIT } from '../plan/planner.js';
import { isStale } from '../plan/upgradePathSource.js';

/** План: то же обнаружение, что у check, плюс читаемый разбор пути. */
export async function commandPlan(ctx) {
  const { t, config, os, gitlabInfo } = ctx;
  const res = await commandCheck(ctx);
  if (res.code === EXIT.ERROR) return res;

  const plan = res.plan;
  const lines = [''];
  const labels = [t('plan.server'), t('plan.gitlab'), t('plan.network')];
  const w = width(labels) + 2;

  lines.push(` ${pad(t('plan.server'), w)}${os?.pretty ?? '—'}`);
  lines.push(` ${pad(t('plan.gitlab'), w)}${plan.current.raw}${gitlabInfo?.edition ? ` · ${gitlabInfo.edition}` : ''}`);
  lines.push(` ${pad(t('plan.network'), w)}${config.proxy ? t('plan.viaProxy', { proxy: redactUrl(config.proxy) }) : t('plan.direct')}`);
  lines.push('');

  const base = {
    os: os ? { id: os.id, versionId: os.versionId, pretty: os.pretty } : null,
    edition: gitlabInfo?.edition ?? null,
    limitedBy: plan.limitedBy ?? null,
  };

  if (!plan.target) {
    lines.push(` ${t('plan.nothing')}`, '');
    return { ...res, lines, result: { ...res.result, ...base, steps: [], policy: null } };
  }

  const policy = policyFor(plan.profile);
  lines.push(` ${t('plan.title')} · ${t('plan.steps', { n: plan.steps.length })} · ${plan.current.raw} → ${plan.target.raw}`);
  lines.push(` ${t('plan.profile')}: ${plan.profile}`);
  // Политика профиля — отдельными строками: в одну русский текст не влезает в 78 колонок.
  lines.push(`   ${t(`policy.backup.${policy.backup}`)}`);
  if (policy.predownload) lines.push(`   ${t('policy.predownload')}`);
  lines.push('');
  lines.push(...table(
    plan.steps.map((s, i) => [String(i + 1), s.raw, t(`plan.reason.${s.reason}`) || s.reason]),
    { indent: '   ' }
  ));
  lines.push('');
  if (plan.limitedBy && t.has(`plan.limitedBy.${plan.limitedBy}`)) {
    lines.push(` ${t(`plan.limitedBy.${plan.limitedBy}`)}`);
    lines.push('');
  }
  for (const f of plan.findings) {
    if (t.has(`finding.${f.id}`)) lines.push(` ! ${t(`finding.${f.id}`, f)}`);
  }
  if (plan.findings.length) lines.push('');

  if (isStale(ctx.data.upgradePath.verified_at)) {
    lines.push(` ! ${t('plan.stale', { date: ctx.data.upgradePath.verified_at })}`, '');
  }

  if (plan.profile !== PROFILE.PATCH) {
    lines.push(` ${t('plan.noRollback')}`);
    lines.push(` ${t('plan.noRollbackHint')}`);
    lines.push('');
  }
  lines.push(` ${t('plan.next')}`);
  lines.push(`   sudo gitlab-upgrade run --yes${plan.profile === PROFILE.LONG ? ' --detach' : ''}`);
  lines.push('');

  return {
    ...res,
    lines,
    result: {
      ...res.result,
      ...base,
      steps: plan.steps.map((s) => ({ version: s.raw, reason: s.reason })),
      policy,
    },
  };
}
