import { writeFileSync, readFileSync, rmSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Взаимное исключение через PID-файл.
 *
 * В Node нет flock, а `mkdir` как блокировка оставляет висяки после kill -9.
 * Поэтому пишем PID и проверяем, жив ли процесс: мёртвый замок забираем,
 * живой — уважаем. Второй экземпляр посреди апгрейда опаснее висячего файла.
 */
export class LockedError extends Error {
  constructor(pid, path) {
    super(`already running: pid ${pid} holds ${path}`);
    this.name = 'LockedError';
    this.pid = pid;
    this.path = path;
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }   // EPERM значит «жив, но чужой»
};

export function acquireLock(path, { pid = process.pid } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);   // атомарно: создаёт или падает
      writeFileSync(fd, `${pid}\n`);
      closeSync(fd);
      return {
        path, pid,
        // Снимаем только свой замок: если нас сочли мёртвым и замок перехватили,
        // безусловный rm удалил бы чужой и пустил бы третий экземпляр.
        release: () => {
          try {
            if (Number(String(readFileSync(path, 'utf8')).trim()) !== pid) return;
          } catch { return; }
          rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = Number(String(readFileSync(path, 'utf8')).trim());
      // Пустой или обрезанный файл даёт 0, а kill(0, 0) бьёт по группе
      // процессов и успешен — такой «владелец» заклинил бы инструмент навсегда.
      const valid = Number.isInteger(holder) && holder > 0;
      if (valid && holder !== pid && alive(holder)) throw new LockedError(holder, path);
      rmSync(path, { force: true });            // замок мёртвого процесса
    }
  }
  throw new LockedError(0, path);
}
