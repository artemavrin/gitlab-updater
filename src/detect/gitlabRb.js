import { RB_PATH } from './services.js';
import { compareVersions, parseVersion } from '../plan/version.js';

/**
 * Настройки gitlab.rb, из-за которых reconfigure откажется работать.
 *
 * Это не гипотетическая опасность. На живом сервере шаг 7 из 19 (15.11.13)
 * упал так:
 *
 *   gitlab_rails['smtp_tls'] and gitlab_rails['smtp_enable_starttls_auto']
 *   are mutually exclusive.
 *
 * Комбинация лежала в gitlab.rb годами и на 13.12 никого не смущала —
 * проверку добавили позже. Дальше по цепочке: reconfigure не отработал,
 * пакет остался распакованным и ненастроенным, миграции не прошли, а
 * следующий бэкап упал на таблице, которой в старой схеме нет.
 *
 * Найти это можно было до старта: настройка лежит в файле, а версия, с
 * которой она перестаёт приниматься, известна. Именно этим здесь и
 * занимаемся — до бэкапа, а не на седьмом шаге.
 */

/**
 * Читаем ТОЛЬКО перечисленные ключи, а не файл целиком.
 *
 * В gitlab.rb лежат пароль SMTP, токены и ключи. Их незачем поднимать в
 * память ради двух булевых значений — тем более что вывод упавшей команды
 * инструмент сохраняет в файл.
 *
 * @param {Function} exec
 * @param {string[]} keys  ключи вида gitlab_rails['smtp_tls']
 * @returns {Promise<Map<string,string>|null>} null — прочитать не удалось
 */
export async function readSettings(exec, keys, { rb = RB_PATH } = {}) {
  if (!keys.length) return new Map();
  const r = await exec(settingsGrep(keys, { rb }), { readOnly: true, allowFailure: true })
    .catch(() => null);
  // 0 — нашли, 1 — ни одной строки (тоже ответ), остальное — файла нет или
  // не хватило прав. Второе не «всё в порядке», и притворяться не будем.
  if (!r || (r.code !== 0 && r.code !== 1)) return null;
  return parseSettings(r.stdout ?? '');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Сама команда — отдельно: по ней же строится фикстура, чтобы не разойтись. */
export function settingsGrep(keys, { rb = RB_PATH } = {}) {
  return ['grep', '-E', `^\\s*(${keys.map(escapeRe).join('|')})\\s*=`, rb];
}

/**
 * Разбор строк вида `gitlab_rails['smtp_tls'] = true`.
 *
 * Последнее присваивание побеждает — так же, как это видит Ruby, который
 * читает файл сверху вниз. Значение берём как есть: судить о «правдивости»
 * произвольного выражения мы не беремся и не будем.
 */
export function parseSettings(text) {
  const found = new Map();
  for (const line of String(text).split('\n')) {
    // Строка целиком закомментирована — в gitlab.rb таких большинство.
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([a-z_]+\[(['"])[a-z0-9_]+\2\])\s*=\s*(\S+)/i.exec(line);
    if (!m) continue;
    // Ключ приводим к одинарным кавычкам: gitlab.rb допускает обе формы, а
    // правило написано в одной.
    found.set(m[1].replace(/["]/g, "'"), m[3].replace(/[,;].*$/, ''));
  }
  return found;
}

/**
 * Первое правило, которое сработает на пути.
 *
 * Срабатывает только когда ВСЕ ключи правила явно выставлены в `true`.
 * Обратное направление здесь важнее прямого: проверка, которая остановит
 * исправный сервер из-за непонятой строки, будет снята вместе со всеми
 * остальными — и тогда не поймает ничего.
 *
 * @param {object[]} rules     правила из data/gitlab-rb-conflicts.json
 * @param {Map}      settings  что нашли в gitlab.rb
 * @param {object[]} steps     шаги плана: { version }
 */
export function firstConflict(rules, settings, steps) {
  for (const rule of rules) {
    if (!rule.all_true?.length) continue;
    if (!rule.all_true.every((key) => settings.get(key) === 'true')) continue;
    const since = parseVersion(rule.since);
    if (!since) continue;
    const step = steps.find((s) => {
      const v = parseVersion(s.version ?? s.raw ?? s);
      return v && compareVersions(v, since) >= 0;
    });
    if (step) return { rule, step: step.version ?? step.raw ?? String(step) };
  }
  return null;
}
