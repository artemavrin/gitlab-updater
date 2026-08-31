import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { createTranslator, LOCALES } from '../src/i18n/index.js';
import { initial, reduce, clock, STEP } from '../src/ui/runState.js';
import { describe as say, phaseOf, isDangerous } from '../src/render/events.js';
import { createPlainRenderer } from '../src/render/plain.js';
import { padCell } from '../src/render/format.js';
import { inkAvailable } from '../src/ui/available.js';
import { createTheme, wantsColor } from '../src/ui/theme.js';
import { Run, PathView, Interrupt } from '../src/ui/screens/Run.jsx';
import { LONG_RUN, PATCH_RUN, STOPPED_RUN } from './fixtures/run-events.js';

const LOCALE_IDS = Object.keys(LOCALES);
const NOW = Date.parse('2026-08-30T15:45:00.000Z');

const play = (events, locale) => {
  const t = createTranslator(locale);
  return events.reduce((s, e) => reduce(s, e, t), initial());
};

/** Кадр экрана строкой — то же, что увидел бы человек в терминале. */
function frame(state, locale, props = {}) {
  const t = createTranslator(locale);
  const theme = createTheme({ color: false });
  const { lastFrame, unmount } = render(
    <Run state={state} t={t} theme={theme} now={() => NOW} {...props} />,
  );
  const text = lastFrame();
  unmount();
  return text;
}

const theme = () => createTheme({ color: false });

