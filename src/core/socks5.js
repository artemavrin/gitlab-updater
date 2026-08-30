import net from 'node:net';

/**
 * Минимальный клиент SOCKS5 (RFC 1928 + 1929).
 *
 * Всегда резолвим имя на стороне прокси (семантика socks5h, ATYP=domain):
 * на изолированном сервере packages.gitlab.com локально не резолвится,
 * и обычный socks5 упал бы с невнятной ошибкой DNS.
 */
export function socksConnect({ proxyHost, proxyPort, host, port, username, password, timeout = 15_000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    const fail = (msg) => {
      socket.destroy();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail(`SOCKS5: таймаут ${timeout} мс на этапе ${stage}`), timeout);
    const finish = (err) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (err) fail(err);
      else resolve(socket);
    };

    socket.on('error', (e) => { clearTimeout(timer); reject(e); });

    socket.on('connect', () => {
      const methods = username ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });

    function sendConnect() {
      stage = 'connect';
      const name = Buffer.from(host, 'utf8');
      const req = Buffer.alloc(7 + name.length);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
      req[4] = name.length;
      name.copy(req, 5);
      req.writeUInt16BE(port, 5 + name.length);
      socket.write(req);
    }

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const method = buf[1];
        buf = buf.subarray(2);
        if (method === 0x00) { sendConnect(); }
        else if (method === 0x02) {
          if (!username) return finish('SOCKS5: прокси требует авторизацию, а логин не задан');
          stage = 'auth';
          const u = Buffer.from(username, 'utf8');
          const p = Buffer.from(password ?? '', 'utf8');
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        } else {
          return finish('SOCKS5: прокси не принял ни один метод авторизации');
        }
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        const status = buf[1];
        buf = buf.subarray(2);
        if (status !== 0x00) return finish('SOCKS5: логин или пароль отклонены прокси');
        sendConnect();
      }

      if (stage === 'connect') {
        if (buf.length < 5) return;
        const reply = buf[1];
        if (reply !== 0x00) return finish(`SOCKS5: прокси отказал в CONNECT (код ${reply}): ${SOCKS_ERRORS[reply] ?? 'неизвестная причина'}`);
        const atyp = buf[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x03 ? buf[4] + 1 : 16;
        const total = 4 + addrLen + 2;
        if (buf.length < total) return;
        socket.unshift(buf.subarray(total));
        finish(null);
      }
    }

    socket.on('data', onData);
  });
}

const SOCKS_ERRORS = {
  0x01: 'общий сбой сервера',
  0x02: 'соединение запрещено правилами',
  0x03: 'сеть недоступна',
  0x04: 'хост недоступен',
  0x05: 'соединение отклонено',
  0x06: 'истёк TTL',
  0x07: 'команда не поддерживается',
  0x08: 'тип адреса не поддерживается',
};
