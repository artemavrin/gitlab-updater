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
ID_LIKE=debian
`;

export const osReleaseFocal = `PRETTY_NAME="Ubuntu 20.04.6 LTS"
NAME="Ubuntu"
VERSION_ID="20.04"
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
export function checkFixtures({ migrations = '0 0', pg = 'psql (PostgreSQL) 15.6', status = ctlStatusHealthy, df = dfOutput, extra = {} } = {}) {
  const RUNNER = 'm = Gitlab::Database::BackgroundMigration::BatchedMigration; puts "#{m.queued.count} #{m.failed.count}"';
  return {
    'test -d /opt/gitlab/embedded': { code: 0, stdout: '' },
    'test -f /.dockerenv': { code: 1, stdout: '' },
    'test -f /etc/gitlab/gitlab-secrets.json': { code: 0, stdout: '' },
    'gitlab-ctl status': { code: 0, stdout: status },
    [`gitlab-rails runner -e production ${RUNNER}`]: { code: 0, stdout: migrations },
    'df -B1 --output=source,size,avail,target /var/opt/gitlab /': { code: 0, stdout: df },
    'fuser /var/lib/dpkg/lock-frontend': { code: 1, stdout: '' },
    'systemctl is-active apt-daily.timer': { code: 3, stdout: 'inactive' },
    'gitlab-psql --version': { code: 0, stdout: pg },
    // Встроенный PostgreSQL: строки postgresql['enable'] в gitlab.rb нет.
    "grep -E ^\\s*postgresql\\['enable'\\] /etc/gitlab/gitlab.rb": { code: 1, stdout: '' },
    ...extra,
  };
}

/** Мало места: 1 ГБ на /var/opt/gitlab. */
export const dfTight = `Filesystem       1B-blocks          Avail Mounted on
/dev/sda2      500107862016     1073741824 /var/opt/gitlab
/dev/sda1      107374182400    65498251264 /
`;

/** Набор для exec в режиме replay. */
export function fixturesFor({ version = '17.11.4-ee.0', pkg = 'gitlab-ee', madison = madison1711, status = ctlStatusHealthy } = {}) {
  const set = {
    [`dpkg-query -W -f=\${Version} ${pkg}`]: { code: 0, stdout: version },
    'apt-cache madison gitlab-ee': { code: 0, stdout: madison },
    'apt-cache madison gitlab-ce': { code: 0, stdout: '' },
    'gitlab-ctl status': { code: 0, stdout: status },
    'df -B1 --output=source,size,avail,target /var/opt/gitlab /': { code: 0, stdout: dfOutput },
  };
  for (const other of ['gitlab-ee', 'gitlab-ce']) {
    if (other !== pkg) set[`dpkg-query -W -f=\${Version} ${other}`] = { code: 1, stdout: '' };
  }
  return set;
}
