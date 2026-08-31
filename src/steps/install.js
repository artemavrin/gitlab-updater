import { APT_NONINTERACTIVE, DPKG_KEEP_CONF, aptArgv } from '../net/aptProxy.js';

/**
 * Установка конкретной версии пакета.
 *
 * Три вещи, без которых unattended-установка ломается:
 * DEBIAN_FRONTEND=noninteractive и --force-confold — иначе dpkg спросит про
 * изменённый gitlab.rb и повиснет навсегда; и точная версия с `=`, иначе apt
 * поставит последнюю и перепрыгнет обязательную остановку.
 */
export function installArgv(pkg, version, confPath) {
  return aptArgv(confPath, ['install', '-y', ...DPKG_KEEP_CONF, `${pkg}=${version}`]);
}

export function downloadArgv(pkg, version, confPath) {
  return aptArgv(confPath, ['install', '-y', '--download-only', `${pkg}=${version}`]);
}

/** «Не смог взять блокировку» — так apt отвечает, когда рядом работает другой apt. */
const LOCKED = /could not get lock|unable to (lock|acquire)|Не удалось получить блокировку/i;

/**
 * Обновление списков с ожиданием чужого apt.
 *
 * Параллельный `apt-get update` — apt-daily, unattended-upgrades или человек в
 * соседней сессии — заставляет наш выйти с кодом 100 на первом же действии, и
 * подъём в девятнадцать шагов умирает, не начавшись. Воспроизведено: два
 * `apt-get update` одновременно дают ровно «E: Could not get lock
 * /var/lib/apt/lists/lock».
 *
 * Ждём и повторяем — но только на блокировке. Любой другой отказ поднимается
 * сразу: повтор поверх настоящей ошибки прячет её и тратит время.
 */
export async function updateLists(exec, confPath, {
  attempts = 6, waitMs = 20_000, bus = null, wait = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await exec(aptArgv(confPath, ['update']), { env: APT_NONINTERACTIVE, timeout: 20 * 60_000 });
    } catch (err) {
      const said = `${err?.result?.stderr ?? ''} ${err?.result?.stdout ?? ''}`;
      if (attempt >= attempts || !LOCKED.test(said)) throw err;
      // Молчаливое ожидание неотличимо от зависания: скажем, чего ждём.
      bus?.emit({ t: 'apt:locked', attempt, of: attempts });
      await wait(waitMs);
    }
  }
}

export async function installVersion({ exec, bus, pkg, version, confPath }) {
  bus?.emit({ t: 'install:start', pkg, version });
  const started = Date.now();
  const r = await exec(installArgv(pkg, version, confPath), {
    env: APT_NONINTERACTIVE,
    timeout: 4 * 3600_000,
  });
  const durationMs = Date.now() - started;
  bus?.emit({ t: 'install:done', pkg, version, durationMs });
  return { durationMs, stdout: r.stdout };
}

/**
 * Предзагрузка всего пути одной пачкой: дальше апгрейд идёт из кэша,
 * и обрыв прокси на пятом часу уже ничего не ломает.
 */
export async function predownload({ exec, bus, pkg, versions, confPath }) {
  bus?.emit({ t: 'predownload:start', count: versions.length });
  const started = Date.now();
  for (const version of versions) {
    await exec(downloadArgv(pkg, version, confPath), { env: APT_NONINTERACTIVE, timeout: 2 * 3600_000 });
    bus?.emit({ t: 'predownload:step', version });
  }
  const durationMs = Date.now() - started;
  bus?.emit({ t: 'predownload:done', count: versions.length, durationMs });
  return { durationMs };
}

/** Чтобы завтрашний `apt upgrade` не увёз GitLab на неподдерживаемую версию. */
export const holdArgv = (pkg) => ['apt-mark', 'hold', pkg];

/**
 * Снятие закрепления перед установкой.
 *
 * Прошлый успешный запуск оставил `apt-mark hold`, и без снятия следующий
 * `apt-get install -y` падает с «Held packages were changed and -y was used» —
 * причём уже после того, как бэкап сделан. Снимаем сами, в конце ставим обратно.
 */
export const unholdArgv = (pkg) => ['apt-mark', 'unhold', pkg];

export async function releaseHold(exec, pkg) {
  return exec(unholdArgv(pkg), { allowFailure: true });
}
