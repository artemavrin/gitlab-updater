import { LEVEL } from '../core/events.js';

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

/** Разбор по уровням: экран блокеров показывает их по-разному. */
export function groupFindings(findings) {
  const at = (level) => findings.filter((f) => f.level === level);
  return {
    critical: at(LEVEL.CRITICAL),
    warnings: at(LEVEL.WARN),
    passed: at(LEVEL.OK),
  };
}
