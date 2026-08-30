/**
 * Ширины колонок считаются от фактических подписей активной локали.
 * `место на диске` и `disk space` отличаются вдвое — константа здесь
 * гарантированно съедет при переводе.
 */
export const width = (labels) => Math.max(0, ...labels.map((l) => [...String(l)].length));

export const pad = (s, n) => {
  const str = String(s);
  const len = [...str].length;
  return len >= n ? str : str + ' '.repeat(n - len);
};

export const padStart = (s, n) => {
  const str = String(s);
  const len = [...str].length;
  return len >= n ? str : ' '.repeat(n - len) + str;
};

export function table(rows, { gap = 2, indent = '  ' } = {}) {
  if (!rows.length) return [];
  const cols = rows[0].length;
  const widths = Array.from({ length: cols }, (_, i) => width(rows.map((r) => r[i] ?? '')));
  return rows.map((r) =>
    indent + r.map((cell, i) => (i === cols - 1 ? String(cell ?? '') : pad(cell ?? '', widths[i] + gap))).join('').trimEnd()
  );
}

/** Единицы — пользовательский текст, поэтому переводчик обязателен. */
export const bytes = (n, t) => {
  if (!Number.isFinite(n)) return '\u2014';
  const gb = n / 1024 ** 3;
  return gb >= 1
    ? t('unit.gb', { n: Math.round(gb * 10) / 10 })
    : t('unit.mb', { n: Math.round(n / 1024 ** 2) });
};

/** Обрезает по видимой длине: диагностика не должна ломать вёрстку строки. */
export function clip(text, max) {
  const chars = [...String(text)];
  return chars.length <= max ? String(text) : chars.slice(0, Math.max(1, max - 1)).join('') + '\u2026';
}

/**
 * Перенос по словам с учётом видимой длины.
 *
 * Обрезка на месте сообщения обходилась дорого: резалось именно объяснение,
 * почему нельзя идти дальше. Длинное слово (путь, URL) не переносим — рвать
 * путь посередине хуже, чем вылезти за колонку.
 */
export function wrap(text, max) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if ([...candidate].length <= max || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  lines.push(line);
  return lines;
}