/** Кадр произвольного куска экрана — теми же средствами, что и целого. */
function draw(element) {
  const { lastFrame, unmount } = render(element);
  const text = lastFrame();
  unmount();
  return text;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const visible = (line) => [...line.replace(ANSI, '')].length;

for (const locale of LOCALE_IDS) {
  test(`лента показывает шаги и фазы — ${locale}`, () => {
    const out = frame(play(LONG_RUN, locale), locale);
    assert.match(out, /16\.3\.9-ee/);
    assert.match(out, /16\.7\.10-ee/);
    // Размер полного бэкапа — то, ради чего лента вообще нужна.
    assert.ok(out.includes('186.3'), 'размер полного бэкапа должен быть виден');
    assert.match(out, /12\/12/);
  });

  test(`ни одна строка экрана не длиннее 78 колонок — ${locale}`, () => {
    for (const [name, state] of [
      ['лента', play(LONG_RUN, locale)],
      ['патч', play(PATCH_RUN, locale)],
      ['остановка', play(STOPPED_RUN, locale)],
    ]) {
      for (const line of frame(state, locale).split('\n')) {
        assert.ok(visible(line) <= 78, `${name}/${locale}: ${visible(line)} колонок — «${line}»`);
      }
    }
  });

  test(`экран пути раскрывает выбранный шаг — ${locale}`, () => {
    const state = play(LONG_RUN, locale);
    const t = createTranslator(locale);
    // Весь маршрут, а не только пройденное: иначе экран молчит об остатке.
    assert.equal(state.steps.length, 3);
    assert.equal(state.steps[0].state, STEP.DONE);
    assert.equal(state.steps[1].state, STEP.NOW);
    assert.equal(state.steps[2].state, STEP.WAIT);

    const out = draw(<PathView state={state} selected={1} t={t} theme={theme(locale)} elapsed="03:30:12" />);
    assert.ok(out.includes(t('ui.pathTitle')));
    // Раскрыт первый шаг — значит видны его фазы, а не только строка итога.
    assert.match(out, /186\.3|186,3/);
    assert.ok(out.includes('16.7.10-ee'), 'свёрнутые шаги остаются на экране');
    assert.ok(out.includes('17.11.6-ee'), 'предстоящие шаги видны — иначе экран молчит об остатке');
    assert.ok(out.includes(t('ui.stepState.target')), 'последний шаг подписан целью');
    for (const line of out.split('\n')) {
      assert.ok(visible(line) <= 78, `путь/${locale}: ${visible(line)} колонок — «${line}»`);
    }
  });

  test(`экран прерывания объясняет цену Ctrl-C — ${locale}`, () => {
    const t = createTranslator(locale);
    const out = draw(<Interrupt t={t} theme={theme(locale)} />);
    assert.ok(out.includes('dpkg --configure -a'), 'выход руками назван командой, а не пересказом');
    assert.ok(out.includes(t('ui.interruptWait')), 'подождать — первый предложенный выход');
    for (const line of out.split('\n')) {
      assert.ok(visible(line) <= 78, `прерывание/${locale}: ${visible(line)} колонок — «${line}»`);
    }
  });

  test(`компактный экран патча не показывает счётчик шагов — ${locale}`, () => {
    const t = createTranslator(locale);
    const out = frame(play(PATCH_RUN, locale), locale);
    assert.match(out, /17\.11\.6-ee/);
    // «шаг 1/1» в повседневном обновлении — церемония вокруг двенадцати минут.
    assert.ok(!out.includes(t('ui.status', { index: 1, of: 1, elapsed: '' }).trim()));
    assert.ok(!out.includes(t('ui.pathHint')), 'путь из одного шага не предлагается');
  });

  test(`опасная фаза меняет строку безопасности — ${locale}`, () => {
    const t = createTranslator(locale);
    const during = play(PATCH_RUN, locale);           // последним идёт install:start
    assert.equal(during.phase, 'install');
    assert.ok(frame(during, locale).includes(t('ui.unsafe')));

    const safe = play(LONG_RUN.slice(0, 9), locale);  // миграции
    assert.equal(safe.phase, 'migrations');
    assert.ok(frame(safe, locale).includes(t('ui.safe')));
  });

  test(`каждое событие потока переводится — ${locale}`, () => {
    const t = createTranslator(locale);
    const extra = [
      { t: 'backup:skipped' },
      { t: 'backup:hook', hook: '/root/snap.sh' },
      { t: 'predownload:start', count: 3 },
      { t: 'predownload:step', version: '16.3.9-ee' },
      { t: 'predownload:done', count: 3, durationMs: 60_000 },
      { t: 'migrations:slow', version: '16.3.9-ee', queued: 47, elapsedMin: 100 },
      { t: 'migrations:unknown', detail: 'connection refused' },
      { t: 'run:done', target: '17.11.6-ee', elapsedMin: 372 },
    ];
    for (const e of [...LONG_RUN, ...STOPPED_RUN, ...extra]) {
      const said = say(e, t);
      assert.ok(said, `событие ${e.t} должно иметь описание`);
      assert.ok(!/\{\w+\}/.test(said.text), `${locale}/${e.t}: неподставленный параметр — ${said.text}`);
      assert.ok(!/^(event|ui|backup)\./.test(said.text), `${locale}/${e.t}: непереведённый ключ — ${said.text}`);
    }
  });
}

test('экран и построчный вывод рассказывают одно и то же', () => {
  const t = createTranslator('ru');
  const chunks = [];
  const plain = createPlainRenderer({ t, out: { write: (s) => chunks.push(s) } });
  for (const e of LONG_RUN) plain(e);

  // Сравнивается всё, что экран показал за прогон, а не последний кадр:
  // идущая фаза живёт в нижней строке и в историю не попадает.
  const seen = new Set();
  let state = initial();
  for (const e of LONG_RUN) {
    state = reduce(state, e, t);
    for (const f of state.feed) seen.add(f.text);
    if (state.live) seen.add(state.live.text);
  }
  const written = chunks.map((c) => c.trimEnd().split('] ')[1]);
  // Ровно тот же текст: attach рисует журнал, и два разных рассказа об одном
  // апгрейде — худшее, что можно предложить человеку в три часа ночи.
  for (const line of written) assert.ok(seen.has(line), `в ленте нет строки лога — «${line}»`);
});

test('exec-события не засоряют ленту, но остаются в журнале', () => {
  const t = createTranslator('en');
  assert.equal(say({ t: 'exec:start', argv: ['apt-get', 'update'] }, t), null);
  const chunks = [];
  createPlainRenderer({ t, out: { write: (s) => chunks.push(s) } })({ t: 'exec:start', argv: ['apt-get'] });
  assert.equal(chunks.length, 0);
});

test('Ctrl-C опасен только на dpkg', () => {
  assert.equal(isDangerous('install'), true);
  assert.equal(isDangerous('backup'), false);
  assert.equal(isDangerous('migrations'), false);
  assert.deepEqual(phaseOf({ t: 'install:start' }), { phase: 'install', active: true });
  assert.deepEqual(phaseOf({ t: 'install:done' }), { phase: 'install', active: false });
  assert.equal(phaseOf({ t: 'step:done' }), null);
});

test('Ink включается только там, где есть экран', () => {
  const tty = { isTTY: true };
  assert.equal(inkAvailable({ stdout: tty, env: {} }), true);
  assert.equal(inkAvailable({ stdout: { isTTY: false }, env: {} }), false);
  for (const flags of [{ plain: true }, { json: true }, { events: true }]) {
    assert.equal(inkAvailable({ stdout: tty, flags, env: {} }), false);
  }
  assert.equal(inkAvailable({ stdout: tty, env: { GITLAB_UPGRADE_PLAIN: '1' } }), false);
});

test('NO_COLOR и dumb-терминал уважаются', () => {
  assert.equal(wantsColor({ env: {} }), true);
  assert.equal(wantsColor({ env: { NO_COLOR: '' } }), false);
  assert.equal(wantsColor({ env: {}, flag: false }), false);
  assert.equal(wantsColor({ env: { TERM: 'dumb' } }), false);
  assert.deepEqual(createTheme({ color: false }).role('ok'), {});
});

test('часы шага показывают часы, а не минуты', () => {
  assert.equal(clock(7_646_000), '02:07:26');
  assert.equal(clock(0), '00:00:00');
  assert.equal(clock(-1), '00:00:00');
  assert.equal(clock(NaN), '00:00:00');
});

test('лента не растёт бесконечно за шесть часов', () => {
  const t = createTranslator('en');
  let s = initial();
  for (let i = 0; i < 900; i++) {
    s = reduce(s, { t: 'step:start', ts: '2026-08-30T13:31:21.000Z', index: 1, of: 1, version: '16.3.9-ee' }, t);
  }
  assert.ok(s.feed.length <= 500, `лента выросла до ${s.feed.length}`);
});

test('первый Ctrl-C на dpkg объясняет цену, второй прерывает', async () => {
  const t = createTranslator('ru');
  let aborted = 0;
  const { stdin, lastFrame, unmount } = render(
    <Run state={play(PATCH_RUN, 'ru')} t={t} theme={theme()} now={() => NOW} onAbort={() => { aborted += 1; }} />,
  );
  const tick = () => new Promise((r) => setTimeout(r, 20));
  await tick();

  stdin.write(String.fromCharCode(3));
  await tick();
  assert.equal(aborted, 0, 'первый Ctrl-C на dpkg не убивает процесс');
  assert.ok(lastFrame().includes('dpkg --configure -a'), 'вместо этого объясняет цену');

  stdin.write(String.fromCharCode(3));
  await tick();
  assert.equal(aborted, 1, 'второй Ctrl-C прерывает');
  unmount();
});

test('в безопасной фазе Ctrl-C прерывает сразу', async () => {
  let aborted = 0;
  const { stdin, unmount } = render(
    <Run state={play(LONG_RUN.slice(0, 9), 'ru')} t={createTranslator('ru')} theme={theme()}
      now={() => NOW} onAbort={() => { aborted += 1; }} />,
  );
  await new Promise((r) => setTimeout(r, 20));
  stdin.write(String.fromCharCode(3));
  await new Promise((r) => setTimeout(r, 20));
  // Пугать там, где прерывание безопасно, — верный способ научить не читать
  // предупреждения.
  assert.equal(aborted, 1);
  unmount();
});

/**
 * Настоящий кадр с боевой машины: «предзагрузка пакетовидёт».
 *
 * Живая строка не участвовала в расчёте ширины колонки, а `pad` отдаёт строку
 * как есть, когда она длиннее колонки. Подпись оказалась длиннее всего, что
 * успело попасть в ленту, разделитель исчез — и две колонки слиплись в одно
 * слово на экране, за которым человек смотрит часами.
 */
test('длинная подпись живой строки не склеивается со значением', () => {
  // Лента почти пуста — колонка узкая, а подпись длинная: ровно тот случай.
  const state = play([
    { t: 'run:start', ts: '2026-08-31T21:59:21.000Z', from: '13.12.15-ee', target: '18.11.11-ee', steps: 19, profile: 'long', versions: [] },
    { t: 'predownload:start', ts: '2026-08-31T21:59:22.000Z', total: 19 },
  ], 'ru');
  const text = frame(state, 'ru');
  const live = text.split('\n').find((l) => /предзагрузка/.test(l));
  assert.ok(live, `живой строки нет в кадре:\n${text}`);
  assert.ok(!/пакетовидёт/.test(live), `колонки склеились: «${live.trim()}»`);
  assert.match(live, /предзагрузка пакетов\s+идёт/);
});

test('подпись длиннее колонки не склеивается и в ленте', () => {
  // Колонка может быть уже подписи, но разделитель обязателен всегда.
  assert.equal(padCell('очень длинная подпись', 5), 'очень длинная подпись ');
  assert.equal(padCell('коротко', 12), 'коротко     ');
});
