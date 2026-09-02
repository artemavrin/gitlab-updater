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
  smtp: 'https://docs.gitlab.com/omnibus/settings/smtp/',
};

/**
 * Rake-задача, которая показывает состояние фоновых миграций.
 *
 * Здесь было две ошибки сразу, и обе стоили человеку помощи на живом сервере,
 * где висела одна упавшая миграция на 18.2.8.
 *
 * Первая: порог стоял на 18.5, и для 18.2 инструмент отдавал только ссылку на
 * документацию — при том что команда работает. Проверено по исходникам:
 * lib/tasks/gitlab/background_migrations.rake есть с тега v14.6.0-ee (в
 * v14.5.4-ee только :finalize, в v14.0.12-ee файла нет вовсе), и задача
 * :status в нём с тех же пор по v18.11.0-ee включительно.
 *
 * Вторая, хуже: для 18.9+ предлагалась `gitlab:background_migrations:list`.
 * Такой задачи не существует ни в одном теге — я её выдумал. Совет, который
 * не выполнится, хуже отсутствия совета, и это правило записано двумя
 * абзацами выше в этом же файле.
 *
 * Задач в файле ровно две и они не менялись: :status и :finalize. :finalize
 * принимает четыре поля, и взять их можно только из вывода :status — поэтому
 * починка называет :status, а не :finalize.
 */
const migrationTasks = [
  { since: '14.6.0', spec: run('migrations-status', ['gitlab-rake', 'gitlab:background_migrations:status'], DOCS.migrations) },
  { since: null, spec: read('migrations-docs', DOCS.migrations) },
];

const byVersion = (table) => ({ table });

export const REMEDIES = {
  'services.critical': run('restart-service', ['gitlab-ctl', 'restart', '{missing}'], DOCS.services),
  'services-unknown.critical': run('ctl-status', ['gitlab-ctl', 'status'], DOCS.services),

  'migrations-failed.critical': byVersion(migrationTasks),
  'migrations-failed-named.critical': byVersion(migrationTasks),
  'migrations-pending.warn': byVersion(migrationTasks),
  'migrations-unknown.warn': run('ctl-status', ['gitlab-ctl', 'status'], DOCS.services),

  // Про место перед апгрейдом GitLab не пишет ничего: единственная
  // документированная проверка свободного места — внутри pg-upgrade.
  // Поэтому здесь диагностическая команда и без ссылки.
  'disk.critical': run('disk-usage', ['du', '-xh', '--max-depth=1', '{path}']),
  'disk-cache.warn': run('apt-clean', ['apt-get', 'clean']),

  // apt-mark hold и таймеры apt — наша практика, а не документация GitLab.
  'apt-busy.critical': run('who-holds-dpkg', ['fuser', '-v', '/var/lib/dpkg/lock-frontend']),
  // Штатный способ Debian доделать прерванную установку. Не из документации
  // GitLab — её тут и нет, пакет ломается на уровне dpkg, а не GitLab.
  'dpkg-broken.critical': run('dpkg-configure', ['dpkg', '--configure', '-a']),
  'apt-timer.warn': run('stop-apt-timer', ['systemctl', 'stop', 'apt-daily.timer', 'apt-daily-upgrade.timer']),

  // Только для встроенного PostgreSQL: для внешнего процедура другая, и
  // текст починки это называет прямо.
  'postgres.critical': run('pg-upgrade', ['gitlab-ctl', 'pg-upgrade'], DOCS.pg),
  // Тот же барьер, но дальше по пути — и команда здесь другая, точнее её тут
  // пока нет. `gitlab-ctl pg-upgrade` поднимает базу только до той версии,
  // которую несёт УСТАНОВЛЕННЫЙ пакет: на 13.12 он отвечает «12.6 уже стоит,
  // делать нечего». Нужную версию приносит пакет по пути, поэтому советовать
  // команду сейчас значит советовать пустое действие. Только документация, а
  // срок называет сам текст находки.
  'postgres.warn': read('pg-later', DOCS.pg),
  // Внешняя БД: команда GitLab тут не поможет, а на Patroni/HA навредит.
  'postgres-external.critical': read('pg-external', DOCS.pgExternal),
  'postgres-external.warn': read('pg-external', DOCS.pgExternal),

  // Правка gitlab.rb — не команда: какую из двух настроек выключить, решает
  // порт почтового сервера, и угадывать его за человека нельзя. Текст находки
  // называет оба варианта, здесь остаётся документация.
  'rb-smtp-tls-starttls.critical': read('rb-smtp-tls', DOCS.smtp),

  'os-ceiling.warn': flag('safe-for-os', '--safe-for-os', DOCS.os),
  'session.warn': flag('detach', '--detach'),
  // Своя же команда: она и найдёт chat id, и запишет его.
  'notify-partial.warn': run('notify-chat', ['gitlab-upgrade', 'notify', 'chat', '--yes']),

  // Диагностика прокси. Здесь починка — половина смысла команды: «пакетов
  // не видно» ищут перебором именно потому, что никто не сказал, что нажать.
  'proxy-none.warn': flag('set-proxy', '--proxy'),
  'proxy-tls-intercepted.critical': flag('proxy-ca', '--proxy-ca'),
  'apt-repo.critical': run('apt-update', ['apt-get', 'update']),
  'apt-refresh.critical': run('apt-update', ['apt-get', 'update']),
  // Ключ репозитория ставится отдельно, и это не про сеть.
  'apt-unsigned.critical': read('add-repo', DOCS.install),
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
  'gitlab-rb-unreadable.warn', // gitlab.rb не прочитан: чинить нечего, это сообщение о незнании
  // Рубежи прокси: чинится настройкой сети, а не командой на сервере.
  // Сообщение каждого называет, что именно не сошлось.
  'proxy-config.critical',
  'proxy-tcp.critical',
  'proxy-handshake.critical',
  'proxy-connect.critical',
  'proxy-tls.critical',
  'proxy-tls-closed.critical',   // закрыли рукопожатие — команды на это нет
  'proxy-tls-filtered.critical', // адрес закрыт в сети, лечится не здесь
  'proxy-downloads.critical',    // хост закрыт в сети: открывают его не командой
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
  const spec = found.table ? pick(found.table, rawVersion(version)) : found;
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
/**
 * Версия строкой, откуда бы её ни передали.
 *
 * Ctx держит разобранную версию объектом, а parseVersion принимает строку и
 * внутри делает String(input) — на объекте это «[object Object]», регулярка не
 * сходится, и функция честно отвечает null. Дальше pick понимал это как
 * «версия неизвестна» и отдавал самый общий вариант.
 *
 * То есть выбор починки по версии не работал вообще: на любом инстансе, где
 * версия определилась, человек получал запасной вариант — у нашего это была
 * ссылка на документацию вместо готовой rake-задачи. Молча, потому что
 * «неизвестная версия» — законное состояние, и отличить её от испорченной
 * подстановки было нечем.
 *
 * Приводим здесь, в одном месте: так безопасен любой вызывающий, а не только
 * тот, который сегодня помнит про .raw.
 */
const rawVersion = (v) => (typeof v === 'string' ? v : v?.raw ?? null);

function pick(table, version) {
  const have = version ? parseVersion(version) : null;
  if (!have) return table[table.length - 1].spec;
  for (const row of table) {
    if (!row.since || compareVersions(have, parseVersion(row.since)) >= 0) return row.spec;
  }
  return null;
}
