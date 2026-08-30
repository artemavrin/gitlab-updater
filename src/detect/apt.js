import { parseMadison } from '../plan/version.js';
import { aptArgv, APT_NONINTERACTIVE } from '../net/aptProxy.js';

/**
 * Доступные версии пакета. Заодно это и есть настоящая проверка
 * совместимости с ОС: если для дистрибутива пакета нет, apt его не покажет.
 */
export async function availableVersions(exec, pkg, { confPath = null } = {}) {
  const r = await exec(aptArgv(confPath, []).slice(0, 0).concat(
    confPath ? ['apt-cache', '-c', confPath, 'madison', pkg] : ['apt-cache', 'madison', pkg]
  ), { readOnly: true, allowFailure: true, env: APT_NONINTERACTIVE });
  if (r.code !== 0) return { versions: [], error: r.stderr.trim() || `apt-cache exited with ${r.code}` };
  return { versions: parseMadison(r.stdout).filter((v) => v.package === pkg), error: null };
}

/** Обновление списков только для репозитория GitLab — быстрее и безопаснее. */
export function updateGitlabListArgv(confPath, listPath) {
  return aptArgv(confPath, [
    '-o', `Dir::Etc::SourceList=${listPath}`,
    '-o', 'Dir::Etc::SourceParts=/dev/null',
    'update',
  ]);
}

/** Активные таймеры apt и удерживаемые блокировки — частая причина зависаний. */
export async function aptBusy(exec) {
  const r = await exec(['fuser', '/var/lib/dpkg/lock-frontend'], { readOnly: true, allowFailure: true });
  return r.code === 0;
}
