import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { probeProxy, UBUNTU_HOST } from '../src/net/probe.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandProxyTest } from '../src/commands/proxyTest.js';
import { createExec, MODE } from '../src/core/exec.js';
import { createTranslator, LOCALES } from '../src/i18n/index.js';
import { remedyFor } from '../src/checks/remedies.js';
import { LEVEL } from '../src/core/events.js';
import { EXIT } from '../src/plan/planner.js';

/**
 * Сеть проверяется без сети: поддельный SOCKS5 и поддельный HTTP-CONNECT
 * на node:net. Пробы обязаны падать на том рубеже, где рвётся, — иначе
 * команда не решает задачу, ради которой написана.
 */
function fakeSocks({ reply = 0x00, requireAuth = false, silent = false } = {}) {
  const server = net.createServer((sock) => {
    if (silent) return;
    let stage = 'greeting';
    sock.on('data', (buf) => {
      if (stage === 'greeting') {
        if (requireAuth) { stage = 'auth'; return sock.write(Buffer.from([0x05, 0x02])); }
        stage = 'connect';
        return sock.write(Buffer.from([0x05, 0x00]));
      }
      if (stage === 'auth') { stage = 'connect'; return sock.write(Buffer.from([0x01, 0x01])); }
      if (stage === 'connect') {
        sock.write(Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (reply === 0x00) stage = 'tunnel';
      }
    });
    sock.on('error', () => {});
  });
  return { server, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

/** HTTP-прокси, отвечающий на CONNECT заданным кодом. */
function fakeHttpProxy({ status = 200 } = {}) {
  const server = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write(`HTTP/1.1 ${status} ${status === 200 ? 'Connection Established' : 'Forbidden'}\r\n\r\n`);
      if (status !== 200) sock.end();
    });
    sock.on('error', () => {});
  });
  return { server, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

const t = createTranslator('ru');
const at = (steps, id) => steps.find((s) => s.id === id) ?? null;
const lastLevel = (steps) => steps[steps.length - 1].level;

test('неразбираемый URL прокси не доходит даже до TCP', async () => {
  const steps = await probeProxy({ proxyUrl: 'ftp://box:1080', t });
  assert.equal(steps.length, 1);
  assert.equal(at(steps, 'proxy-config').level, LEVEL.CRITICAL);
});

test('прокси не слушает — падает TCP, и дальше не идём', async () => {
  // Порт, который точно никто не слушает: сервер поднят и сразу закрыт.
  const probe = fakeSocks();
  const port = await probe.listen();
  await new Promise((r) => probe.server.close(r));

  const steps = await probeProxy({ proxyUrl: `socks5h://127.0.0.1:${port}`, t, timeout: 2000 });
  assert.equal(at(steps, 'proxy-config').level, LEVEL.OK);
  assert.equal(at(steps, 'proxy-tcp').level, LEVEL.CRITICAL);
  // Шесть одинаковых ошибок подряд только прячут первую.
  assert.equal(at(steps, 'proxy-handshake'), null);
});

test('прокси запретил туннель — виден именно CONNECT, а не рукопожатие', async () => {
  const f = fakeSocks({ reply: 0x02 });
  const port = await f.listen();
  const steps = await probeProxy({ proxyUrl: `socks5h://127.0.0.1:${port}`, t, timeout: 2000 });
  f.server.close();

  assert.equal(at(steps, 'proxy-tcp').level, LEVEL.OK);
  assert.equal(at(steps, 'proxy-connect').level, LEVEL.CRITICAL);
  assert.equal(at(steps, 'proxy-handshake'), null, 'рукопожатие прошло — винить его нельзя');
  assert.match(at(steps, 'proxy-connect').params.detail, /SOCKS5/);
});

test('HTTP-прокси ответил 403 — тоже CONNECT, а не рукопожатие', async () => {
  const f = fakeHttpProxy({ status: 403 });
  const port = await f.listen();
  const steps = await probeProxy({ proxyUrl: `http://127.0.0.1:${port}`, t, timeout: 2000 });
  f.server.close();
  assert.equal(at(steps, 'proxy-connect').level, LEVEL.CRITICAL);
  assert.match(at(steps, 'proxy-connect').params.detail, /403/);
});

test('туннель есть, но TLS не поднимается — падает именно TLS', async () => {
  // Поддельный прокси отдаёт открытый сокет: TLS-рукопожатия на нём не будет.
  const f = fakeHttpProxy({ status: 200 });
  const port = await f.listen();
  const steps = await probeProxy({ proxyUrl: `http://127.0.0.1:${port}`, t, timeout: 2000 });
  f.server.close();

  assert.equal(at(steps, 'proxy-connect').level, LEVEL.OK);
  const tlsStep = at(steps, 'proxy-tls') ?? at(steps, 'proxy-tls-intercepted');
  assert.ok(tlsStep, 'рубеж TLS должен быть в отчёте');
  assert.equal(tlsStep.level, LEVEL.CRITICAL);
  assert.equal(at(steps, 'proxy-http'), null);
});

test('без прокси команда не молчит, а говорит, что идёт напрямую', async () => {
  const exec = createExec({
    mode: MODE.REPLAY,
    fixtures: { 'apt-cache madison gitlab-ee': { code: 0, stdout: ' gitlab-ee | 17.11.7-ee.0 | ...\n' } },
  });
  const steps = await probeProxy({ proxyUrl: null, t, exec });
  assert.equal(at(steps, 'proxy-none').level, LEVEL.WARN);
  assert.equal(at(steps, 'apt-repo').level, LEVEL.OK);
  assert.equal(at(steps, 'apt-repo').params.n, 1);
  // Прямой путь не проверяет доступность Ubuntu мимо прокси — нечего проверять.
  assert.equal(at(steps, 'apt-direct'), null);
});

test('apt не видит версий — это отказ, даже если HTTP прошёл', async () => {
  // Успешный HTTP-запрос ещё ничего не гарантирует: apt ходит своим кодом.
  const exec = createExec({
    mode: MODE.REPLAY,
    fixtures: { 'apt-cache madison gitlab-ee': { code: 100, stdout: '', stderr: 'E: репозиторий недоступен' } },
  });
  const steps = await probeProxy({ proxyUrl: null, t, exec });
  assert.equal(at(steps, 'apt-repo').level, LEVEL.CRITICAL);
});

test('конфиг прокси уходит в apt тем же файлом, что при установке', async () => {
  const seen = [];
  const exec = createExec({
    mode: MODE.REPLAY,
    fixtures: { 'apt-cache -c /tmp/apt.conf madison gitlab-ee': { code: 0, stdout: ' gitlab-ee | 17.11.7-ee.0 | x\n' } },
  });
  const wrapped = (argv, opts) => { seen.push(argv.join(' ')); return exec(argv, opts); };
  const steps = await probeProxy({ proxyUrl: null, t, exec: wrapped, confPath: '/tmp/apt.conf' });
  // Проверять другой набор настроек — проверять не то.
  assert.ok(seen.some((c) => c.includes('-c /tmp/apt.conf')), seen.join(' | '));
  assert.equal(at(steps, 'apt-repo').level, LEVEL.OK);
});

test('команда возвращает код ошибки, когда цепочка рвётся', async () => {
  const res = await commandProxyTest({
    t, flags: {}, config: { proxy: 'ftp://x:1' }, sources: { proxy: 'флаг' }, exec: null, confPath: null,
  });
  assert.equal(res.code, EXIT.ERROR);
  assert.equal(res.errorCode, 'proxy-unreachable');
  assert.equal(res.verdict, 'probe.broken');
  assert.equal(res.result.critical, 1);
});

test('пароль прокси не уходит в --json', async () => {
  const res = await commandProxyTest({
    t, flags: {}, config: { proxy: 'socks5h://user:s3cret@127.0.0.1:1' },
    sources: {}, exec: null, confPath: null, timeout: 500,
  });
  const json = JSON.stringify(res.result);
  assert.ok(!json.includes('s3cret'), json);
  assert.match(res.result.proxy, /\*\*\*/);
});

for (const locale of Object.keys(LOCALES)) {
  test(`каждый рубеж переведён и укладывается в 78 колонок — ${locale}`, async () => {
    const tr = createTranslator(locale);
    const { renderFindings } = await import('../src/commands/doctor.js');
    // Все возможные исходы разом, с правдоподобно длинными параметрами.
    const steps = [
      { check: 'proxy', id: 'proxy-config', level: LEVEL.OK, params: { kind: 'socks5', host: '10.0.0.5', port: 1080, source: '/etc/gitlab-upgrade/config.json' } },
      { check: 'proxy', id: 'proxy-tcp', level: LEVEL.OK, params: { host: '10.0.0.5', port: 1080, ms: 12 } },
      { check: 'proxy', id: 'proxy-handshake', level: LEVEL.OK, params: { kind: 'socks5', auth: tr('probe.auth.password'), ms: 8 } },
      { check: 'proxy', id: 'proxy-connect', level: LEVEL.OK, params: { host: 'packages.gitlab.com', port: 443 } },
      { check: 'proxy', id: 'proxy-tls', level: LEVEL.OK, params: { host: 'packages.gitlab.com', issuer: 'DigiCert Inc', validTo: 'Jan 14 2027' } },
      { check: 'proxy', id: 'proxy-tls-intercepted', level: LEVEL.CRITICAL, params: { host: 'packages.gitlab.com', detail: 'self-signed certificate in certificate chain' } },
      { check: 'proxy', id: 'proxy-http', level: LEVEL.OK, params: { host: 'packages.gitlab.com', status: 200, ms: 140, detail: '' } },
      { check: 'proxy', id: 'apt-repo', level: LEVEL.OK, params: { n: 398 } },
      { check: 'proxy', id: 'apt-direct', level: LEVEL.WARN, params: { host: 'archive.ubuntu.com', detail: 'нет TCP-соединения за 5000 мс' } },
      { check: 'proxy', id: 'proxy-none', level: LEVEL.WARN, params: {} },
    ];
    for (const line of renderFindings(tr, steps)) {
      assert.ok([...line].length <= 78, `${locale}: ${[...line].length} — «${line}»`);
      assert.ok(!/\{\w+\}/.test(line), `${locale}: неподставленный параметр — «${line}»`);
    }
    // Перехват TLS лечится своим CA, а не отключением проверки.
    assert.equal(remedyFor({ id: 'proxy-tls-intercepted', level: LEVEL.CRITICAL }).flag, '--proxy-ca');
  });
}

test('TLS-проба не отключает проверку сертификата', async () => {
  // Инвариант дороже любого удобства: проба, которая «для диагностики»
  // доверяет всему, однажды станет обоснованием так же поступить в бою.
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/net/probe.js', 'utf8'));
  assert.ok(!/rejectUnauthorized/.test(src), 'в пробе не должно быть rejectUnauthorized');
  assert.ok(!/NODE_TLS_REJECT/.test(src));
  void tls;
});

test('socks5h показывается как socks5h — имя резолвит прокси', async () => {
  const f = fakeSocks({ reply: 0x02 });
  const port = await f.listen();
  const steps = await probeProxy({ proxyUrl: `socks5h://127.0.0.1:${port}`, t, timeout: 2000 });
  f.server.close();
  // Разница socks5 и socks5h — ровно в том, кто резолвит имя, и на
  // изолированном сервере это первое, о чём спрашивают.
  assert.equal(at(steps, 'proxy-config').params.kind, 'socks5h');
  // Даже если в конфиге написали socks5 — ходим мы всё равно с ATYP=domain.
  const plain = await probeProxy({ proxyUrl: `socks5://127.0.0.1:${port}`, t, timeout: 2000 });
  assert.equal(at(plain, 'proxy-config').params.kind, 'socks5h');
});

test('при неуспехе конверт несёт находки, а не стену текста', async () => {
  const { fail } = await import('../src/cli/envelope.js');
  const envelope = fail('proxy-test', {
    version: '0.1.0', code: 'proxy-unreachable', message: 'коротко',
    result: { findings: [{ id: 'proxy-tcp', level: LEVEL.CRITICAL }] },
  });
  // Структура нужна агенту именно в этот момент, а не когда всё хорошо.
  assert.equal(envelope.result.findings.length, 1);
  assert.equal(envelope.error.code, 'proxy-unreachable');
});

/**
 * Прокси, который открывает туннель и обрывает TLS.
 *
 * Так выглядит фильтрация по SNI, и это самый частый вид «прокси есть, а
 * пакетов не видно». `serveTlsFor` — хост, которому этот прокси TLS всё-таки
 * отдаёт: по нему и отличается «прокси сломан» от «закрыт этот адрес».
 */
function fakeSocksCuttingTls({ serveTlsFor = null, key = null, cert = null } = {}) {
  const asked = [];
  const server = net.createServer((sock) => {
    let stage = 'greeting';
    sock.on('data', (buf) => {
      if (stage === 'greeting') { stage = 'connect'; return sock.write(Buffer.from([0x05, 0x00])); }
      if (stage !== 'connect') return;
      stage = 'tunnel';
      // ATYP 0x03 — имя хоста: длина, затем имя. Именно по нему и фильтруют.
      const host = buf[3] === 0x03 ? buf.subarray(5, 5 + buf[4]).toString() : '';
      asked.push(host);
      sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      if (serveTlsFor && host === serveTlsFor) {
        sock.removeAllListeners('data');
        const secured = new tls.TLSSocket(sock, { isServer: true, key, cert });
        secured.on('error', () => {});
        return;
      }
      sock.destroy();
    });
    sock.on('error', () => {});
  });
  return { server, asked, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

/**
 * Самая дорогая из найденных ошибок: в вызове socksConnect спред `...proxy`
 * стоял после host и port и перезаписывал их адресом самого прокси. Туннель
 * открывался к прокси, а диагностика писала «CONNECT packages.gitlab.com — ок».
 * Человек на боевой машине читал зелёную строку про хост, к которому никто не
 * ходил, и искал причину не там. Тот же вызов был в openSocket, то есть
 * уведомления через SOCKS не уходили никуда.
 */
test('SOCKS-туннель открывается к цели, а не к самому прокси', async () => {
  const proxy = fakeSocksCuttingTls();
  const port = await proxy.listen();
  try {
    await probeProxy({ proxyUrl: `socks5h://127.0.0.1:${port}`, t, timeout: 2000 });
    assert.ok(proxy.asked.length > 0, 'CONNECT вообще не дошёл');
    assert.equal(proxy.asked[0], 'packages.gitlab.com');
    assert.ok(!proxy.asked.includes('127.0.0.1'), `прокси просили сходить к себе: ${proxy.asked.join(', ')}`);
  } finally {
    await new Promise((r) => proxy.server.close(r));
  }
});

test('обрыв рукопожатия не называется отказом по сертификату', async () => {
  // Настоящий вывод с боевой машины: CONNECT прошёл, а TLS оборвали. Пока
  // это называлось «сертификат не принят», человек шёл искать CA там, где
  // его нет, — на закрытом контуре это дни.
  const proxy = fakeSocksCuttingTls();
  const port = await proxy.listen();
  try {
    const steps = await probeProxy({ proxyUrl: `socks5h://127.0.0.1:${port}`, t, timeout: 2000 });
    assert.equal(at(steps, 'proxy-connect')?.level, LEVEL.OK, 'туннель обязан открыться');
    const tlsStep = steps[steps.length - 1];
    assert.equal(tlsStep.id, 'proxy-tls-closed');
    assert.ok(!/сертификат/.test(t(`check.${tlsStep.id}.critical`, tlsStep.params)),
      'про сертификат здесь речи нет');
  } finally {
    await new Promise((r) => proxy.server.close(r));
  }
});

/**
 * Сертификат делаем на месте: держать ключ в репозитории нельзя даже
 * тестовый — однажды его найдут и решат, что он настоящий.
 */
function selfSignedFor(host) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-tls-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
      '-days', '2', '-nodes', '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`],
    { stdio: 'pipe' });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null; // без openssl эту ветку не проверить
  }
  return { dir, key: readFileSync(key), cert: readFileSync(cert), caPath: cert };
}

