import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, chownSync, symlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
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

/**
 * Машина, где `env node` приводит к старому интерпретатору, а рабочий есть
 * рядом. Ровно этот случай ломал установку под sudo: PATH у root свой, в нём
 * Node 18, а у пользователя 20 в nvm.
 */
function machineWithOldNodeInPath() {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const bin = join(home, 'fakebin');
  mkdirSync(bin, { recursive: true });
  // Старый node в PATH: отвечает как настоящий, но версией 18.
  const old = join(bin, 'node');
  writeFileSync(old, '#!/bin/sh\ncase "$1" in -p) echo 18 ;; --version) echo v18.17.1 ;; esac\n');
  chmodSync(old, 0o755);
  // Рабочий node там, где его ищут: nvm пользователя.
  const nvm = join(home, '.nvm/versions/node/v20.19.5/bin');
  mkdirSync(nvm, { recursive: true });
  symlinkSync(process.execPath, join(nvm, 'node'));
  return { home, path: `${bin}:/usr/bin:/bin` };
}

/**
 * Та же машина, но рабочий Node принадлежит не root.
 *
 * Настоящий файл, а не симлинк: chown идёт по ссылке и сменил бы владельца
 * системного node — этим уже однажды был испорчен контейнер.
 */
function machineWithUserOwnedNvmNode() {
  const { home, path } = machineWithOldNodeInPath();
  const nvm = join(home, '.nvm/versions/node/v20.19.5/bin/node');
  rmSync(nvm, { force: true });
  // Версия заведомо выше всего, что стоит на машине: выбирается самый новый
  // кандидат, и тест обязан гарантировать, что выберут именно наш — иначе он
  // проверит системный Node и молча ничего не докажет.
  writeFileSync(nvm, '#!/bin/sh\ncase "$1" in -p) echo 99 ;; --version) echo v99.0.0 ;; esac\n');
  chmodSync(nvm, 0o755);
  chownSync(nvm, 65534, 65534); // nobody:nogroup
  return { home, path, node: nvm };
}

