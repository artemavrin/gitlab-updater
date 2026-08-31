import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Скриншоты экранов для README.
 *
 * Снимается настоящий вывод: команда запускается под настоящим pty (иначе
 * не будет ни цвета, ни Ink), ANSI переводится в HTML, HTML снимается
 * Chromium. Никакой ручной вёрстки «как бы терминала» — картинка врала бы
 * ровно там, где README обещает правду.
 *
 * Данные, наоборот, бывают двух сортов, и это указано в подписи каждого
 * снимка: часть команд работает вживую (`proxy test`, `doctor`), часть
 * рисуется по записанному потоку событий, потому что живого GitLab здесь нет.
 */
const OUT = 'docs/media';
const CHROME = process.env.CHROME
  ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const COLS = 80;
// Рисуем сразу в двойном масштабе вместо --force-device-scale-factor:
// тот двоит и размер окна тоже, отчего кадр обрезался снизу молча.
const SCALE = 2;
const FONT_PX = 15 * SCALE;
const LINE_PX = 22 * SCALE;
const PAD = 18 * SCALE;
const BAR = 36 * SCALE;
// Ширина знакоместа DejaVu Sans Mono — 0.60229em. Считаем, а не подбираем:
// подобранное число разъедется на первой же строке в 80 колонок.
const CHAR_PX = FONT_PX * 0.60229;

const THEME = {
  bg: '#12151a', fg: '#c8ccd4', dim: '#7b8394',
  30: '#4a5160', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b',
  34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#c8ccd4',
};

/** Запуск под настоящим pty: без него нет ни цвета, ни Ink. */
export function capture(command, { cols = COLS, env = {} } = {}) {
  const vars = Object.entries({ COLUMNS: cols, LINES: 60, ...env })
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(' ');
  try {
    return execFileSync('script', ['-qec', `env ${vars} ${command}`, '/dev/null'], {
      encoding: 'utf8', maxBuffer: 8 << 20, env: { ...process.env, ...env },
    });
  } catch (err) {
    // Ненулевой код возврата — норма: половина снимков про то, как ломается.
    return err.stdout ?? '';
  }
}

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');
// Всё, что не SGR: перемещения курсора, очистка, синхронизация вывода Ink.
const OTHER = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-ln-z]|${ESC}\\][^\\u0007]*\\u0007|\\r`, 'g');

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** ANSI → HTML. Поддерживаются ровно те коды, которые инструмент испускает. */
export function ansiToHtml(raw) {
  const text = raw.replace(OTHER, '');
  let out = '';
  let open = false;
  let last = 0;
  const style = { color: null, dim: false, bold: false };

  const span = () => {
    const bits = [];
    if (style.color) bits.push(`color:${style.color}`);
    if (style.dim) bits.push(`color:${THEME.dim}`);
    if (style.bold) bits.push('font-weight:600');
    return bits.length ? `<span style="${bits.join(';')}">` : '';
  };
  const flush = (chunk) => {
    if (!chunk) return;
    const tag = span();
    out += tag ? tag + escapeHtml(chunk) + '</span>' : escapeHtml(chunk);
  };

  for (const m of text.matchAll(SGR)) {
    flush(text.slice(last, m.index));
    last = m.index + m[0].length;
    for (const code of (m[1] || '0').split(';')) {
      const n = Number(code || 0);
      if (n === 0) { style.color = null; style.dim = false; style.bold = false; }
      else if (n === 1) style.bold = true;
      else if (n === 2) style.dim = true;
      else if (n === 22) { style.bold = false; style.dim = false; }
      else if (n >= 30 && n <= 37) { style.color = THEME[n]; style.dim = false; }
      else if (n === 39) style.color = null;
      else if (n >= 90 && n <= 97) { style.color = THEME[n - 60]; }
    }
  }
  flush(text.slice(last));
  void open;
  return out;
}

const page = (html, { lines, cols, title }) => `<!doctype html><meta charset="utf-8">
<style>
  @font-face { font-family: term; src: local("DejaVu Sans Mono"); }
  html, body { margin: 0; background: ${THEME.bg}; }
  .frame {
    width: ${Math.ceil(cols * CHAR_PX)}px;
    padding: ${PAD}px;
    box-sizing: content-box;
    background: ${THEME.bg};
  }
  .bar { height: ${22 * SCALE}px; display: flex; align-items: center; gap: ${7 * SCALE}px; padding: 0 0 ${14 * SCALE}px ${2 * SCALE}px; }
  .dot { width: ${11 * SCALE}px; height: ${11 * SCALE}px; border-radius: 50%; }
  .name { margin-left: ${8 * SCALE}px; font: ${12 * SCALE}px term, monospace; color: ${THEME.dim}; }
  pre {
    margin: 0; font: ${FONT_PX}px/${LINE_PX}px term, "DejaVu Sans Mono", monospace;
    color: ${THEME.fg}; white-space: pre; tab-size: 8;
  }
</style>
<div class="frame">
  <div class="bar">
    <div class="dot" style="background:#e06c75"></div>
    <div class="dot" style="background:#e5c07b"></div>
    <div class="dot" style="background:#98c379"></div>
    <div class="name">${escapeHtml(title)}</div>
  </div>
  <pre>${html}</pre>
</div>`;

export function shoot(name, raw, { title, cols = COLS }) {
  // Пустые строки по краям — артефакт вывода команды, а не кадра.
  const body = ansiToHtml(raw).replace(/^\n+/, '').replace(/\s+$/, '');
  const lines = body.split('\n').length;
  const html = page(body, { lines, cols, title });
  const tmp = join(OUT, `.${name}.html`);
  writeFileSync(tmp, html);

  // Снимаем с запасом и режем по фактическому краю: высоту знает браузер,
  // а не арифметика по числу строк — она раз за разом с ним не сходилась.
  const width = Math.ceil(cols * CHAR_PX + PAD * 2);
  const height = Math.ceil(lines * LINE_PX + PAD * 2 + BAR) + 600;
  const png = join(OUT, `${name}.png`);
  execFileSync(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--screenshot=${png}`,
    `file://${process.cwd()}/${tmp}`,
  ], { stdio: 'pipe' });
  const size = execFileSync('python3', ['scripts/crop-png.py', png, String(PAD)], { encoding: 'utf8' }).trim();
  if (!process.env.KEEP_HTML) rmSync(tmp, { force: true });
  return { name, lines, size };
}

mkdirSync(OUT, { recursive: true });
