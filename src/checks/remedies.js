import { compareVersions, parseVersion } from '../plan/version.js';

/**
 * Что делать с находкой.
 *
 * Отдельной таблицей, а не полем внутри проверки: починка — это данные, у
 * неё свой источник (официальная документация) и свой цикл проверки. Отсюда
 * же её берёт `--json`, поэтому агент получает действие, а не только диагноз.
 *
 * Ключ — `<id>.<level>`: одна и та же проверка на warn и critical лечится
 * по-разному. `argv` — массив, как и везде в проекте: строку с подстановкой
 * нельзя ни показать без риска, ни выполнить без shell.
 *
 * Сверено с docs.gitlab.com 30.08.2026. Команда, которой нет в документации,
 * сюда не попадает: совет, который не выполнится, хуже отсутствия совета.
 */

/** Команда системы. */
const run = (id, argv, docs = null) => ({ id, argv, flag: null, docs });
/** Действие инструмента: флаг, который надо добавить к запуску. */
const flag = (id, name, docs = null) => ({ id, argv: null, flag: name, docs });
/**
 * Только документация. Нужна там, где команда зависит от версии инстанса
 * сильнее, чем мы можем угадать: назвать не ту — отправить человека в три
 * часа ночи выполнять то, чего в его версии нет.
 */
const read = (id, docs) => ({ id, argv: null, flag: null, docs });

const DOCS = {
  pg: 'https://docs.gitlab.com/omnibus/settings/database/',
  pgExternal: 'https://docs.gitlab.com/administration/postgresql/external_upgrade/',
  migrations: 'https://docs.gitlab.com/update/background_migrations/',
  services: 'https://docs.gitlab.com/omnibus/maintenance/',
  // /administration/package_information/supported_os/ отдаёт 302 на авторизацию
  // и для текущих версий мёртв; таблица поддерживаемых ОС живёт здесь.
  os: 'https://docs.gitlab.com/install/package/',
  install: 'https://docs.gitlab.com/install/package/',
};

/**
 * Rake-задачи для фоновых миграций появились в 18.5 и переименовались в 18.9.
 * Ниже 18.5 документированной команды нет вовсе — там остаётся документация.
 */
const migrationTasks = [
  { since: '18.9.0', spec: run('migrations-list', ['gitlab-rake', 'gitlab:background_migrations:list'], DOCS.migrations) },
  { since: '18.5.0', spec: run('migrations-status', ['gitlab-rake', 'gitlab:background_migrations:status'], DOCS.migrations) },
  { since: null, spec: read('migrations-docs', DOCS.migrations) },
];

const byVersion = (table) => ({ table });

export const REMEDIES = {
  'services.critical': run('restart-service', ['gitlab-ctl', 'restart', '{missing}'], DOCS.services),
  'services-unknown.critical': run('ctl-status', ['gitlab-ctl', 'status'], DOCS.services),

  'migrations-failed.critical': byVersion(migrationTasks),
  'migrations-pending.warn': byVersion(migrationTasks),
  'migrations-unknown.warn': run('ctl-status', ['gitlab-ctl', 'status'], DOCS.services),

  // Про место перед апгрейдом GitLab не пишет ничего: единственная
  // документированная проверка свободного места — внутри pg-upgrade.
  // Поэтому здесь диагностическая команда и без ссылки.
  'disk.critical': run('disk-usage', ['du', '-xh', '--max-depth=1', '{path}']),
  'disk-cache.warn': run('apt-clean', ['apt-get', 'clean']),

  // apt-mark hold и таймеры apt — наша практика, а не документация GitLab.
  'apt-busy.critical': run('who-holds-dpkg', ['fuser', '-v', '/var/lib/dpkg/lock-frontend']),
  'apt-timer.warn': run('stop-apt-timer', ['systemctl', 'stop', 'apt-daily.timer', 'apt-daily-upgrade.timer']),

  // Только для встроенного PostgreSQL: для внешнего процедура другая, и
  // текст починки это называет прямо.
  'postgres.critical': run('pg-upgrade', ['gitlab-ctl', 'pg-upgrade'], DOCS.pg),
  // Внешняя БД: команда GitLab тут не поможет, а на Patroni/HA навредит.
  'postgres-external.critical': read('pg-external', DOCS.pgExternal),

  'os-ceiling.warn': flag('safe-for-os', '--safe-for-os', DOCS.os),
  'session.warn': flag('detach', '--detach'),

  // Диагностика прокси. Здесь починка — половина смысла команды: «пакетов
  // не видно» ищут перебором именно потому, что никто не сказал, что нажать.
  'proxy-none.warn': flag('set-proxy', '--proxy'),
  'proxy-tls-intercepted.critical': flag('proxy-ca', '--proxy-ca'),
  'apt-repo.critical': run('apt-update', ['apt-get', 'update']),
  // Единственная починка, которая здесь работает: списки надо скачать.
  'apt-not-updated.critical': run('apt-update', ['apt-get', 'update']),
  'apt-no-repo.critical': read('add-repo', DOCS.install),
  'apt-direct.warn': flag('proxy-all-apt', '--proxy-all-apt'),
};

/**
 * Находки, для которых команды нет и выдумывать её нельзя.
 * Список явный: молчание тут неотличимо от забытой строки в таблице.
 */
export const NO_REMEDY = new Set([
  'root.critical',             // команда зависит от того, что запускали; сообщение уже её называет
  'omnibus.critical',          // не тот сервер
  'omnibus-container.critical',// Docker и Helm вне области инструмента
  'omnibus-container-allowed.warn', // поблажка стенда: чинить нечего, это и есть предупреждение
  'secrets.critical',          // файл не создаётся заново: он либо есть, либо бэкап бесполезен
  'postgres-above.warn',       // вопрос поддерживаемости, а не поломки
  'postgres-unknown.warn',
  'disk-unknown.warn',
  'check-failed.warn',
  // Рубежи прокси: чинится настройкой сети, а не командой на сервере.
  // Сообщение каждого называет, что именно не сошлось.
  'proxy-config.critical',
  'proxy-tcp.critical',
  'proxy-handshake.critical',
  'proxy-connect.critical',
  'proxy-tls.critical',
  'proxy-tls-closed.critical',   // закрыли рукопожатие — команды на это нет
  'proxy-tls-filtered.critical', // адрес закрыт в сети, лечится не здесь
  'proxy-http.critical',
]);

/**
 * Подстановка параметров находки в argv. Плейсхолдер без значения — ошибка.
 *
 * @param {object} finding  находка: id, level, params
 * @param {object} [ctx]    окружение: `version` — установленная версия GitLab
 */
export function remedyFor({ id, level, params = {} }, { version = null } = {}) {
  const found = REMEDIES[`${id}.${level}`];
  if (!found) return null;
  const spec = found.table ? pick(found.table, version) : found;
  if (!spec) return null;
  if (!spec.argv) return { id: spec.id, argv: null, flag: spec.flag ?? null, docs: spec.docs };

  const argv = spec.argv.map((part) =>
    String(part).replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name]))));
  // Незаполненный плейсхолдер показывать нельзя: команда не выполнится,
  // а выглядеть будет как готовая к копированию.
  if (argv.some((part) => /\{\w+\}/.test(part))) return null;
  return { id: spec.id, argv, flag: null, docs: spec.docs };
}

/** Версия неизвестна — берём самый общий вариант, а не самый новый. */
function pick(table, version) {
  const have = version ? parseVersion(version) : null;
  if (!have) return table[table.length - 1].spec;
  for (const row of table) {
    if (!row.since || compareVersions(have, parseVersion(row.since)) >= 0) return row.spec;
  }
  return null;
}
