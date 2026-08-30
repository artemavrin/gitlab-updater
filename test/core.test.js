import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactUrl } from '../src/core/redact.js';
import { createExec, MODE, ExecError } from '../src/core/exec.js';
import { EventBus } from '../src/core/events.js';
import { renderAptConf } from '../src/net/aptProxy.js';
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
  assert.deepEqual(parseProxy('socks5h://u:p@10.0.0.5:1080'), { kind: 'socks5', host: '10.0.0.5', port: 1080, username: 'u', password: 'p' });
  assert.equal(parseProxy('http://10.0.0.5:8080').kind, 'http');
  assert.equal(parseProxy(null), null);
  assert.throws(() => parseProxy('ftp://x'), /неизвестный тип прокси/);
});
