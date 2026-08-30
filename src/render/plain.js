import { redact } from '../core/redact.js';

/**
 * Не-TTY рендерер: построчно, без ANSI и перерисовок, grep-совместимо.
 * Тот же поток событий, что у Ink-рендерера, — расхождений быть не может.
 */
export function createPlainRenderer({ out = process.stdout, secrets = [], showExec = false } = {}) {
  return (e) => {
    if (e.t.startsWith('exec:') && !showExec) return;
    const ts = e.ts.replace('T', ' ').slice(0, 19);
    const level = e.level ?? (e.t.endsWith(':error') ? 'error' : 'info');
    const text = e.text ?? e.t;
    out.write(`${ts} [${level.padEnd(5)}] ${redact(text, secrets)}\n`);
  };
}

export function createJsonRenderer({ out = process.stdout, secrets = [] } = {}) {
  return (e) => out.write(redact(JSON.stringify(e), secrets) + '\n');
}

/** Прямая печать готового блока (планы, справка) — вне потока событий. */
export function writeBlock(lines, out = process.stdout) {
  out.write(lines.join('\n') + '\n');
}
