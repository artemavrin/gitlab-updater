// Роли и правило NO_COLOR общие с печатью: цвет не должен значить разное.
export { wantsColor } from '../render/color.js';

/**
 * Четыре роли и акцент — весь словарь цвета. Больше ролей означало бы, что
 * цвет что-то кодирует, и экран пришлось бы читать по легенде.
 */
const COLOR = { ok: 'green', warn: 'yellow', error: 'red', info: undefined, accent: 'cyan' };

export function createTheme({ color = true } = {}) {
  const role = (name) => (color ? { color: COLOR[name] } : {});
  return {
    role,
    dim: color ? { dimColor: true } : {},
    accent: role('accent'),
    // Ширина держится в 78 колонок: 80 минус рамка терминалов, которые
    // переносят на 79-й. Всё, что шире, ломает вёрстку в ssh-сессии.
    width: 78,
  };
}
