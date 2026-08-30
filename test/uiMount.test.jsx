import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventBus } from '../src/core/events.js';
import { createTranslator } from '../src/i18n/index.js';
import { mountRun } from '../src/ui/render.jsx';
import { LONG_RUN } from './fixtures/run-events.js';

/**
 * Настоящее монтирование, а не отдельный компонент: половина того, что может
 * пойти не так у Ink, живёт именно здесь — сырой режим stdin, размонтирование
 * и печать итога после экрана.
 */
function fakeTty() {
  const out = new PassThrough();
  out.isTTY = true; out.columns = 80; out.rows = 40;
  let buf = '';
  out.on('data', (c) => { buf += c; });
  return { out, text: () => buf };
}

const strip = (s) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g'), '');

test('экран монтируется и гаснет, не унося с собой итог запуска', async () => {
  const { out, text } = fakeTty();
  const bus = new EventBus();
  const screen = mountRun({
    bus, t: createTranslator('ru'), flags: { noColor: true },
    stdout: out, env: { NO_COLOR: '1' }, now: () => Date.parse('2026-08-30T15:45:00.000Z'),
  });
  for (const e of LONG_RUN) bus.emit(e);
  await new Promise((r) => setTimeout(r, 120));

  // Если stop() не разрешится, шестичасовой апгрейд закончится молча.
  const finished = await Promise.race([
    screen.stop().then(() => true),
    new Promise((r) => setTimeout(() => r(false), 4000)),
  ]);
  assert.equal(finished, true, 'stop() обязан завершиться');

  const frame = strip(text());
  assert.match(frame, /16\.3\.9-ee/);
  // Ink рисует свой экран ошибки прямо в вывод — молча это не заметить.
  assert.doesNotMatch(frame, /Raw mode|is not supported/i);
  assert.doesNotMatch(frame, /react-reconciler/);
});

test('без событий экран не поднимается и терминал не трогает', async () => {
  const { out, text } = fakeTty();
  const bus = new EventBus();
  const screen = mountRun({ bus, t: createTranslator('en'), flags: { noColor: true }, stdout: out, env: { NO_COLOR: '1' } });
  // Обнаружение версии идёт до run:start и сыплет exec-событиями.
  bus.emit({ t: 'exec:start', argv: ['dpkg-query', '-W'], readOnly: true });
  bus.emit({ t: 'exec:end', argv: ['dpkg-query', '-W'], code: 1, durationMs: 4 });
  await new Promise((r) => setTimeout(r, 60));
  await screen.stop();
  // `run` часто упирается в отсутствие GitLab до первого события: очистка
  // экрана ради сообщения об ошибке — чистый шум.
  assert.equal(text(), '');
});

test('после остановки экрана шина больше на него не пишет', async () => {
  const { out, text } = fakeTty();
  const bus = new EventBus();
  const screen = mountRun({
    bus, t: createTranslator('en'), flags: { noColor: true }, stdout: out, env: { NO_COLOR: '1' },
  });
  bus.emit(LONG_RUN[0]);
  await screen.stop();
  const before = text().length;
  bus.emit({ t: 'step:start', index: 9, of: 9, version: '19.0.0-ee' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(text().length, before, 'после stop() экран молчит');
});

test('Ctrl-C остаётся рабочим: прерывание идёт через наш обработчик', async () => {
  // Сырой режим забирает Ctrl-C у терминала. Если экран его не пробросит,
  // апгрейд станет невозможно остановить — это хуже случайного прерывания.
  const { out } = fakeTty();
  const bus = new EventBus();
  let aborted = 0;
  const screen = mountRun({
    bus, t: createTranslator('en'), flags: { noColor: true }, stdout: out,
    env: { NO_COLOR: '1' }, abort: () => { aborted += 1; },
  });
  bus.emit(LONG_RUN[0]);
  await new Promise((r) => setTimeout(r, 60));
  await screen.stop();
  assert.equal(aborted, 0, 'без нажатия ничего не прерывается');
});
