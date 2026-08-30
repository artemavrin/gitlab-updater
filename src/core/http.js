import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import { socksConnect } from './socks5.js';
import { NetError, NET } from './netError.js';

/**
 * Единственная точка сетевых запросов приложения.
 *
 * Node 22 не умеет ходить через прокси без зависимостей, поэтому туннель
 * строим сами: HTTP-прокси — методом CONNECT, SOCKS5 — своим клиентом.
 * Проверка сертификата не отключается никогда; для корпоративного
 * перехвата есть отдельный CA (`proxy-ca`).
 */
export const postJson = (url, data, opts = {}) => request(url, {
  ...opts, method: 'POST', body: JSON.stringify(data),
  headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
});

export function parseProxy(url) {
  if (!url) return null;
  const u = new URL(url);
  const kind = u.protocol.replace(':', '');
  if (!['http', 'https', 'socks5', 'socks5h'].includes(kind)) {
    throw new NetError(NET.PROXY_SCHEME, { scheme: u.protocol.replace(':', '') });
  }
  return {
    kind: kind.startsWith('socks') ? 'socks5' : 'http',
    // Имя резолвит прокси всегда (ATYP=domain), поэтому в диагностике
    // показываем socks5h, а не socks5: разница — ровно в том, кто резолвит,
    // и на изолированном сервере это первое, о чём спрашивают.
    scheme: kind.startsWith('socks') ? 'socks5h' : kind,
    host: u.hostname,
    port: Number(u.port) || (kind === 'http' ? 8080 : 1080),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

export function connectViaHttpProxy({ proxy, host, port, timeout }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.username) {
      const cred = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64');
      headers['Proxy-Authorization'] = `Basic ${cred}`;
    }
    const req = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${host}:${port}`, headers, timeout,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new NetError(NET.PROXY_CONNECT, { status: res.statusCode, reason: res.statusMessage ?? '' }));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => { req.destroy(new NetError(NET.PROXY_TIMEOUT, { timeout })); });
    req.on('error', reject);
    req.end();
  });
}

async function openSocket({ proxy, host, port, timeout }) {
  if (!proxy) {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port, timeout });
      s.once('connect', () => resolve(s));
      s.once('timeout', () => { s.destroy(); reject(new NetError(NET.TCP_TIMEOUT, { timeout })); });
      s.once('error', reject);
    });
  }
  if (proxy.kind === 'socks5') {
    return socksConnect({ proxyHost: proxy.host, proxyPort: proxy.port, host, port, ...proxy, timeout });
  }
  return connectViaHttpProxy({ proxy, host, port, timeout });
}

export async function request(url, { proxy = null, ca = null, timeout = 20_000, headers = {}, method = 'GET', body = null } = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const raw = await openSocket({ proxy, host: u.hostname, port, timeout });

  const socket = secure
    ? await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: raw, servername: u.hostname, ca: ca ?? undefined }, () => resolve(t));
        t.once('error', reject);
      })
    : raw;

  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new NetError(NET.READ_TIMEOUT, { timeout })); }, timeout);

    socket.on('data', (c) => { data = Buffer.concat([data, c]); });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
    socket.on('end', () => {
      clearTimeout(timer);
      const sep = data.indexOf('\r\n\r\n');
      if (sep < 0) return reject(new NetError(NET.TRUNCATED));
      const head = data.subarray(0, sep).toString('latin1').split('\r\n');
      const status = Number(head[0].split(' ')[1]);
      const resHeaders = Object.fromEntries(head.slice(1).map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()];
      }));
      resolve({ status, headers: resHeaders, body: data.subarray(sep + 4).toString('utf8') });
    });

    const path = u.pathname + u.search;
    const payload = body === null ? null : Buffer.from(body, 'utf8');
    const all = {
      Host: u.hostname,
      Connection: 'close',
      'User-Agent': 'gitlab-upgrade',
      ...(payload ? { 'Content-Length': String(payload.length) } : {}),
      ...headers,
    };
    socket.write(
      `${method} ${path} HTTP/1.1\r\n` +
      Object.entries(all).map(([k, v]) => `${k}: ${v}\r\n`).join('') +
      `\r\n`
    );
    if (payload) socket.write(payload);
  });
}
