import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactUrl } from '../src/core/redact.js';
import { createExec, MODE, ExecError, errorDetail } from '../src/core/exec.js';
import { EventBus } from '../src/core/events.js';
import { renderAptConf, openAptConf } from '../src/net/aptProxy.js';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseProxy } from '../src/core/http.js';
import { fixturesFor } from './fixtures/index.js';

test('пароль прокси не попадает в журнал', () => {
  assert.equal(redactUrl('socks5h://svc:s3cret@10.0.0.5:1080'), 'socks5h://svc:***@10.0.0.5:1080');
  assert.ok(!redact('токен abcd1234 внутри', ['abcd1234']).includes('abcd1234'));
});

test('слишком короткие секреты не маскируются — риск испортить текст выше пользы', () => {
  assert.equal(redact('версия 1.2', ['1.2']), 'версия 1.2');
});

test('dry-режим не запускает изменяющие команды, но запускает читающие', async () => {
  const exec = createExec({ mode: MODE.DRY });
  const write = await exec(['apt-get', 'install', 'gitlab-ee']);
  assert.equal(write.skipped, true);
  const read = await exec(['echo', 'привет'], { readOnly: true });
  assert.equal(read.stdout.trim(), 'привет');
  assert.notEqual(read.skipped, true);
});

test('replay-режим отдаёт фикстуру и падает на незаписанной команде', async () => {
  const exec = createExec({ mode: MODE.REPLAY, fixtures: fixturesFor() });
  const r = await exec(['gitlab-ctl', 'status'], { readOnly: true });
  assert.match(r.stdout, /run: gitaly/);
  await assert.rejects(() => exec(['gitlab-ctl', 'reconfigure']), ExecError);
});

test('ненулевой код по умолчанию — ошибка, с allowFailure — результат', async () => {
  const exec = createExec({ mode: MODE.REAL });
  await assert.rejects(() => exec(['false'], { readOnly: true }), ExecError);
  const r = await exec(['false'], { readOnly: true, allowFailure: true });
  assert.equal(r.code, 1);
});

test('шина требует поле t и добавляет отметку времени', () => {
  const bus = new EventBus();
  const seen = [];
  bus.on((e) => seen.push(e));
  bus.emit({ t: 'step:start', step: 1 });
  assert.equal(seen[0].step, 1);
  assert.match(seen[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.throws(() => bus.emit({ step: 2 }), TypeError);
});

test('прокси для apt настраивается только на packages.gitlab.com', () => {
  const conf = renderAptConf({ proxy: 'socks5h://10.0.0.5:1080' });
  assert.match(conf, /Acquire::http::Proxy::packages\.gitlab\.com "socks5h:\/\/10\.0\.0\.5:1080";/);
  assert.match(conf, /Acquire::https::Proxy::packages\.gitlab\.com/);
  assert.ok(!/Acquire::http::Proxy "/.test(conf), 'глобальный прокси сломал бы внутреннее зеркало Ubuntu');
});

test('--proxy-all-apt включает глобальный прокси осознанно', () => {
  const conf = renderAptConf({ proxy: 'http://10.0.0.5:8080', all: true });
  assert.match(conf, /Acquire::http::Proxy "http:\/\/10\.0\.0\.5:8080";/);
});

test('разбор URL прокси даёт тип, порт и креды', () => {
  assert.deepEqual(parseProxy('socks5h://u:p@10.0.0.5:1080'),
    { kind: 'socks5', scheme: 'socks5h', host: '10.0.0.5', port: 1080, username: 'u', password: 'p' });
  // Ходим мы всегда с ATYP=domain, поэтому даже записанный socks5 остаётся
  // socks5h в том, что показываем: разница — в том, кто резолвит имя.
  assert.equal(parseProxy('socks5://10.0.0.5:1080').scheme, 'socks5h');
  assert.equal(parseProxy('http://10.0.0.5:8080').kind, 'http');
  assert.equal(parseProxy(null), null);
  assert.throws(() => parseProxy('ftp://x'), (e) => e.code === 'proxy-scheme' && e.params.scheme === 'ftp');
});

/**
 * Каталог, в который нельзя писать никому.
 *
 * На настоящей машине это EACCES на /var/lib/gitlab-upgrade у обычного
 * пользователя, но тесты бывают запущены и от root, для которого права 0500
 * ничего не значат. Подкаталог внутри обычного файла недоступен любому uid,
 * а `writableDir` обе причины обрабатывает одинаково.
 */
function unusableDir() {
  const file = join(mkdtempSync(join(tmpdir(), 'locked-')), 'not-a-dir');
  writeFileSync(file, 'x');
  return join(file, 'gitlab-upgrade');
}

test('без прав на stateDir настройки прокси всё равно пишутся', () => {
  // `proxy test` заявлен как команда без root — и запускают её именно до
  // того, как получили sudo. До 0.1.1 она падала с EACCES на /var/lib,
  // то есть диагностика была недоступна ровно там, где она нужна.
  const conf = openAptConf({ stateDir: unusableDir(), proxy: 'socks5h://10.0.0.5:1080' });
  assert.match(readFileSync(conf.path, 'utf8'), /10\.0\.0\.5/);
  // Пароль прокси лежит в этом файле: права те же, что и в /var/lib.
  assert.equal(statSync(conf.path).mode & 0o777, 0o600);
  // Имя каталога случайное: по предсказуемому сосед по машине заранее
  // подставил бы симлинк, и пароль ушёл бы в читаемый им файл.
  assert.ok(!existsSync(join(tmpdir(), `gitlab-upgrade-${process.getuid?.() ?? 0}`)));
  conf.cleanup();
  assert.equal(existsSync(conf.path), false, 'после себя ничего не оставляем');
});

test('там, где stateDir доступен, файл ложится именно туда', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'state-')), 'gitlab-upgrade');
  const conf = openAptConf({ stateDir: state, proxy: 'http://10.0.0.5:8080' });
  assert.equal(dirname(conf.path), state);
  conf.cleanup();
  assert.equal(existsSync(conf.path), false);
});

test('в отказе показывается ошибка, а не предупреждение рядом с ней', () => {
  // Настоящий вывод apt: W: стоит первым, а причина отказа — в E:.
  const apt = 'W: GPG error: https://packages.gitlab.com/… InRelease: NO_PUBKEY 3F01618A51312F3F\n'
    + "E: The repository 'https://packages.gitlab.com/… focal InRelease' is not signed.\n";
  assert.match(errorDetail(apt), /^E: The repository/);
  // Если ничего кроме предупреждений нет — лучше показать их, чем промолчать.
  assert.match(errorDetail('W: только предупреждение\n'), /^W:/);
  assert.equal(errorDetail(''), '');
});
