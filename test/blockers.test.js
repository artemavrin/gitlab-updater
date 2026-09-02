import test from 'node:test';
import assert from 'node:assert/strict';
import { printBlockers } from '../src/render/blockers.js';
import { blockerLines } from '../src/render/findings.js';
import { wantsColor, createPainter } from '../src/render/color.js';
import { remedyFor } from '../src/checks/remedies.js';
import { createTranslator, LOCALES } from '../src/i18n/index.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');

const finding = (id, level, check, params = {}) => ({
  id, level, check, params, remedy: remedyFor({ id, level, params }, { version: '18.9.0-ee' }),
});

const SAMPLE = [
  finding('postgres', 'critical', 'postgres', { have: '13.11', need: '14.14', target: '17.11.6-ee' }),
  finding('migrations-failed', 'critical', 'migrations', { n: 1 }),
  finding('os-ceiling', 'warn', 'os-ceiling', { os: 'Ubuntu 20.04.6 LTS', max: '17.7', target: '17.11.6-ee' }),
  { id: 'root', level: 'ok', check: 'root', params: {} },
  { id: 'secrets', level: 'ok', check: 'secrets', params: {} },
];

function capture(opts = {}) {
  let text = '';
  printBlockers({ findings: SAMPLE, t: createTranslator('ru'), out: { write: (s) => { text += s; } }, env: {}, ...opts });
  return text;
}

test('блок называет команду починки, а не только диагноз', () => {
  const out = capture();
  assert.match(out, /gitlab-ctl pg-upgrade/);
  assert.match(out, /gitlab:background_migrations:status/);
  assert.match(out, /--safe-for-os/);
});

test('пройденное свёрнуто в одну строку', () => {
  const out = capture().split('\n');
  const passed = out.filter((l) => l.includes('✓'));
  // Оно отвечает на вопрос, который человек в этот момент не задаёт.
  assert.equal(passed.length, 1, `свёрнутых строк должно быть ровно одна:\n${out.join('\n')}`);
  assert.match(passed[0], /root/);
});

test('в перенаправленный вывод цвет не уходит', () => {
  // `doctor > log.txt` обязан дать текст, а не escape-последовательности.
  assert.equal(wantsColor({ env: {}, stream: { write() {} } }), false);
  assert.equal(wantsColor({ env: {}, stream: { isTTY: true } }), true);
  assert.equal(wantsColor({ env: { NO_COLOR: '' }, stream: { isTTY: true } }), false);
  assert.equal(wantsColor({ env: {}, flag: false, stream: { isTTY: true } }), false);
  assert.doesNotMatch(capture(), ANSI);
});

test('в терминале цвет есть и не ломает ширину', () => {
  const painted = capture({ out: { write() {}, isTTY: true }, color: true });
  assert.equal(createPainter({ color: true })('error', 'x').includes(ESC), true);
  assert.equal(createPainter({ color: false })('error', 'x'), 'x');
  // Ширина считается по видимым символам, а не по байтам с escape.
  for (const line of painted.split('\n')) {
    assert.ok([...line.replace(ANSI, '')].length <= 78, `${[...line.replace(ANSI, '')].length}: ${line}`);
  }
});

for (const locale of Object.keys(LOCALES)) {
  test(`разметка блока одна на печать и на экран — ${locale}`, () => {
    const t = createTranslator(locale);
    const lines = blockerLines(SAMPLE, t);
    let printed = '';
    printBlockers({ findings: SAMPLE, t, out: { write: (s) => { printed += s; } }, env: {} });
    // Печать склеивает ровно те же строки: разойтись экрану и логу негде.
    for (const line of lines) {
      if (!line.text.trim()) continue;
      assert.ok(printed.includes(line.text), `${locale}: строки «${line.text}» нет в печати`);
    }
  });
}

test('роль есть у каждой строки блока', () => {
  const known = new Set(['ok', 'warn', 'critical', 'error', 'info', 'dim', 'accent']);
  for (const line of blockerLines(SAMPLE, createTranslator('en'))) {
    assert.ok(known.has(line.role), `неизвестная роль ${line.role}`);
  }
});
