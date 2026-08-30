import { createReadStream, statSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { latestJournal } from '../core/logger.js';
import { EXIT } from '../plan/planner.js';

/**
 * Подключение к идущему апгрейду.
 *
 * Возможно только потому, что журнал на диске — тот же поток событий, что
 * рисует экран. Обрыв SSH перестаёт быть катастрофой: `run --detach` живёт
 * своей жизнью, а `attach` показывает то же, что показывал бы он.
 */
export async function commandAttach(ctx) {
  const { t, config, flags } = ctx;
  const path = flags.journal ?? latestJournal(config.logDir);
  if (!path) {
    return { code: EXIT.ERROR, errorCode: 'no-journal', lines: [t('attach.none', { dir: config.logDir })] };
  }

  const render = ctx.render ?? ((e) => process.stdout.write(format(e) + '\n'));
  let shown = 0;
  const feed = (line) => {
    if (!line.trim()) return;
    try { render(JSON.parse(line)); shown++; } catch { /* оборванная строка в конце файла */ }
  };

  await readAll(path, feed);

  if (!flags.follow) return { code: EXIT.CURRENT, lines: [], result: { path, events: shown } };

  process.stderr.write(t('attach.following', { path }) + '\n');
  await follow(path, feed, ctx.stopFollowing);
  return { code: EXIT.CURRENT, lines: [], result: { path, events: shown } };
}

function readAll(path, onLine) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) });
    rl.on('line', onLine);
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

/** Дочитывание дописанного: то же, что `tail -f`, но без внешней команды. */
function follow(path, onLine, stop) {
  return new Promise((resolve) => {
    let offset = statSync(path).size;
    let tail = '';
    const pump = () => {
      const size = statSync(path).size;
      if (size <= offset) return;
      const stream = createReadStream(path, { start: offset, end: size - 1, encoding: 'utf8' });
      offset = size;
      stream.on('data', (chunk) => {
        tail += chunk;
        const lines = tail.split('\n');
        tail = lines.pop() ?? '';
        lines.forEach(onLine);
      });
    };
    const watcher = watch(path, pump);
    const timer = setInterval(pump, 2000);
    const finish = () => { clearInterval(timer); watcher.close(); resolve(); };
    stop?.(finish);
    process.once('SIGINT', finish);
  });
}

export function format(e) {
  const ts = String(e.ts ?? '').slice(11, 19);
  const rest = Object.entries(e)
    .filter(([k]) => !['t', 'ts'].includes(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  return `${ts} ${e.t}${rest ? ' ' + rest : ''}`;
}
