import { LEVEL } from '../core/events.js';
import { pad, width, wrap } from './format.js';

/**
 * Находка → структура для показа. Одно место на все поверхности: экран
 * блокеров, построчный вывод и `--json` описывают одну и ту же находку, и
 * разойтись им негде.
 *
 * Ровно тот же приём, что в `events.js`, и по той же причине: там разошлись
 * бы экран и журнал, здесь — экран и совет, который получит агент.
 */

export const MARK = { [LEVEL.OK]: '✓', [LEVEL.WARN]: '!', [LEVEL.CRITICAL]: '✗' };

export function describeFinding(f, t) {
  return {
    id: f.id,
    check: f.check,
    level: f.level,
    mark: MARK[f.level] ?? '?',
    title: t(`check.${f.check}.title`),
    message: t(`check.${f.id}.${f.level}`, f.params ?? {}),
    remedy: describeRemedy(f.remedy, t),
  };
}

/**
 * Команда показывается через sudo: инструмент и так требует root, а совет,
 * который не выполнится от обычного пользователя, — половина совета.
 */
function describeRemedy(remedy, t) {
  if (!remedy) return null;
  return {
    id: remedy.id,
    what: t(`remedy.${remedy.id}`),
    command: remedy.argv ? `sudo ${remedy.argv.join(' ')}` : null,
    flag: remedy.flag ?? null,
    docs: remedy.docs ?? null,
  };
}

/**
 * Список находок строками с ролью: по строке на находку, продолжение —
 * под колонкой сообщения. Раньше здесь стояла обрезка, и резалось именно
 * объяснение, почему нельзя идти дальше.
 */
export function findingLines(findings, t, { limit = 78 } = {}) {
  const said = findings.map((f) => describeFinding(f, t));
  const col = width(said.map((f) => f.title)) + 2;
  const head = 3 + 1 + 2 + col;
  // Строка разбита на три части: цветом помечается уровень (маркер),
  // заголовок остаётся обычным, сообщение приглушено. Если красить строку
  // целиком, цвет перестаёт значить «уровень» и становится фоном.
  return said.flatMap((f) =>
    wrap(f.message, Math.max(20, limit - head)).map((line, i) => ({
      role: f.level,
      mark: i === 0 ? `   ${f.mark}  ` : ' '.repeat(head),
      title: i === 0 ? pad(f.title, col) : '',
      message: line,
    })));
}

/**
 * Развёрнутый блок того, что мешает начать, — строками с ролью.
 *
 * Разметка одна на обе поверхности: plain склеивает `text`, Ink красит по
 * `role`. Была бы разметка в двух местах — экран и лог разъехались бы ровно
 * там, где это дороже всего, как уже было с событиями.
 */
export function blockerLines(findings, t, { limit = 78 } = {}) {
  const { critical, warnings } = groupFindings(findings);
  const out = [];
  const push = (role, text) => out.push({ role, text });

  for (const f of [...critical, ...warnings].map((x) => describeFinding(x, t))) {
    push(f.level, ` ${f.mark} ${f.title}`);
    for (const line of wrap(f.message, limit - 4)) push('info', `    ${line}`);
    if (f.remedy) {
      push('dim', `    ${t('remedy.title')}`);
      // Починка бывает без команды: там, где она зависит от версии сильнее,
      // чем мы можем угадать, остаётся объяснение и ссылка.
      const action = f.remedy.command ?? f.remedy.flag;
      if (action) push('accent', `      ${action}`);
      for (const line of wrap(f.remedy.what, limit - 8)) push('dim', `      ${line}`);
      if (f.remedy.docs) {
        // Ссылка отдельной строкой и без переноса: с подписью в той же строке
        // самый длинный URL из таблицы вылезает за 78 колонок, а рвать URL нельзя.
        push('dim', `      ${t('remedy.docs')}`);
        push('dim', `      ${f.remedy.docs}`);
      }
    }
    push('info', '');
  }
  return out;
}

/** Разбор по уровням: экран блокеров показывает их по-разному. */
export function groupFindings(findings) {
  const at = (level) => findings.filter((f) => f.level === level);
  return {
    critical: at(LEVEL.CRITICAL),
    warnings: at(LEVEL.WARN),
    passed: at(LEVEL.OK),
  };
}
