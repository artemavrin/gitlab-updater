import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inMultiplexer } from '../src/detect/session.js';

/**
 * Определение tmux — по предкам процесса, а не только по окружению.
 *
 * `sudo` сбрасывает окружение, а команду запускают именно через sudo. То есть
 * предупреждение «SSH без tmux» появлялось у тех, кто уже сделал ровно то, что
 * оно советует, — совет, который сам себя не признаёт выполненным.
 */

/** Поддельный /proc: цепочка «pid → имя, родитель». */
const fakeProc = (chain) => (path) => {
  const [, pid, file] = /^\/proc\/(\d+)\/(comm|status)$/.exec(path) ?? [];
  const node = chain[pid];
  if (!node) throw new Error('ENOENT');
  return file === 'comm' ? `${node.comm}\n` : `Name:\t${node.comm}\nPPid:\t${node.ppid}\n`;
};

test('окружение — быстрый путь, когда sudo его не съел', () => {
  assert.equal(inMultiplexer({ env: { TMUX: '/tmp/tmux-0/default,1,0' }, read: () => { throw new Error('в /proc лезть незачем'); } }), true);
  assert.equal(inMultiplexer({ env: { STY: '1234.pts-0.host' }, read: () => { throw new Error('незачем'); } }), true);
});

test('без окружения tmux виден по цепочке родителей', () => {
  // Ровно то, что показала настоящая машина под sudo: TMUX пуст, а наверху
  // цепочки стоит tmux: server.
  const chain = {
    100: { comm: 'node', ppid: 99 },
    99: { comm: 'sudo', ppid: 98 },
    98: { comm: 'sudo', ppid: 97 },
    97: { comm: 'bash', ppid: 96 },
    96: { comm: 'tmux: server', ppid: 1 },
  };
  assert.equal(inMultiplexer({ env: {}, pid: 100, read: fakeProc(chain) }), true);
});

test('screen тоже считается, а обычный SSH — нет', () => {
  const screen = { 10: { comm: 'node', ppid: 9 }, 9: { comm: 'bash', ppid: 8 }, 8: { comm: 'screen', ppid: 1 } };
  assert.equal(inMultiplexer({ env: {}, pid: 10, read: fakeProc(screen) }), true);

  const plain = { 10: { comm: 'node', ppid: 9 }, 9: { comm: 'bash', ppid: 8 }, 8: { comm: 'sshd', ppid: 1 } };
  assert.equal(inMultiplexer({ env: {}, pid: 10, read: fakeProc(plain) }), false);
});

test('кольцо в PPid не превращается в вечный цикл', () => {
  // На настоящей машине такого быть не должно, но проверка готовности не имеет
  // права зависнуть: её запускают перед многочасовым апгрейдом.
  const loop = { 5: { comm: 'a', ppid: 6 }, 6: { comm: 'b', ppid: 5 } };
  assert.equal(inMultiplexer({ env: {}, pid: 5, read: fakeProc(loop) }), false);
});

test('без /proc отвечаем «нет», а не падаем', () => {
  // macOS и часть контейнеров: лишнее предупреждение лучше упавшей проверки.
  assert.equal(inMultiplexer({ env: {}, pid: 1234, read: () => { throw new Error('ENOENT'); } }), false);
});

/**
 * И настоящий tmux, если он на машине есть. Поддельный /proc проверяет разбор,
 * но не то, что цепочка на живой системе выглядит именно так — а весь дефект
 * был ровно в этом предположении.
 */
test('в настоящем tmux под sudo определяется без переменной окружения', () => {
  const has = (bin) => spawnSync(bin, ['-V'], { stdio: 'pipe' }).error?.code !== 'ENOENT';
  if (!has('tmux')) return;
  const canSudo = spawnSync('sudo', ['-n', 'true'], { stdio: 'pipe' }).status === 0;

  const dir = mkdtempSync(join(tmpdir(), 'tmux-'));
  const probe = join(dir, 'probe.mjs');
  const out = join(dir, 'out.txt');
  writeFileSync(probe, [
    "import { inMultiplexer } from '" + join(process.cwd(), 'src/detect/session.js') + "';",
    // Окружение намеренно пустое: проверяем именно подъём по родителям.
    'process.stdout.write(String(inMultiplexer({ env: {} })));',
  ].join('\n'));

  const inner = canSudo
    ? `sudo ${process.execPath} ${probe} > ${out} 2>&1`
    : `${process.execPath} ${probe} > ${out} 2>&1`;
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', 'gluprobe', `sh -c '${inner}'`], { stdio: 'pipe' });
    // Ждём завершения пробы: tmux отвязывается сразу.
    for (let i = 0; i < 50; i++) {
      try {
        const said = execFileSync('cat', [out], { encoding: 'utf8' }).trim();
        if (said) {
          assert.equal(said, 'true', `в tmux${canSudo ? ' под sudo' : ''} должно определяться: «${said}»`);
          return;
        }
      } catch { /* файла ещё нет */ }
      execFileSync('sleep', ['0.1']);
    }
    assert.fail('проба в tmux не ответила');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', 'gluprobe'], { stdio: 'pipe' });
    rmSync(dir, { recursive: true, force: true });
  }
});
