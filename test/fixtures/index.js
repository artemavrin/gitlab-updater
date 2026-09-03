import { MIGRATION_QUERY } from '../../src/steps/settle.js';
import { APT_LOCKS } from '../../src/checks/index.js';
import { dpkgQuery, DPKG_INSTALLED } from '../../src/detect/gitlab.js';
import rbConflicts from '../../data/gitlab-rb-conflicts.json' with { type: 'json' };
import { settingsGrep } from '../../src/detect/gitlabRb.js';
/** Записанные выводы реальных команд. Ключ фикстуры — сама команда. */
export const madison1711 = `
   gitlab-ee | 17.11.6-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 17.11.4-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 17.11.0-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 17.8.7-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 17.5.5-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 17.3.7-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 17.1.8-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 16.11.10-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 16.7.10-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 16.3.9-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
   gitlab-ee | 15.11.13-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu jammy/main amd64 Packages
`;

/** Старый инстанс: проверяем, что остановки ниже 13.1 не потеряны. */
export const madisonAncient = `
   gitlab-ee | 13.0.14-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu bionic/main amd64 Packages
   gitlab-ee | 13.1.11-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu bionic/main amd64 Packages
   gitlab-ee | 12.10.14-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu bionic/main amd64 Packages
   gitlab-ee | 12.1.17-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu bionic/main amd64 Packages
   gitlab-ee | 12.0.12-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu bionic/main amd64 Packages
   gitlab-ee | 11.11.8-ee.0 | https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu bionic/main amd64 Packages
`;

export const osReleaseJammy = `PRETTY_NAME="Ubuntu 22.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04.4 LTS (Jammy Jellyfish)"
ID=ubuntu
VERSION_CODENAME=jammy
ID_LIKE=debian
`;

export const osReleaseFocal = `PRETTY_NAME="Ubuntu 20.04.6 LTS"
NAME="Ubuntu"
VERSION_ID="20.04"
ID=ubuntu
VERSION_CODENAME=focal
`;

/** ОС, у которой потолок действительно режет: для bionic опубликовано до 16.11. */
export const osReleaseBionic = `PRETTY_NAME="Ubuntu 18.04.6 LTS"
NAME="Ubuntu"
VERSION_ID="18.04"
ID=ubuntu
`;

export const ctlStatusHealthy = `run: alertmanager: (pid 1234) 500s; run: log: (pid 1200) 500s
run: gitaly: (pid 1235) 500s; run: log: (pid 1201) 500s
run: gitlab-kas: (pid 1236) 500s; run: log: (pid 1202) 500s
run: gitlab-workhorse: (pid 1237) 500s; run: log: (pid 1203) 500s
run: nginx: (pid 1238) 500s; run: log: (pid 1204) 500s
run: postgresql: (pid 1239) 500s; run: log: (pid 1205) 500s
run: puma: (pid 1240) 500s; run: log: (pid 1206) 500s
run: redis: (pid 1241) 500s; run: log: (pid 1207) 500s
run: sidekiq: (pid 1242) 500s; run: log: (pid 1208) 500s
`;

export const ctlStatusDegraded = ctlStatusHealthy.replace('run: sidekiq:', 'down: sidekiq:');

export const dfOutput = `Filesystem       1B-blocks          Avail Mounted on
/dev/sda2      500107862016   152530968576 /var/opt/gitlab
/dev/sda1      107374182400    65498251264 /
`;

/** Здоровый инстанс: все проверки готовности проходят. */
export function checkFixtures({ migrations = '0 0 batched', pg = 'psql (PostgreSQL) 15.6', status = ctlStatusHealthy, df = dfOutput, extra = {} } = {}) {
  // Ключ — сам MIGRATION_QUERY, а не его копия. Копия и спрятала дефект:
  // фикстура отвечала на сломанный запрос, поэтому тесты были зелёными, пока
  // на настоящем сервере запрос падал с NoMethodError на любой версии.
  const RUNNER = MIGRATION_QUERY;
  return {
    'test -d /opt/gitlab/embedded': { code: 0, stdout: '' },
    'test -f /.dockerenv': { code: 1, stdout: '' },
    'test -f /etc/gitlab/gitlab-secrets.json': { code: 0, stdout: '' },
    'gitlab-ctl status': { code: 0, stdout: status },
    [`gitlab-rails runner -e production ${RUNNER}`]: { code: 0, stdout: migrations },
    'df -B1 --output=source,size,avail,target /var/opt/gitlab /': { code: 0, stdout: df },
    // Ключи берём из самого списка блокировок: копия разошлась бы с ним молча,
    // а проверка «apt свободен» — ровно та, что пропустила чужой apt-get update.
    ...Object.fromEntries(APT_LOCKS.map((path) => [`fuser ${path}`, { code: 1, stdout: '' }])),
    'systemctl is-active apt-daily.timer': { code: 3, stdout: 'inactive' },
    // Выпуск дистрибутива в третьей колонке — по нему сверяется репозиторий с ОС.
    'apt-cache madison gitlab-ee': { code: 0, stdout: madison1711 },
    'gitlab-psql --version': { code: 0, stdout: pg },
    // Встроенный PostgreSQL: строки postgresql['enable'] в gitlab.rb нет.
    "grep -E ^\\s*postgresql\\['enable'\\] /etc/gitlab/gitlab.rb": { code: 1, stdout: '' },
    // Ключ строим тем же кодом, что и проверка: копия разошлась бы молча.
    [settingsGrep([...new Set(rbConflicts.rules.flatMap((r) => r.all_true))]).join(' ')]: { code: 1, stdout: '' },
    ...extra,
  };
}

/** Мало места: 1 ГБ на /var/opt/gitlab. */
export const dfTight = `Filesystem       1B-blocks          Avail Mounted on
/dev/sda2      500107862016     1073741824 /var/opt/gitlab
/dev/sda1      107374182400    65498251264 /
`;

/**
 * Маленький dpkg: подставляет поля в тот самый формат, который просит
 * продакшен. Полей ровно два — больше мы не спрашиваем.
 */
function dpkgOutput(pkg, version, status) {
  const format = dpkgQuery(pkg).find((a) => a.startsWith('-f=')).slice('-f='.length);
  return format.replaceAll('${Version}', version).replaceAll('${Status}', status);
}

/** Набор для exec в режиме replay. */
export function fixturesFor({ version = '17.11.4-ee.0', pkg = 'gitlab-ee', madison = madison1711, status = ctlStatusHealthy, dpkgStatus = DPKG_INSTALLED } = {}) {
  const set = {
    // И ключ, и ответ строим по настоящей команде: не только имя, но и
    // формат -f. Иначе фикстура отдавала бы состояние пакета даже там, где
    // продакшен его не запрашивает, — и тест на недонастроенный пакет
    // проходил бы при детекторе, который состояние не спрашивает вовсе.
    [dpkgQuery(pkg).join(' ')]: { code: 0, stdout: dpkgOutput(pkg, version, dpkgStatus) },
    'apt-cache madison gitlab-ee': { code: 0, stdout: madison },
    'apt-cache madison gitlab-ce': { code: 0, stdout: '' },
    'gitlab-ctl status': { code: 0, stdout: status },
    'df -B1 --output=source,size,avail,target /var/opt/gitlab /': { code: 0, stdout: dfOutput },
  };
  for (const other of ['gitlab-ee', 'gitlab-ce']) {
    if (other !== pkg) set[dpkgQuery(other).join(' ')] = { code: 1, stdout: '' };
  }
  return set;
}
