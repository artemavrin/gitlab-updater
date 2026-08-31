import { readFileSync } from 'node:fs';

/**
 * Запущены ли мы внутри tmux или screen.
 *
 * По переменным окружения этого мало: `sudo` сбрасывает окружение, а команду
 * запускают именно через sudo — то есть у всех, кто послушался нашего же
 * совета «запустите в tmux», предупреждение появлялось всё равно. Проверено:
 * под sudo `TMUX` пуст, а цепочка родителей по-прежнему упирается в
 * `tmux: server`.
 *
 * Поэтому смотрим предков процесса. Окружение остаётся быстрым путём: без
 * sudo оно есть, и лезть в /proc незачем.
 */

/** Имена мультиплексоров в /proc/<pid>/comm. Там не больше 15 символов. */
const NAMES = [/^tmux/i, /^screen$/i, /^SCREEN$/, /^zellij/i];

const readProc = (path) => readFileSync(path, 'utf8');

/**
 * @param {object}   o
 * @param {object}   [o.env]   окружение процесса
 * @param {number}   [o.pid]   с какого процесса начинать подъём
 * @param {Function} [o.read]  чтение файла — для проверки без /proc
 * @param {number}   [o.maxDepth] страховка от кольца в PPid
 */
export function inMultiplexer({ env = {}, pid = process.pid, read = readProc, maxDepth = 40 } = {}) {
  if (env.TMUX || env.STY || env.ZELLIJ) return true;

  let current = Number(pid);
  for (let i = 0; i < maxDepth; i++) {
    if (!Number.isFinite(current) || current <= 1) return false;
    let comm;
    let parent;
    try {
      comm = read(`/proc/${current}/comm`).trim();
      parent = Number(/^PPid:\s*(\d+)/m.exec(read(`/proc/${current}/status`))?.[1]);
    } catch {
      // Нет /proc — ответить нечем. Молчим: выдумывать ответ здесь хуже, чем
      // не ответить, а без tmux мы всего лишь предупредим лишний раз.
      return false;
    }
    if (NAMES.some((re) => re.test(comm))) return true;
    current = parent;
  }
  return false;
}
