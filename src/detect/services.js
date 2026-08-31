/** Разбор вывода `gitlab-ctl status`. */
export function parseCtlStatus(stdout) {
  const services = [];
  for (const line of String(stdout).split('\n')) {
    const m = /^(run|down|fail):\s+(\S+):/.exec(line.trim());
    if (m) services.push({ name: m[2], state: m[1] });
  }
  return { services, running: services.filter((s) => s.state === 'run').length, total: services.length };
}

export const KEY_SERVICES = ['postgresql', 'redis', 'gitaly', 'puma', 'sidekiq'];

export function missingKeyServices(status) {
  const up = new Set(status.services.filter((s) => s.state === 'run').map((s) => s.name));
  return KEY_SERVICES.filter((name) => ![...up].some((u) => u.startsWith(name)));
}

export async function detectServices(exec) {
  const r = await exec(['gitlab-ctl', 'status'], { readOnly: true, allowFailure: true });
  if (r.code !== 0) return null;
  return parseCtlStatus(r.stdout);
}

/**
 * Версия PostgreSQL из `gitlab-psql --version` — целиком, а не мажорная.
 * Официальные минимумы заданы с точностью до минорной (14.14), и округление
 * до мажора пропустило бы 14.2 как подходящую для GitLab 17.
 */
export function parsePgVersion(stdout) {
  const m = /(\d+(?:\.\d+)*)/.exec(String(stdout).replace(/^\D*/, ''));
  return m ? m[1] : null;
}

export const RB_PATH = '/etc/gitlab/gitlab.rb';

/**
 * Встроенный PostgreSQL или внешний.
 *
 * Разница не косметическая: `gitlab-ctl pg-upgrade` управляет только
 * встроенным, для внешнего процедура другая, а на Patroni/HA эта команда
 * прямо запрещена документацией. Советовать её владельцу внешней БД —
 * худший вид совета: выглядит authoritative и ничего не делает, а в
 * кластере может навредить.
 *
 * Два независимых признака, и достаточно любого:
 * 1. `postgresql['enable'] = false` в gitlab.rb — намерение, записанное
 *    явно;
 * 2. в `gitlab-ctl status` нет службы postgresql — факт на машине.
 *
 * Неизвестность не выдаём за «встроенный»: `null` означает «определить не
 * удалось», и починка тогда не называет команду.
 */
export async function detectPostgres(exec, { rb = RB_PATH, status = null } = {}) {
  // gitlab.rb лежит с правами 0600 у root: под обычным пользователем
  // прочитать его нельзя, и это нормальный случай, а не сбой.
  const conf = await exec(['grep', '-E', "^\\s*postgresql\\['enable'\\]", rb], {
    readOnly: true, allowFailure: true,
  }).catch(() => ({ code: 2, stdout: '' }));
  if (conf.code === 0 && /=\s*false/.test(conf.stdout ?? '')) return { bundled: false, source: 'gitlab.rb' };

  const seen = status ?? await detectServices(exec).catch(() => null);
  if (!seen) return { bundled: conf.code === 0 ? true : null, source: conf.code === 0 ? 'gitlab.rb' : null };
  const supervised = seen.services.some((x) => x.name.startsWith('postgresql'));
  return { bundled: supervised, source: 'gitlab-ctl' };
}
