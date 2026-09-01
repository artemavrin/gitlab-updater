import { parseVersion } from '../plan/version.js';

export const PACKAGES = ['gitlab-ee', 'gitlab-ce'];

/**
 * Установлен ли пакет на самом деле.
 *
 * `${Status}` — это три поля: чего хотят (want), есть ли ошибка (error) и что
 * с пакетом сейчас (state). Судить можно только по двум последним.
 *
 * Первое поле смотреть нельзя, и это проверено вживую: `apt-mark hold` —
 * который ставит сам этот инструмент после последнего шага — превращает
 * `install ok installed` в `hold ok installed`. Сравнение целой строки
 * объявило бы недонастроенным как раз тот сервер, который мы только что
 * успешно обновили и закрепили.
 *
 * Состояния кроме `installed` (unpacked, half-configured, half-installed,
 * config-files) значат, что dpkg до конца не дошёл; `reinstreq` вместо `ok` —
 * что пакет требует переустановки.
 */
export const DPKG_INSTALLED = 'install ok installed';

export function dpkgInstalled(status) {
  const parts = String(status ?? '').trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [, error, state] = parts;
  return error === 'ok' && state === 'installed';
}

/**
 * Спрашиваем у dpkg версию И состояние.
 *
 * Одной версии мало, и это стоило живого сервера: установка 15.11.13 упала на
 * `Sub-process /usr/bin/dpkg returned an error code (1)`, пакет остался
 * распакованным, но ненастроенным — `gitlab-ctl reconfigure` с миграциями не
 * отработал. `dpkg-query -W -f=${Version}` при этом продолжал отвечать
 * «15.11.13», инструмент считал шаг выполненным, и следующий `resume` пошёл
 * делать бэкап новым кодом по старой схеме. Бэкап упал на
 * `relation "design_management_repositories" does not exist`.
 *
 * Разделитель — вертикальная черта: в версии и в состоянии её быть не может.
 */
export const dpkgQuery = (pkg) => ['dpkg-query', '-W', '-f=${Version}|${Status}', pkg];

/**
 * Версия, редакция и состояние GitLab.
 *
 * Порядок источников: dpkg (авторитетен и даёт точную apt-версию),
 * затем VERSION-файл omnibus. Редакция определяется именем пакета —
 * менять её на пути нельзя, это отдельная критическая проверка.
 */
export async function detectGitlab(exec, { versionFile = '/opt/gitlab/embedded/service/gitlab-rails/VERSION' } = {}) {
  for (const pkg of PACKAGES) {
    const r = await exec(dpkgQuery(pkg), { readOnly: true, allowFailure: true });
    const [raw = '', status = ''] = r.stdout.trim().split('|');
    if (r.code === 0 && raw) {
      const v = parseVersion(raw);
      if (v) {
        return {
          version: v,
          aptVersion: raw,
          package: pkg,
          edition: pkg.endsWith('-ee') ? 'ee' : 'ce',
          source: 'dpkg',
          status: status.trim() || null,
          // null, а не false: «состояния не знаем» и «пакет недонастроен» —
          // разные вещи, и проверка обязана их различать.
          installed: dpkgInstalled(status),
        };
      }
    }
  }
  const r = await exec(['cat', versionFile], { readOnly: true, allowFailure: true });
  if (r.code === 0 && r.stdout.trim()) {
    const v = parseVersion(r.stdout.trim());
    // Про состояние пакета VERSION-файл не знает ничего: он лежит на диске и
    // после прерванной настройки.
    if (v) return { version: v, aptVersion: r.stdout.trim(), package: null, edition: v.edition, source: 'version-file', status: null, installed: null };
  }
  return null;
}
