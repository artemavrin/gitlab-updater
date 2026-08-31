import net from 'node:net';
import tls from 'node:tls';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSocket, parseProxy, request } from '../core/http.js';
import { errorDetail } from '../core/exec.js';
import { NetError, NET, netMessage } from '../core/netError.js';
import { GITLAB_REPO_HOST, GITLAB_DOWNLOAD_HOST } from './aptProxy.js';
import { LEVEL } from '../core/events.js';

/**
 * Пробы прокси — по одной на каждый рубеж, где связь рвётся.
 *
 * Смысл разбиения именно такой: «пакетов не видно» — самый дорогой класс
 * обращений, потому что причина может быть в шести разных местах. Проба,
 * которая падает одна, называет место сразу.
 *
 * Все пробы читающие. Проверку сертификата не отключает ни одна: для
 * корпоративного перехвата есть `--proxy-ca`.
 */

export const UBUNTU_HOST = 'archive.ubuntu.com';

// check совпадает с id: у каждого рубежа свой заголовок, иначе в отчёте
// девять раз подряд стоит слово «прокси» и читать его незачем.
const finding = (id, level, params = {}) => ({ check: id, id, level, params });
const ok = (id, params) => finding(id, LEVEL.OK, params);
const fail = (id, params) => finding(id, LEVEL.CRITICAL, params);
const warn = (id, params) => finding(id, LEVEL.WARN, params);

/** Причина отказа — всегда переведённой строкой, а не «[object Object]». */
const why = (err, t) => netMessage(err, t);

const ms = (started) => Date.now() - started;

function tcpProbe({ host, port, timeout }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.connect({ host, port, timeout });
    socket.once('connect', () => { socket.destroy(); resolve(ms(started)); });
    socket.once('timeout', () => { socket.destroy(); reject(new NetError(NET.TCP_TIMEOUT, { timeout })); });
    socket.once('error', (e) => { socket.destroy(); reject(e); });
  });
}

/**
 * Туннель до узла назначения — тем же кодом, что в рабочем пути.
 * Своя реализация в пробе разошлась бы с рабочей, и проверка перестала бы
 * проверять то, чем пользуются.
 */
const tunnel = ({ proxy, host, port, timeout }) => openSocket({ proxy, host, port, timeout });

/** Обрыв на рукопожатии, а не отказ по сертификату. */
function closedDuringHandshake(err) {
  return /socket disconnected before secure|ECONNRESET|EPIPE|socket hang up/i.test(
    `${err?.message ?? ''} ${err?.code ?? ''}`);
}

/**
 * Тот же туннель до контрольного хоста: отвечает ли TLS хоть кому-нибудь.
 * Своё соединение и свой try — упасть эта проба права не имеет, она только
 * уточняет диагноз.
 */
async function tlsWorks({ proxy, host, ca, timeout }) {
  let socket = null;
  try {
    socket = await tunnel({ proxy, host, port: 443, timeout });
    await tlsProbe(socket, { host, ca: readCa(ca), timeout });
    return true;
  } catch {
    return false;
  } finally {
    socket?.destroy();
  }
}

function tlsProbe(socket, { host, ca, timeout }) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername: host, ca: ca ?? undefined }, () => {
      const cert = t.getPeerCertificate();
      t.destroy();
      resolve({
        issuer: cert?.issuer?.O ?? cert?.issuer?.CN ?? null,
        validTo: cert?.valid_to ?? null,
      });
    });
    t.setTimeout(timeout, () => { t.destroy(); reject(new NetError(NET.READ_TIMEOUT, { timeout })); });
    t.once('error', (e) => { t.destroy(); reject(e); });
  });
}

/**
 * Полная последовательность. Останавливается на первом отказе: продолжать
 * после «нет TCP» бессмысленно, а шесть одинаковых ошибок подряд только
 * прячут первую.
 */
