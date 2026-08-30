/**
 * Увод запуска в фон.
 *
 * Обрыв SSH на пятом часу миграций — самая обидная причина испорченного
 * апгрейда. systemd-run переживает и разрыв, и выход из сессии; setsid —
 * запасной вариант там, где systemd нет.
 */
export const UNIT = 'gitlab-upgrade';

export function detachArgv(argv, { unit = UNIT, useSystemd = true } = {}) {
  // --detach обязан исчезнуть, иначе дочерний процесс уведёт себя в фон снова.
  const clean = argv.filter((a) => a !== '--detach');
  return useSystemd
    ? ['systemd-run', `--unit=${unit}`, '--collect', '--same-dir', '--service-type=exec', '--', ...clean]
    : ['setsid', '--fork', ...clean];
}

export async function hasSystemd(exec) {
  const r = await exec(['systemd-run', '--version'], { readOnly: true, allowFailure: true });
  return r.code === 0;
}

export async function detach({ exec, argv, unit = UNIT }) {
  const useSystemd = await hasSystemd(exec);
  const r = await exec(detachArgv(argv, { unit, useSystemd }), { allowFailure: true });
  if (r.code !== 0) return { ok: false, detail: (r.stderr || r.stdout || '').trim().split('\n').pop() ?? '' };
  return { ok: true, unit: useSystemd ? unit : 'setsid' };
}
