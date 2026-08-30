/**
 * Цвет для статического вывода — без Ink.
 *
 * Ink рисует живой кадр и ради этого чистит экран вместе со скроллбэком.
 * Для ленты `run` это правильно, для справки о блокерах — уничтожение
 * истории терминала ради текста, который не меняется. Здесь достаточно
 * четырёх ролей и escape-последовательности.
 */
const CSI = `${String.fromCharCode(27)}[`;
const RESET = `${CSI}0m`;
const CODE = { ok: '32', warn: '33', error: '31', critical: '31', accent: '36', dim: '2' };

/**
 * NO_COLOR — соглашение, а не мелочь: с ним живут логи в CI и в pager.
 * Отдельно проверяется сам приёмник: `doctor > log.txt` обязан дать текст,
 * а не escape-последовательности вперемешку со словами.
 */
export const wantsColor = ({ env = process.env, flag, stream = null } = {}) => {
  if (flag === false) return false;
  // У пайпа isTTY не false, а undefined — сравнение со строгим false
  // пропускало цвет в перенаправленный вывод.
  if (stream && !stream.isTTY) return false;
  return !(Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb');
};

export function createPainter({ color = true } = {}) {
  if (!color) return (_role, text) => text;
  return (role, text) => {
    const code = CODE[role];
    return code ? `${CSI}${code}m${text}${RESET}` : text;
  };
}
