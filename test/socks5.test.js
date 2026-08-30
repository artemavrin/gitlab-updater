import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { socksConnect } from '../src/core/socks5.js';

/** Поддельный SOCKS5-сервер: сеть тестируется без сети. */
function fakeSocks({ requireAuth = false, password = 'p', reply = 0x00 } = {}) {
  const seen = { host: null, port: null, user: null };
  const server = net.createServer((sock) => {
    let stage = 'greeting';
    sock.on('data', (buf) => {
      if (stage === 'greeting') {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        if (requireAuth) {
          if (!methods.includes(0x02)) return sock.end(Buffer.from([0x05, 0xff]));
          stage = 'auth';
          return sock.write(Buffer.from([0x05, 0x02]));
        }
        stage = 'connect';
        return sock.write(Buffer.from([0x05, 0x00]));
      }
      if (stage === 'auth') {
        const ulen = buf[1];
        seen.user = buf.subarray(2, 2 + ulen).toString();
        const plen = buf[2 + ulen];
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        stage = 'connect';
        return sock.write(Buffer.from([0x01, pass === password ? 0x00 : 0x01]));
      }
      if (stage === 'connect') {
        const len = buf[4];
        seen.host = buf.subarray(5, 5 + len).toString();
        seen.port = buf.readUInt16BE(5 + len);
        sock.write(Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (reply === 0x00) { stage = 'tunnel'; sock.write('HELLO'); }
        return;
      }
    });
    sock.on('error', () => {});
  });
  return { server, seen, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

test('рукопожатие без авторизации и туннель до имени хоста', async () => {
  const f = fakeSocks();
  const port = await f.listen();
  const sock = await socksConnect({ proxyHost: '127.0.0.1', proxyPort: port, host: 'packages.gitlab.com', port: 443 });
  const data = await new Promise((r) => sock.once('data', r));
  assert.equal(data.toString(), 'HELLO');
  // socks5h: имя резолвит прокси, а не мы — на изолированном сервере иначе никак
  assert.equal(f.seen.host, 'packages.gitlab.com');
  assert.equal(f.seen.port, 443);
  sock.destroy(); f.server.close();
});

test('авторизация логином и паролем', async () => {
  const f = fakeSocks({ requireAuth: true, password: 's3cret' });
  const port = await f.listen();
  const sock = await socksConnect({ proxyHost: '127.0.0.1', proxyPort: port, host: 'example.com', port: 80, username: 'svc', password: 's3cret' });
  assert.equal(f.seen.user, 'svc');
  sock.destroy(); f.server.close();
});

test('неверный пароль даёт понятную ошибку, а не зависание', async () => {
  const f = fakeSocks({ requireAuth: true, password: 'right' });
  const port = await f.listen();
  await assert.rejects(
    () => socksConnect({ proxyHost: '127.0.0.1', proxyPort: port, host: 'example.com', port: 80, username: 'svc', password: 'wrong' }),
    (e) => e.code === 'socks-auth-rejected'
  );
  f.server.close();
});

test('прокси требует авторизацию, а логина нет — говорим об этом прямо', async () => {
  const f = fakeSocks({ requireAuth: true });
  const port = await f.listen();
  await assert.rejects(
    () => socksConnect({ proxyHost: '127.0.0.1', proxyPort: port, host: 'example.com', port: 80 }),
    (e) => e.code === 'socks-no-method'
  );
  f.server.close();
});

test('отказ прокси в CONNECT расшифровывается', async () => {
  const f = fakeSocks({ reply: 0x02 });
  const port = await f.listen();
  await assert.rejects(
    () => socksConnect({ proxyHost: '127.0.0.1', proxyPort: port, host: 'packages.gitlab.com', port: 443 }),
    (e) => e.code === 'socks-refused' && e.params.why === 'socks.forbidden'
  );
  f.server.close();
});

test('молчащий прокси обрывается по таймауту, а не висит вечно', async () => {
  const server = net.createServer(() => {});
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  await assert.rejects(
    () => socksConnect({ proxyHost: '127.0.0.1', proxyPort: port, host: 'x', port: 1, timeout: 150 }),
    (e) => e.code === 'socks-timeout'
  );
  server.close();
});