test('«закрыт этот адрес» отличается от «прокси не работает»', async () => {
  // Разница между этими двумя выводами — это разные люди, к которым идти:
  // сетевой администратор про один адрес или владелец прокси про весь прокси.
  const tlsCert = selfSignedFor(UBUNTU_HOST);
  if (!tlsCert) return;
  const proxy = fakeSocksCuttingTls({ serveTlsFor: UBUNTU_HOST, key: tlsCert.key, cert: tlsCert.cert });
  const port = await proxy.listen();
  try {
    const steps = await probeProxy({
      proxyUrl: `socks5h://127.0.0.1:${port}`, t, timeout: 2000, ca: tlsCert.caPath,
    });
    const tlsStep = steps[steps.length - 1];
    assert.equal(tlsStep.id, 'proxy-tls-filtered');
    // В сообщении обязан быть назван контрольный хост: без него это утверждение
    // ничем не подкреплено.
    assert.equal(tlsStep.params.control, UBUNTU_HOST);
    assert.match(t(`check.${tlsStep.id}.critical`, tlsStep.params), /archive\.ubuntu\.com/);
  } finally {
    await new Promise((r) => proxy.server.close(r));
    rmSync(tlsCert.dir, { recursive: true, force: true });
  }
});

const GREP_SOURCES = 'grep -rl packages.gitlab.com /etc/apt/sources.list /etc/apt/sources.list.d/';
const LS_LISTS = 'ls -1 /var/lib/apt/lists';

