import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Установщик проверяется как настоящий, а не читается глазами: его вливают
 * в `sh` с чужой машины, и цена ошибки здесь выше, чем в любом другом файле
 * проекта.
 *
 * Поднимаем свой HTTP-сервер и отдаём с него «бандл» — так проверяются обе
 * ветки, честная и подменённая, без сети и без релиза.
 */
function serve(files) {
  const server = http.createServer((req, res) => {
    const name = req.url.replace(/^\//, '');
    if (!Object.hasOwn(files, name)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200); res.end(files[name]);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const BUNDLE = '#!/usr/bin/env node\nconsole.log("gitlab-upgrade 9.9.9");\n';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const assets = (body) => ({
  'gitlab-upgrade.mjs': body,
  'gitlab-upgrade.mjs.sha256': `${sha(body)}  gitlab-upgrade.mjs\n`,
});

async function install(files, args = []) {
  const { server, port } = await serve(files);
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  try {
    const env = { ...process.env, HTTPS_PROXY: '', https_proxy: '' };
    const r = await run('sh', ['setup.sh', '--base-url', `http://127.0.0.1:${port}`, '--dir', dir, ...args], { env })
      .catch((e) => ({ failed: true, code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
    return { ...r, dir, target: join(dir, 'gitlab-upgrade') };
  } finally {
    server.close();
  }
}

test('установщик — корректный POSIX sh', () => {
  // Скрипт, который вливают в sh, обязан хотя бы разбираться этим sh.
  execFileSync('sh', ['-n', 'setup.sh']);
});

test('честный файл ставится и запускается', async () => {
  const r = await install(assets(BUNDLE));
  assert.ok(!r.failed, r.stderr);
  assert.ok(existsSync(r.target), 'файл должен появиться');
  assert.match(readFileSync(r.target, 'utf8'), /gitlab-upgrade 9\.9\.9/);
  // Права на исполнение: без них установка бессмысленна.
  assert.match(execFileSync('sh', ['-c', `test -x ${r.target} && echo yes`]).toString(), /yes/);
  rmSync(r.dir, { recursive: true, force: true });
});

test('подменённый файл не устанавливается', async () => {
  // Единственная защита, которую скрипт может дать со своей стороны:
  // сверить сумму до того, как файл попадёт в PATH.
  const files = assets(BUNDLE);
  files['gitlab-upgrade.mjs'] = BUNDLE + 'console.log("evil");\n';
  const r = await install(files);
  assert.ok(r.failed, 'установщик обязан упасть');
  assert.match(r.stderr, /сумма не совпала|checksum/i);
  assert.equal(existsSync(r.target), false, 'подменённый файл не должен оказаться на диске');
  rmSync(r.dir, { recursive: true, force: true });
});

test('страница ошибки не сохраняется как пакет', async () => {
  // Без curl --fail в файл лёг бы HTML с кодом 404, и он бы «установился».
  const r = await install({}, []);
  assert.ok(r.failed);
  assert.equal(existsSync(r.target), false);
  rmSync(r.dir, { recursive: true, force: true });
});

test('--dry-run проверяет, но не ставит', async () => {
  const r = await install(assets(BUNDLE), ['--dry-run']);
  assert.ok(!r.failed, r.stderr);
  assert.equal(existsSync(r.target), false);
  rmSync(r.dir, { recursive: true, force: true });
});

test('оборванная загрузка не выполняет половину установки', () => {
  // Главная опасность способа «curl | sh»: sh выполняет то, что успело
  // прийти. Скрипт завёрнут в функцию и вызывается последней строкой.
  const full = readFileSync('setup.sh', 'utf8');
  for (const cut of [200, 900, 2500, full.length - 40]) {
    const part = join(mkdtempSync(join(tmpdir(), 'half-')), 'half.sh');
    writeFileSync(part, full.slice(0, cut));
    let ran = false;
    try {
      const out = execFileSync('sh', [part], { encoding: 'utf8', stdio: 'pipe' });
      ran = /загружаю|устано/.test(out);
    } catch { /* синтаксическая ошибка — тоже «ничего не выполнено» */ }
    assert.equal(ran, false, `обрыв на ${cut} байтах не должен ничего устанавливать`);
  }
});

test('повторная установка обновляет на месте', async () => {
  const first = await install(assets(BUNDLE));
  assert.ok(!first.failed, first.stderr);
  const newer = BUNDLE.replace('9.9.9', '9.9.10');
  const { server, port } = await serve(assets(newer));
  try {
    await run('sh', ['setup.sh', '--base-url', `http://127.0.0.1:${port}`, '--dir', first.dir],
      { env: { ...process.env, HTTPS_PROXY: '', https_proxy: '' } });
    assert.match(readFileSync(first.target, 'utf8'), /9\.9\.10/);
  } finally {
    server.close();
    rmSync(first.dir, { recursive: true, force: true });
  }
});

test('--uninstall убирает бинарь и не трогает данные', async () => {
  const r = await install(assets(BUNDLE));
  const out = execFileSync('sh', ['setup.sh', '--uninstall', '--dir', r.dir], { encoding: 'utf8' });
  assert.equal(existsSync(r.target), false);
  // Журнал прерванного апгрейда бывает единственным следом того, что было.
  assert.match(out, /gitlab-upgrade/);
  rmSync(r.dir, { recursive: true, force: true });
});
