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

/** Мажорная версия PostgreSQL из `gitlab-psql --version`. */
export function parsePgVersion(stdout) {
  const m = /(\d+)\.\d+/.exec(String(stdout));
  return m ? Number(m[1]) : null;
}
