import { join } from 'node:path';

/**
 * Компоненты бэкапа GitLab Omnibus.
 * Источник: https://docs.gitlab.com/administration/backup_restore/backup_gitlab/
 * (раздел «Excluding specific data from the backup», сверено 31.08.2026).
 */
export const COMPONENTS = [
  'db', 'repositories', 'uploads', 'builds', 'artifacts', 'pages', 'lfs',
  'terraform_state', 'registry', 'packages', 'ci_secure_files',
  'agent_plan_content', 'ci_catalog_bundles', 'external_diffs',
];

export const MODE = { DB: 'db', FAST: 'fast', FULL: 'full', NONE: 'none' };

/** Что бэкап обязан сохранить в каждом режиме. */
const KEEP = {
  [MODE.DB]: ['db'],
  [MODE.FAST]: ['db', 'repositories'],
  [MODE.FULL]: COMPONENTS,
};

/**
 * Апгрейд меняет только базу и код: блобы шаги не трогают. Отсюда дешёвые
 * режимы — и отсюда же инвариант, который нельзя нарушить ни при каких
 * обстоятельствах: `db` не попадает в SKIP никогда. Бэкап без базы перед
 * апгрейдом бесполезен, а обнаруживается это при восстановлении.
 */
export function skipList(mode) {
  const keep = KEEP[mode];
  if (!keep) throw new Error(`unknown backup mode: ${mode}`);
  const skip = COMPONENTS.filter((c) => !keep.includes(c));
  if (skip.includes('db')) throw new Error('refusing to skip the database in a pre-upgrade backup');
  return skip;
}

export function backupArgv(mode) {
  const args = ['gitlab-backup', 'create'];
  // STRATEGY=copy спасает от «file changed as we read it» на живом инстансе,
  // но требует до 1x дополнительного места — поэтому только для полного.
  if (mode === MODE.FULL) args.push('STRATEGY=copy');
  const skip = skipList(mode);
  if (skip.length) args.push(`SKIP=${skip.join(',')}`);
  return args;
}

export const CONFIG_FILES = ['/etc/gitlab/gitlab.rb', '/etc/gitlab/gitlab-secrets.json'];
export const DEFAULT_DUMP_DIR = '/var/opt/gitlab/backups';

/** Имя архива из вывода gitlab-backup: «Creating backup archive: <id>_gitlab_backup.tar». */
export function parseArchive(stdout) {
  const m = /Creating backup archive:\s*(\S+_gitlab_backup\.tar)/.exec(String(stdout));
  return m ? m[1] : null;
}

/**
 * Куда GitLab кладёт дамп. Это его настройка, а не наша: путь задаётся
 * gitlab_rails['backup_path'] в gitlab.rb. Читаем её, чтобы не сообщать
 * пользователю каталог, в котором дампа нет.
 */
export async function dumpDir(exec, { rb = '/etc/gitlab/gitlab.rb' } = {}) {
  const r = await exec(['grep', '-E', "^\\s*gitlab_rails\\['backup_path'\\]", rb], { readOnly: true, allowFailure: true });
  const m = /=>?\s*["']([^"']+)["']/.exec(r.stdout ?? '');
  return m ? m[1] : DEFAULT_DUMP_DIR;
}

/**
 * Бэкап шага: дамп GitLab плюс конфиги рядом.
 *
 * gitlab-backup конфиги не сохраняет, а без gitlab-secrets.json дамп
 * не восстанавливается — узнать об этом при восстановлении слишком поздно.
 */
export async function runBackup({ exec, bus, mode, backupDir, hook, stamp }) {
  if (mode === MODE.NONE) {
    bus?.emit({ t: 'backup:skipped' });
    return { skipped: true, configDir: null, archive: null };
  }

  const configDir = join(backupDir, stamp);
  bus?.emit({ t: 'backup:start', mode, configDir });
  const started = Date.now();

  await exec(['mkdir', '-p', configDir]);
  const dump = await exec(backupArgv(mode), { timeout: 12 * 3600_000 });
  const archive = parseArchive(dump.stdout);
  const dumps = await dumpDir(exec);

  // gitlab-backup конфиги не сохраняет, а без gitlab-secrets.json дамп
  // не восстанавливается — кладём их рядом сами.
  for (const file of CONFIG_FILES) {
    await exec(['cp', '-a', file, configDir]);
  }
  // go-rwx, а не 0600: рекурсивный 0600 снял бы с самого каталога бит
  // выполнения и сделал его непроходимым даже для владельца.
  await exec(['chmod', '-R', 'go-rwx', configDir]);

  if (hook) {
    bus?.emit({ t: 'backup:hook', hook });
    // Снапшот LVM или VM — единственный настоящий откат, поэтому его провал
    // останавливает апгрейд так же, как провал самого бэкапа.
    await exec([hook, configDir], { timeout: 6 * 3600_000 });
  }

  const durationMs = Date.now() - started;
  bus?.emit({ t: 'backup:done', mode, configDir, dumpDir: dumps, archive, durationMs });
  return { skipped: false, configDir, dumpDir: dumps, archive, durationMs, stdout: dump.stdout };
}
