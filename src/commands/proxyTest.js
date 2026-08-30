import { probeProxy } from '../net/probe.js';
import { renderFindings } from './doctor.js';
import { LEVEL } from '../core/events.js';
import { EXIT } from '../plan/planner.js';

/**
 * Диагностика прокси по рубежам.
 *
 * «Пакетов не видно» — самый дорогой класс обращений: причина бывает в
 * шести разных местах, и без разбиения её ищут перебором. Здесь каждый
 * рубеж отвечает за себя, и падает ровно тот, где рвётся.
 *
 * Ничего не меняет и не требует root: диагностику запускают до того, как
 * получили sudo, — иначе она бесполезна.
 */
export async function commandProxyTest(ctx) {
  const { t, config, exec, flags, confPath, sources } = ctx;

  const steps = await probeProxy({
    proxyUrl: config.proxy ?? null,
    // Источник значения переводится: «flag» и «config» — служебные слова,
    // а строка уходит человеку, который решает, где менять настройку.
    source: sourceLabel(sources?.proxy, t),
    ca: config.proxyCa ?? null,
    host: flags.probeHost ?? undefined,
    timeout: Number(flags.probeTimeout ?? 15_000),
    t, exec, confPath,
  });

  const critical = steps.filter((s) => s.level === LEVEL.CRITICAL).length;
  const warnings = steps.filter((s) => s.level === LEVEL.WARN).length;
  const verdict = critical ? 'probe.broken' : warnings ? 'probe.partial' : 'probe.clean';

  const lines = ['', ...renderFindings(t, steps), '', ` ${t(verdict)}`, ''];

  return {
    code: critical ? EXIT.ERROR : EXIT.CURRENT,
    errorCode: critical ? 'proxy-unreachable' : undefined,
    lines, verdict,
    result: {
      proxy: config.proxy ? maskUser(config.proxy) : null,
      ok: steps.filter((s) => s.level === LEVEL.OK).length,
      warnings, critical,
      findings: steps.map((s) => ({ id: s.id, check: s.check, level: s.level, params: s.params, remedy: s.remedy ?? null })),
    },
  };
}

function sourceLabel(source, t) {
  if (!source) return null;
  const key = `source.${String(source).split(' ')[0]}`;
  return t.has(key) ? `${t(key)}${source.startsWith('env ') ? ` ${source.slice(4)}` : ''}` : source;
}

/** URL прокси уезжает в --json: пароль из него убираем до сериализации. */
function maskUser(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch { return null; }
}
