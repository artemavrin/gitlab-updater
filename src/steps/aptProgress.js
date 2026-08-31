/**
 * Разбор машинного вывода apt (`APT::Status-Fd`).
 *
 * Без него длинная команда — чёрный ящик: предзагрузка тянет десятки гигабайт
 * через прокси и не говорит ни слова до самого конца, а установка потом столько
 * же молчит на reconfigure. Человек смотрит на неподвижный экран и не знает,
 * идёт ли что-нибудь вообще, — а идти оно может часами.
 *
 * Форматы сняты с живого apt, а не из документации:
 *   dlstatus:2:27.1686:Retrieving file 2 of 3
 *   pmstatus:dpkg-exec:0.0000:Running dpkg
 *   Get:2 http://.../main amd64 libcurl4t64 amd64 8.5.0-2ubuntu10.13 [343 kB]
 *   Fetched 904 kB in 2s (588 kB/s)
 *
 * Чистая функция: разбор проверяется без сети и без apt.
 */

/** Опция, включающая машинный канал. Значение 1 — тот же stdout, отдельный fd не нужен. */
export const STATUS_FD = ['-o', 'APT::Status-Fd=1'];

const STATUS = /^(dl|pm)status:([^:]*):([\d.]+):(.*)$/;
const GET = /^Get:\d+\s+\S+\s+(.*?)\s*\[([^\]]+)\]\s*$/;
const FETCHED = /^Fetched\s+(.+)$/;

/**
 * Строка apt → событие или null.
 *
 * null означает «эта строка ничего не сообщает о ходе»: таких большинство, и
 * пропускать их молча правильнее, чем показывать человеку сырой лог.
 */
export function parseAptLine(line) {
  const status = STATUS.exec(line);
  if (status) {
    const [, kind, item, percent, note] = status;
    return {
      kind: kind === 'dl' ? 'download' : 'install',
      item, note: note.trim(),
      percent: Math.max(0, Math.min(100, Number(percent))),
    };
  }
  const get = GET.exec(line);
  if (get) return { kind: 'get', what: get[1].trim(), size: get[2].trim() };
  const fetched = FETCHED.exec(line);
  if (fetched) return { kind: 'fetched', text: fetched[1].trim() };
  return null;
}

/**
 * Подписка на вывод apt: отдаёт наверх только изменения, которые видно.
 *
 * apt печатает dlstatus десятками раз в секунду и повторяет одно и то же
 * значение — пропускать одинаковые проценты обязательно, иначе экран
 * перерисовывается вхолостую, а журнал распухает на пустом месте.
 */
export function aptWatcher(onChange, { step = 1 } = {}) {
  let lastPercent = -1;
  let what = null;
  return (line) => {
    const e = parseAptLine(line);
    if (!e) return;
    if (e.kind === 'get') { what = `${e.what} · ${e.size}`; return; }
    if (e.kind === 'fetched') { onChange({ kind: 'fetched', text: e.text }); return; }
    const percent = Math.floor(e.percent / step) * step;
    if (percent === lastPercent) return;
    lastPercent = percent;
    onChange({ kind: e.kind, percent, what, note: e.note });
  };
}
