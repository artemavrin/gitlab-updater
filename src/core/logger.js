import { appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
