import { blockerLines, describeFinding, groupFindings } from './findings.js';
import { createPainter, wantsColor } from './color.js';
import { clip } from './format.js';

const LINE = 78;

/**
 * То, что мешает начать, — печатью, а не живым кадром.
 *
 * Отдельно от списка проверок, потому что вопрос другой: список отвечает
 * «что проверили», этот блок — «что мне сейчас чинить». Пять critical,
 * размазанных между пройденными галочками, на второй вопрос не отвечают.
 */
export function printBlockers({
  findings, t, out = process.stdout, env = process.env, color, limit = LINE, summary = null,
}) {
  const paint = createPainter({ color: wantsColor({ env, flag: color, stream: out }) });
  const { critical, warnings, passed } = groupFindings(findings);
  const write = (s) => out.write(s + '\n');

  write('');
  write(paint(critical.length ? 'error' : 'warn',
    ` ${critical.length ? '⛔' : '!'} ${t(critical.length ? 'blockers.title' : 'blockers.warnTitle', {
      critical: critical.length, warnings: warnings.length,
    })}`));
  write('');

  for (const line of blockerLines(findings, t, { limit })) {
    write(line.role === 'info' ? line.text : paint(line.role, line.text));
  }

  // Пройденное сворачивается в одну строку: оно отвечает на вопрос,
  // который человек в этот момент не задаёт.
  if (passed.length) {
    write(paint('ok', clip(
      ` ✓ ${t('blockers.passed', { n: passed.length })} — ` +
      passed.map((f) => describeFinding(f, t).title).join(', '), limit)));
  }
  if (summary) write(`\n   ${summary}`);
}