/**
 * Настоящий вывод с боевой машины: прокси проходит целиком до HTTP 200, а
 * последний рубеж говорит «apt не видит ни одной версии: причина не названа».
 *
 * Причина не названа потому, что её нет: `apt-cache madison` читает только
 * локальные списки и в сеть не ходит, поэтому при нескачанных списках он
 * выходит с кодом 0, пустым stdout и пустым stderr. Проверено на живом apt.
 * Пока это выглядело как отказ прокси, человек чинил то, что не сломано.
 */
test('нескачанные списки apt называются прямо, а не «причина не названа»', async () => {
  const exec = createExec({
    mode: MODE.REPLAY,
    fixtures: {
      [GREP_SOURCES]: { code: 0, stdout: '/etc/apt/sources.list.d/gitlab_gitlab-ee.list\n' },
      // Списки есть, но только Ubuntu: репозиторий GitLab не скачан ни разу.
      [LS_LISTS]: { code: 0, stdout: 'archive.ubuntu.com_ubuntu_dists_focal_main_binary-amd64_Packages\nlock\n' },
      'apt-cache madison gitlab-ee': { code: 0, stdout: '', stderr: '' },
    },
  });
  const steps = await probeProxy({ proxyUrl: null, t, exec });
  const last = steps[steps.length - 1];
  assert.equal(last.id, 'apt-not-updated');
  assert.equal(last.level, LEVEL.CRITICAL);
  // Починка обязана быть названа: без неё это тупик.
  const remedy = remedyFor({ id: last.id, level: last.level, params: last.params });
  assert.deepEqual(remedy?.argv, ['apt-get', 'update']);
});

test('скачанные списки без gitlab-ee — другой диагноз, и тоже названный', async () => {
  const exec = createExec({
    mode: MODE.REPLAY,
    fixtures: {
      [GREP_SOURCES]: { code: 0, stdout: '/etc/apt/sources.list.d/gitlab_gitlab-ee.list\n' },
      [LS_LISTS]: { code: 0, stdout: 'packages.gitlab.com_gitlab_gitlab-ee_ubuntu_dists_focal_main_binary-amd64_Packages\n' },
      'apt-cache madison gitlab-ee': { code: 0, stdout: '', stderr: '' },
    },
  });
  const steps = await probeProxy({ proxyUrl: null, t, exec });
  const last = steps[steps.length - 1];
  assert.equal(last.id, 'apt-repo');
  // «причина не названа» — признание бесполезности; здесь причина есть.
  assert.notEqual(last.params.detail, t('probe.noDetail'));
  assert.match(last.params.detail, /gitlab-ee/);
});
