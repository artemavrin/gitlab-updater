import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const GITLAB_REPO_HOST = 'packages.gitlab.com';

/**
 * Настройки прокси для apt — во временный файл, а не в /etc/apt/apt.conf.d/.
 *
 * Три причины: kill -9 не оставляет систему перенастроенной; пароль прокси
 * не попадает в `ps aux` (в отличие от -o Acquire::...Proxy=...); и не лежит
 * в мировочитаемом каталоге. Файл создаётся с правами 0600.
 *
 * По умолчанию проксируем ТОЛЬКО packages.gitlab.com: на закрытом контуре
 * зеркало Ubuntu обычно внутреннее, и глобальный прокси сломал бы apt-get update.
 */
export function renderAptConf({ proxy, hosts = [GITLAB_REPO_HOST], all = false, ca = null }) {
  const lines = ['// создано gitlab-upgrade, временный файл'];
  if (proxy) {
    for (const scheme of ['http', 'https']) {
      if (all) lines.push(`Acquire::${scheme}::Proxy "${proxy}";`);
      else for (const h of hosts) lines.push(`Acquire::${scheme}::Proxy::${h} "${proxy}";`);
    }
  }
  if (ca) lines.push(`Acquire::https::CAInfo "${ca}";`);
  return lines.join('\n') + '\n';
}

export function writeAptConf(path, opts) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, renderAptConf(opts), { mode: 0o600 });
  return path;
}

/**
 * Путь свой у каждого процесса: общий файл удалялся бы завершением любой
 * параллельной команды — например, крон с `check` вынес бы конфиг из-под
 * идущего многочасового `run`, и следующий apt упал бы на середине пути.
 */
export function aptConfPath(stateDir, pid = process.pid) {
  return join(stateDir, `apt-proxy.${pid}.conf`);
}

export function removeAptConf(path) {
  rmSync(path, { force: true });
}

/** Готовая обёртка: apt-get -c <conf> ... в неинтерактивном режиме. */
export function aptArgv(confPath, args) {
  return ['apt-get', ...(confPath ? ['-c', confPath] : []), ...args];
}

export const APT_NONINTERACTIVE = {
  DEBIAN_FRONTEND: 'noninteractive',
  LC_ALL: 'C',
};

/** Опции dpkg, без которых unattended-установка повисает на вопросе о gitlab.rb. */
export const DPKG_KEEP_CONF = ['-o', 'Dpkg::Options::=--force-confold', '-o', 'Dpkg::Options::=--force-confdef'];