export async function probeProxy({
  proxyUrl, source = null, ca = null, host = GITLAB_REPO_HOST, timeout = 15_000, t,
  exec = null, confPath = null,
}) {
  const steps = [];
  const add = (f) => { steps.push(f); return f; };

  if (!proxyUrl) {
    add(warn('proxy-none'));
    if (exec) await aptProbes({ steps, add, exec, confPath, t, direct: true });
    return steps;
  }

  let proxy;
  try {
    proxy = parseProxy(proxyUrl);
  } catch (err) {
    add(fail('proxy-config', { detail: why(err, t) }));
    return steps;
  }
  add(ok('proxy-config', { kind: proxy.scheme, host: proxy.host, port: proxy.port, source: source ?? '\u2014' }));

  try {
    const took = await tcpProbe({ host: proxy.host, port: proxy.port, timeout });
    add(ok('proxy-tcp', { host: proxy.host, port: proxy.port, ms: took }));
  } catch (err) {
    add(fail('proxy-tcp', { host: proxy.host, port: proxy.port, detail: why(err, t) }));
    return steps;
  }

  let socket;
  try {
    const started = Date.now();
    socket = await tunnel({ proxy, host, port: 443, timeout });
    add(ok('proxy-handshake', {
      kind: proxy.scheme,
      auth: proxy.username ? t('probe.auth.password') : t('probe.auth.none'),
      ms: ms(started),
    }));
    add(ok('proxy-connect', { host, port: 443 }));
  } catch (err) {
    // Отказ приходит либо на рукопожатии, либо на CONNECT: код ошибки
    // различает их точнее, чем порядок вызовов.
    const onConnect = err instanceof NetError
      && [NET.SOCKS_REFUSED, NET.PROXY_CONNECT].includes(err.code);
    add(fail(onConnect ? 'proxy-connect' : 'proxy-handshake', { host, detail: why(err, t) }));
    return steps;
  }

  try {
    const cert = await tlsProbe(socket, { host, ca: readCa(ca), timeout });
    add(ok('proxy-tls', { host, issuer: cert.issuer ?? '—', validTo: cert.validTo ?? '—' }));
  } catch (err) {
    socket.destroy();
    // Самопроверяемый сертификат в цепочке — почти всегда перехват TLS на
    // прокси, и лечится он отдельным CA, а не отключением проверки.
    if (/self.signed|unable to verify|UNABLE_TO_(GET|VERIFY)/i.test(err.message ?? '')) {
      add(fail('proxy-tls-intercepted', { host, detail: why(err, t) }));
      return steps;
    }
    // Соединение закрыли посреди рукопожатия — это не про сертификат вообще.
    // Так выглядит фильтрация по SNI: туннель до хоста открылся, а TLS к нему
    // обрывают. Называть это «сертификат не принят» — отправлять человека
    // искать CA там, где его нет.
    if (closedDuringHandshake(err)) {
      const control = await tlsWorks({ proxy, host: UBUNTU_HOST, ca, timeout });
      // Контрольный хост отвечает — значит прокси жив, а рвётся именно этот
      // адрес. Разница между «прокси не работает» и «хост закрыт» — это разные
      // люди, к которым идти.
      add(fail(control ? 'proxy-tls-filtered' : 'proxy-tls-closed',
        { host, control: UBUNTU_HOST, detail: why(err, t) }));
      return steps;
    }
    add(fail('proxy-tls', { host, detail: why(err, t) }));
    return steps;
  }

  // Пакеты лежат не там, где индексы: packages.gitlab.com уводит за .deb
  // редиректом на Google Storage. Прокси, настроенный на один хост, покрывает
  // apt-get update и не покрывает ни одной загрузки — «всё в порядке» здесь
  // было бы обещанием, которого проба не проверяла.
  if (host === GITLAB_REPO_HOST) {
    const ok2 = await tlsWorks({ proxy, host: GITLAB_DOWNLOAD_HOST, ca, timeout });
    add((ok2 ? ok : fail)('proxy-downloads', { host: GITLAB_DOWNLOAD_HOST }));
    if (!ok2) return steps;
  }

  try {
    const started = Date.now();
    const res = await request(`https://${host}/gitlab/gitlab-ee/gpgkey`, {
      proxy, ca: readCa(ca), timeout,
    });
    const good = res.status >= 200 && res.status < 400;
    add((good ? ok : fail)('proxy-http', { host, status: res.status, ms: ms(started), detail: '' }));
    if (!good) return steps;
  } catch (err) {
    add(fail('proxy-http', { host, status: '', detail: why(err, t) }));
    return steps;
  }

  if (exec) await aptProbes({ steps, add, exec, confPath, t });
  return steps;
}

/**
 * apt — последний рубеж и единственный, который проверяет то, чем пакеты
 * реально ставятся. Успешный HTTP-запрос ещё ничего не гарантирует: apt
 * ходит своим кодом и своим конфигом.
 */
/** Отказ по подписи — не отказ сети: ключ чинят иначе, чем маршрут. */
const UNSIGNED = /NO_PUBKEY|not signed|GPG error|не подписан/i;

/**
 * Настоящее обновление списков — во временный каталог, а не в системный.
 *
 * `apt-cache madison` читает уже скачанные списки и о состоянии сети не
 * говорит ничего: на боевой машине он отвечал «версий: 591», пока
 * `apt-get update` через тот же прокси падал с «no longer has a Release
 * file». Проба, которая этого не замечает, обещает больше, чем проверила.
 *
 * Свой Dir::State::Lists и свой sourcelist: системные списки не трогаем, чтобы
 * диагностика оставалась диагностикой. Проверка подписи не отключается —
 * отказ по ней просто получает свой диагноз.
 */