test('старый node в PATH не отменяет установку, если рабочий есть рядом', async () => {
  // Раньше установщик просто отказывался: «нужен Node >= 20, установлен
  // v18.17.1» — хотя подходящий интерпретатор на машине был.
  const { home, path } = machineWithOldNodeInPath();
  const { server, port } = await serve(assets(BUNDLE));
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  try {
    const r = await run('sh', ['setup.sh', '--base-url', `http://127.0.0.1:${port}`, '--dir', dir],
      { env: { ...process.env, HOME: home, PATH: path, HTTPS_PROXY: '', https_proxy: '' } });
    const target = join(dir, 'gitlab-upgrade');
    assert.ok(existsSync(target), r.stderr);
    // В PATH — обёртка с абсолютным путём: шебанг `env node` при запуске
    // снова нашёл бы тот же старый интерпретатор, где бы файл ни лежал.
    const wrapper = readFileSync(target, 'utf8');
    assert.match(wrapper, /^#!\/bin\/sh/);
    assert.match(wrapper, /\.nvm\/versions\/node\/v20\.19\.5\/bin\/node|exec "/);
    // Бандл лежит рядом и байт в байт такой, как опубликован: сумму,
    // которую мы только что сверили, правка шебанга сделала бы бесполезной.
    assert.equal(readFileSync(join(dir, 'gitlab-upgrade.mjs'), 'utf8'), BUNDLE);
    // И всё это должно запускаться тем самым старым PATH.
    const out = execFileSync('sh', ['-c', `PATH=${path} ${target} --version`], { encoding: 'utf8' });
    assert.match(out, /gitlab-upgrade 9\.9\.9/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('--uninstall убирает и обёртку, и бандл рядом с ней', async () => {
  const { home, path } = machineWithOldNodeInPath();
  const { server, port } = await serve(assets(BUNDLE));
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  try {
    const env = { ...process.env, HOME: home, PATH: path, HTTPS_PROXY: '', https_proxy: '' };
    await run('sh', ['setup.sh', '--base-url', `http://127.0.0.1:${port}`, '--dir', dir], { env });
    await run('sh', ['setup.sh', '--uninstall', '--dir', dir], { env });
    // Бандл без обёртки — мусор в PATH-каталоге, который никто не удалит руками.
    assert.equal(existsSync(join(dir, 'gitlab-upgrade')), false);
    assert.equal(existsSync(join(dir, 'gitlab-upgrade.mjs')), false);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Ветку «на машине нет ни одного подходящего Node» проверить здесь нечем:
 * список кандидатов включает абсолютные системные пути, а они на тестовой
 * машине существуют. Зато проверяется то же сообщение на явно указанном
 * интерпретаторе — а это и есть путь, который остаётся человеку после отказа.
 */
test('явно указанный старый Node отвергается с названной версией', async () => {
  const { home, path } = machineWithOldNodeInPath();
  const { server, port } = await serve(assets(BUNDLE));
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  try {
    const r = await run('sh', ['setup.sh', '--base-url', `http://127.0.0.1:${port}`,
      '--dir', dir, '--node', join(home, 'fakebin/node')],
    { env: { ...process.env, HOME: home, PATH: path, HTTPS_PROXY: '', https_proxy: '' } })
      .catch((e) => ({ failed: true, stderr: e.stderr ?? '' }));
    assert.ok(r.failed, 'со старым Node установка обязана падать');
    // Отказ без версии заставляет гадать, какой именно Node он нашёл.
    assert.match(r.stderr, /v18\.17\.1/);
    assert.equal(existsSync(join(dir, 'gitlab-upgrade')), false);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('несуществующий --node — отказ, а не установка мимо проверки', async () => {
  const r = await install(assets(BUNDLE), ['--node', '/нет/такого/node']);
  assert.ok(r.failed);
  assert.match(r.stderr, /не найден интерпретатор/);
  assert.equal(existsSync(r.target), false);
  rmSync(r.dir, { recursive: true, force: true });
});

test('под sudo установка доходит до конца, а не обрывается молча', async () => {
  // SUDO_USER заставляет искать Node ещё и в домашнем каталоге вызвавшего.
  // Пока node_candidates заканчивалась проверкой `[ -x ]` несуществующего
  // кандидата, функция возвращала 1, и `set -e` снимал установку без единого
  // сообщения — ровно в том сценарии, ради которого её и писали.
  const { home, path } = machineWithOldNodeInPath();
  const { server, port } = await serve(assets(BUNDLE));
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  try {
    const r = await run('sh', ['setup.sh', '--base-url', `http://127.0.0.1:${port}`, '--dir', dir], {
      env: { ...process.env, HOME: home, PATH: path, SUDO_USER: 'nobody', HTTPS_PROXY: '', https_proxy: '' },
    }).catch((e) => ({ failed: true, code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
    assert.ok(!r.failed, `установка оборвалась: код ${r.code}\n${r.stderr}`);
    assert.ok(existsSync(join(dir, 'gitlab-upgrade')), 'файла нет, а ошибки не было — это и есть тихий обрыв');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('чужой Node, указанный через --node, ставится с предупреждением', async () => {
  // Явно названный путь — осознанный выбор: человек этот файл знает и берёт
  // на себя. Отказывать тут не за что, но и молчать нельзя.
  if (process.getuid?.() !== 0) return; // правило только для root, проверять нечего
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  // Подставной интерпретатор, а не симлинк на настоящий: chown идёт по ссылке
  // и сменил бы владельца системного node.
  const fake = join(home, 'node');
  writeFileSync(fake, '#!/bin/sh\ncase "$1" in -p) echo 20 ;; --version) echo v20.19.5 ;; esac\n');
  chmodSync(fake, 0o755);
  chownSync(fake, 65534, 65534); // nobody:nogroup
  const { server, port } = await serve(assets(BUNDLE));
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  try {
    const r = await run('sh', ['setup.sh', '--base-url', `http://127.0.0.1:${port}`, '--dir', dir, '--node', fake],
      { env: { ...process.env, HOME: home, HTTPS_PROXY: '', https_proxy: '' } });
    assert.ok(existsSync(join(dir, 'gitlab-upgrade')), 'явный выбор не должен отменять установку');
    assert.match(r.stderr, /принадлежит не root/);
    // И префикс — не «ошибка:». С одинаковым префиксом у падений и советов
    // читатель перестаёт различать оба: так и вышло на живой машине.
    assert.match(r.stderr, /^внимание:/m);
    assert.ok(!/^ошибка:/m.test(r.stderr), r.stderr);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Найденный сам собой чужой Node — отказ, а не предупреждение.
 *
 * Установщик вписывает интерпретатор в обёртку: значит root будет запускать
 * файл, переписываемый чужим uid, при каждом запуске и всегда. Предупреждение
 * здесь не работает — на живой машине его напечатали строкой ниже
 * «установлено» и с префиксом «ошибка:», как у настоящих отказов, и человек
 * пошёл выполнять следующую команду.
 */
test('чужой Node, найденный сам, отменяет установку', async () => {
  if (process.getuid?.() !== 0) return; // правило только для root
  const { home, path } = machineWithUserOwnedNvmNode();
  const { server, port } = await serve(assets(BUNDLE));
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  try {
    const r = await run('sh', ['setup.sh', '--base-url', `http://127.0.0.1:${port}`, '--dir', dir],
      { env: { ...process.env, HOME: home, PATH: path, HTTPS_PROXY: '', https_proxy: '' } })
      .then(() => null, (e) => e);
    assert.ok(r, 'установщик обязан выйти с ошибкой');
    assert.ok(!existsSync(join(dir, 'gitlab-upgrade')), 'ничего не должно быть установлено');
    assert.ok(!existsSync(join(dir, 'gitlab-upgrade.mjs')), 'и бандла рядом тоже');
    assert.match(r.stderr, /принадлежит не root/);
    // Отказ обязан назвать оба выхода: системный Node и осознанное --node.
    assert.match(r.stderr, /nodejs\.org/);
    assert.match(r.stderr, /--node/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
