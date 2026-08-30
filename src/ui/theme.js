/**
 * Четыре роли и акцент — весь словарь цвета. Больше ролей означало бы, что
 * цвет что-то кодирует, и экран пришлось бы читать по легенде.
 */
const COLOR = { ok: 'green', warn: 'yellow', error: 'red', info: undefined, accent: 'cyan' };

/** NO_COLOR — соглашение, а не мелочь: с ним живут логи в CI и в pager. */
export const wantsColor = ({ env = process.env, flag } = {}) =>
  !(flag === false || Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb');

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
