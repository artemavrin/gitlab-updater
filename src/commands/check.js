import { detectOs } from '../detect/os.js';
import { detectGitlab } from '../detect/gitlab.js';
import { availableVersions } from '../detect/apt.js';
import { buildPlan, exitCodeFor, EXIT, PROFILE } from '../plan/planner.js';
import { osCeiling } from '../plan/matrices.js';
import { shortVersion } from '../plan/version.js';

const ESTIMATE = {
  [PROFILE.PATCH]: 'check.estimate.patch',
  [PROFILE.MINOR]: 'check.estimate.minor',
  [PROFILE.LONG]: 'check.estimate.long',
};

/**
 * `check` ничего не меняет: детект плюс apt-cache madison.
 * Смысл — код возврата, по которому крон и мониторинг понимают, есть ли работа.
 */
export async function commandCheck({ exec, t, flags, data, osPath, confPath = null }) {
  const os = detectOs(osPath);
  if (!os) return { code: EXIT.ERROR, errorCode: 'os-unreadable', lines: [t('error.noOs')] };
  if (!os.supported) return { code: EXIT.ERROR, errorCode: 'os-unsupported', lines: [t('error.unsupportedOs', { os: os.pretty })] };

  const gitlab = await detectGitlab(exec);
  if (!gitlab && !flags.from) return { code: EXIT.ERROR, errorCode: 'gitlab-not-found', lines: [t('error.noGitlab')] };

  const pkg = gitlab?.package ?? 'gitlab-ee';
  const { versions, error } = await availableVersions(exec, pkg, { confPath });
  if (!versions.length) {
    return { code: EXIT.ERROR, errorCode: 'repository-unreachable', detail: error, lines: [t('error.noPackages'), error ?? '', t('error.noPackagesHint')].filter(Boolean) };
  }

  const plan = buildPlan({
    current: flags.from ?? gitlab.version,
    available: versions,
    stops: data.upgradePath.stops,
    osMax: flags.safeForOs ? osCeiling(data.osMatrix, os) : null,
    targetMajor: flags.targetMajor,
    to: flags.to,
    patchOnly: flags.patchOnly,
  });

  if (!plan.target) {
    return {
      code: EXIT.CURRENT,
      lines: [t('check.current', { version: shortVersion(plan.current) })],
      plan,
      result: { current: plan.current.raw, target: null, updateKind: null, profile: plan.profile, steps: 0 },
    };
  }

  const code = exitCodeFor(plan.current, plan.target);
  const kind = code === EXIT.MAJOR ? 'major' : code === EXIT.MINOR ? 'minor' : 'patch';
  return {
    code,
    plan,
    result: { current: plan.current.raw, target: plan.target.raw, updateKind: kind, profile: plan.profile, steps: plan.steps.length },
    lines: [t('check.available', {
      target: plan.target.raw,
      current: plan.current.raw,
      kind: t(`check.kind.${kind}`),
      estimate: t(ESTIMATE[plan.profile] ?? 'check.estimate.long'),
    })],
  };
}