async function aptRefresh({ exec, confPath, listFile }) {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-upgrade-lists-'));
  mkdirSync(join(dir, 'partial'), { recursive: true });
  try {
    const r = await exec([
      'apt-get', ...(confPath ? ['-c', confPath] : []), 'update',
      '-o', `Dir::State::Lists=${dir}`,
      '-o', `Dir::Etc::sourcelist=${listFile}`,
      '-o', 'Dir::Etc::sourceparts=/dev/null',
      '-o', 'Acquire::Languages=none',
      '-o', 'APT::Get::List-Cleanup=0',
    ], { readOnly: true, allowFailure: true, timeout: 120_000 });
    return { code: r.code, said: `${r.stderr ?? ''}\n${r.stdout ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function aptProbes({ add, exec, confPath, t, direct = false }) {
  let listFile = null;
  try {
    // Самая частая причина «apt ничего не видит» — репозиторий GitLab просто
    // не подключён. Отличать это от сломанного прокси и есть тот час, ради
    // которого команда написана.
    const src = await exec(
      ['grep', '-rl', GITLAB_REPO_HOST, '/etc/apt/sources.list', '/etc/apt/sources.list.d/'],
      { readOnly: true, allowFailure: true },
    );
    if (src.code !== 0 || !src.stdout.trim()) {
      add(fail('apt-no-repo'));
      return;
    }
    listFile = src.stdout.trim().split('\n')[0];
  } catch { /* нет grep — идём дальше, madison всё равно ответит */ }

  try {
    // `apt-cache madison` — запрос локальный: он читает уже скачанные списки
    // из /var/lib/apt/lists и в сеть не ходит вообще. Пока `apt-get update`
    // ни разу не прошёл для этого репозитория, версий не будет при самом
    // исправном прокси — и apt при этом выходит с кодом 0 и пустым stderr,
    // то есть не сообщает никакой причины. Проверено на живом apt.
    // В именах файлов apt заменяет подчёркиваниями только разделители пути:
    // точки в имени хоста остаются (archive.ubuntu.com_ubuntu_dists_…).
    const ls = await exec(['ls', '-1', '/var/lib/apt/lists'], { readOnly: true, allowFailure: true });
    const fetched = ls.stdout.split('\n')
      .some((f) => f.includes(GITLAB_REPO_HOST) && f.includes('Packages'));
    if (ls.code === 0 && !fetched) {
      add(fail('apt-not-updated', { host: GITLAB_REPO_HOST }));
      return;
    }
  } catch { /* нет ls — пусть отвечает madison */ }

  try {
    // Тот же конфиг прокси, что уходит в apt-get при установке: проверять
    // другой набор настроек — проверять не то.
    const argv = ['apt-cache', ...(confPath ? ['-c', confPath] : []), 'madison', 'gitlab-ee'];
    const r = await exec(argv, { readOnly: true, allowFailure: true, timeout: 60_000 });
    const n = r.stdout.split('\n').filter((l) => l.includes('gitlab-ee')).length;
    add(n > 0
      ? ok('apt-repo', { n })
      // Пустой stderr здесь не «причина не названа», а сама причина: apt
      // отвечает из локальных списков и молчит, когда в них ничего нет.
      : fail('apt-repo', { detail: errorDetail(r.stderr) || t('probe.aptSilent') }));
  } catch (err) {
    add(fail('apt-repo', { detail: err.message || t('probe.noDetail') }));
  }

  // Списки читаются — но читаются они с диска. Единственный способ узнать,
  // доберётся ли apt до репозитория ЧЕРЕЗ ПРОКСИ, — сходить туда.
  if (listFile) {
    try {
      const r = await aptRefresh({ exec, confPath, listFile });
      if (r.code === 0) add(ok('apt-refresh', { host: GITLAB_REPO_HOST }));
      else if (UNSIGNED.test(r.said)) {
        // Ключ репозитория — отдельная беда: маршрут при этом рабочий.
        add(fail('apt-unsigned', { detail: errorDetail(r.said) }));
        return;
      } else {
        add(fail('apt-refresh', { detail: errorDetail(r.said) }));
        return;
      }
    } catch (err) {
      add(fail('apt-refresh', { detail: err.message }));
      return;
    }
  }

  if (direct) return;
  try {
    // Зеркало Ubuntu на закрытом контуре обычно внутреннее и мимо прокси —
    // поэтому это предупреждение, а не отказ.
    const took = await tcpProbe({ host: UBUNTU_HOST, port: 80, timeout: 5000 });
    add(ok('apt-direct', { host: UBUNTU_HOST, ms: took }));
  } catch (err) {
    add(warn('apt-direct', { host: UBUNTU_HOST, detail: why(err, t) }));
  }
}

function readCa(ca) {
  if (!ca) return null;
  try { return readFileSync(ca); } catch { return null; }
}
