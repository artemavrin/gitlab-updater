/**
 * Записанный поток шестичасового апгрейда — ровно то, что лежало бы в JSONL.
 * Экраны — чистые функции от него, поэтому ни GitLab, ни терминал для
 * проверки не нужны.
 */
export const LONG_RUN = [
  { t: 'run:start', ts: '2026-08-30T13:31:20.000Z', from: '15.11.13-ee', target: '17.11.6-ee', steps: 3, profile: 'long', resuming: false, versions: ['16.3.9-ee', '16.7.10-ee', '17.11.6-ee'] },
  { t: 'step:start', ts: '2026-08-30T13:31:21.000Z', index: 1, of: 3, version: '16.3.9-ee' },
  { t: 'backup:start', ts: '2026-08-30T13:31:22.000Z', mode: 'full', configDir: '/mnt/backup/gitlab/20260830-1331' },
  { t: 'backup:done', ts: '2026-08-30T14:50:22.000Z', mode: 'full', durationMs: 4_740_000, archive: { size: 200_000_000_000 }, dumpDir: '/var/opt/gitlab/backups', configDir: '/mnt/backup/gitlab/20260830-1331' },
  { t: 'install:start', ts: '2026-08-30T14:50:23.000Z', pkg: 'gitlab-ee', version: '16.3.9-ee' },
  { t: 'install:done', ts: '2026-08-30T14:57:23.000Z', pkg: 'gitlab-ee', version: '16.3.9-ee', durationMs: 420_000 },
  { t: 'services:progress', ts: '2026-08-30T14:58:00.000Z', running: 12, total: 12, missing: [] },
  { t: 'migrations:progress', ts: '2026-08-30T15:00:00.000Z', queued: 47, rate: 8, elapsedMs: 600_000 },
  { t: 'migrations:progress', ts: '2026-08-30T15:38:00.000Z', queued: 0, rate: 8, elapsedMs: 2_880_000 },
  { t: 'step:done', ts: '2026-08-30T15:38:47.000Z', index: 1, of: 3, version: '16.3.9-ee', durationMs: 7_646_000 },
  { t: 'step:start', ts: '2026-08-30T15:38:48.000Z', index: 2, of: 3, version: '16.7.10-ee' },
  { t: 'backup:start', ts: '2026-08-30T15:38:49.000Z', mode: 'fast', configDir: '/mnt/backup/gitlab/20260830-1538' },
  { t: 'backup:done', ts: '2026-08-30T15:41:49.000Z', mode: 'fast', durationMs: 180_000, archive: { size: 2_100_000_000 }, dumpDir: '/var/opt/gitlab/backups', configDir: '/mnt/backup/gitlab/20260830-1538' },
  { t: 'install:start', ts: '2026-08-30T15:41:50.000Z', pkg: 'gitlab-ee', version: '16.7.10-ee' },
];

/** Повседневный патч: один шаг, компактный экран (§7A). */
export const PATCH_RUN = [
  { t: 'run:start', ts: '2026-08-30T21:03:00.000Z', from: '17.11.4-ee', target: '17.11.6-ee', steps: 1, profile: 'patch', resuming: false, versions: ['17.11.6-ee'] },
  { t: 'step:start', ts: '2026-08-30T21:03:01.000Z', index: 1, of: 1, version: '17.11.6-ee' },
  { t: 'backup:start', ts: '2026-08-30T21:03:02.000Z', mode: 'db', configDir: '/mnt/backup/gitlab/20260830-2103' },
  { t: 'backup:done', ts: '2026-08-30T21:04:02.000Z', mode: 'db', durationMs: 60_000, archive: { size: 1_200_000_000 }, dumpDir: '/var/opt/gitlab/backups', configDir: '/mnt/backup/gitlab/20260830-2103' },
  { t: 'install:start', ts: '2026-08-30T21:04:03.000Z', pkg: 'gitlab-ee', version: '17.11.6-ee' },
];

/** Остановка на упавшей миграции — экран, ради которого всё писалось (§8). */
export const STOPPED_RUN = [
  ...LONG_RUN,
  { t: 'run:stopped', ts: '2026-08-30T17:41:22.000Z', reason: 'migrations-timeout', detail: 'BackfillProjectStatistics', version: '16.7.10-ee', backup: '/mnt/backup/gitlab/20260830-1538' },
];
