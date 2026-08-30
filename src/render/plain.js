import { redact } from '../core/redact.js';
import { describe, MARK } from './events.js';

/**
 * Не-TTY рендерер: построчно, без ANSI и перерисовок, grep-совместимо.
 * Тот же поток событий и тот же перевод, что у Ink-рендерера, — расхождений
 * между экраном и логом быть не может.
 */
export function createPlainRenderer({ out = process.stdout, t, secrets = [] } = {}) {
  return (e) => {
    const said = describe(e, t);
    if (!said) return;
    out.write(`${stamp(e)} [${said.role.padEnd(5)}] ${redact(said.text, secrets)}\n`);
  };
}

/** Тот же текст, что в ленте, но с маркером — для `attach` без TTY. */
export function createAttachRenderer({ out = process.stdout, t, secrets = [] } = {}) {
  return (e) => {
    const said = describe(e, t);
    if (!said) return;
    out.write(`${stamp(e)} ${MARK[said.role]} ${redact(said.text, secrets)}\n`);
  };
}

export function createJsonRenderer({ out = process.stdout, secrets = [] } = {}) {
  return (e) => out.write(redact(JSON.stringify(e), secrets) + '\n');
}

/** Прямая печать готового блока (планы, справка) — вне потока событий. */
export function writeBlock(lines, out = process.stdout) {
  out.write(lines.join('\n') + '\n');
}

const stamp = (e) => String(e.ts ?? '').replace('T', ' ').slice(0, 19);
