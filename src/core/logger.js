import { appendFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.js';

/**
 * Журнал запуска в JSONL — источник правды на диске.
 *
 * Пишется тот же поток событий, что рисует экран, поэтому `attach` может
 * подключиться к идущему апгрейду и показать то же самое, а разбор постфактум
 * не зависит от того, на каком языке его запускали: в журнале ключи, не фразы.
 */
export const journalName = (stamp) => `run-${stamp}.jsonl`;

export function createJournal({ dir, stamp, secrets = [] }) {
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  const path = join(dir, journalName(stamp));
  return {
    path,
    write: (event) => {
      try {
        appendFileSync(path, redact(JSON.stringify(event), secrets) + '\n', { mode: 0o640 });
      } catch {
        // Журнал не должен ронять апгрейд: потеря строки лога дешевле
        // прерванного на середине обновления.
      }
    },
  };
}

/** Самый свежий журнал — то, к чему подключается attach без аргументов. */
export function latestJournal(dir) {
  let best = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('run-') || !name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const mtime = statSync(path).mtimeMs;
      // Ничья по mtime реальна: два файла создаются в одну миллисекунду.
      // Имя кодирует время до секунды и разрешает её однозначно.
      const newer = !best || mtime > best.mtime || (mtime === best.mtime && name > best.name);
      if (newer) best = { path, mtime, name };
    }
  } catch { /* каталога ещё нет — значит и запусков не было */ }
  return best?.path ?? null;
}

/**
 * Полный вывод упавшей команды — в отдельный файл рядом с журналом.
 *
 * `E: Sub-process /usr/bin/dpkg returned an error code (1)` и
 * `Backup::Error: gitaly-backup exit status 1` — это итог, а не причина.
 * Причина всегда на несколько строк выше, и до сих пор она просто пропадала:
 * exec собирал вывод, отдавал одну строку на экран и терял остальное. Человек
 * оставался с констатацией отказа и без единой зацепки.
 *
 * Права 0600: в выводе бывает и пароль прокси, и содержимое конфигов.
 */
export function saveFailure({ dir, stamp, err, secrets = [] }) {
  const r = err?.result ?? {};
  const body = [
    `# ${new Date().toISOString()}`,
    `# ${Array.isArray(r.argv) ? r.argv.join(' ') : String(r.argv ?? '')}`,
    `# exit ${r.code ?? '?'}`,
    '',
    '--- stdout ---', String(r.stdout ?? ''),
    '--- stderr ---', String(r.stderr ?? ''),
  ].join('\n');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o750 });
    const path = join(dir, `failed-${stamp}.log`);
    writeFileSync(path, redact(body, secrets), { mode: 0o600 });
    return path;
  } catch {
    // Не смогли сохранить — не повод потерять и саму остановку.
    return null;
  }
}
