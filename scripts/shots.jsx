import { readFileSync } from 'node:fs';
import { render } from 'ink-testing-library';
import { capture, shoot } from './screenshots.mjs';
import { createTranslator } from '../src/i18n/index.js';
import { createExec, MODE } from '../src/core/exec.js';
import { createPainter } from '../src/render/color.js';
import { printBlockers } from '../src/render/blockers.js';
import { createTheme } from '../src/ui/theme.js';
import { initial, reduce } from '../src/ui/runState.js';
import { Run, PathView } from '../src/ui/screens/Run.jsx';
import { commandDoctor } from '../src/commands/doctor.js';
import { commandPlan } from '../src/commands/plan.js';
import { checkFixtures, fixturesFor, ctlStatusDegraded, dfTight } from '../test/fixtures/index.js';
import { LONG_RUN, PATCH_RUN } from '../test/fixtures/run-events.js';

/**
 * Набор снимков для README.
 *
 * Два источника, и разница между ними указана в подписях в README:
 *
 * - `proxy test` снимается **вживую** — настоящий прокси, настоящий
 *   packages.gitlab.com, настоящий код возврата;
 * - `doctor`, `plan` и экраны `run` рисуются **настоящим кодом по записанным
 *   данным**: живого GitLab на стенде нет, а рисовать «как бы терминал»
 *   руками — врать ровно там, где README обещает правду.
 */
const PROXY = process.env.HTTPS_PROXY ?? '';
const BIN = 'dist/gitlab-upgrade.mjs';
const data = {
  upgradePath: JSON.parse(readFileSync('data/upgrade-path.json', 'utf8')),
  osMatrix: JSON.parse(readFileSync('data/os-matrix.json', 'utf8')),
  pgRequirements: JSON.parse(readFileSync('data/pg-requirements.json', 'utf8')),
};
const MADISON = readFileSync('test/fixtures/recorded/madison-ee-jammy.txt', 'utf8');

const ansi = createPainter({ color: true });
const inkTheme = createTheme({ color: true });

/** Экран Ink кадром со всеми ANSI: тот же компонент, что в бою. */
function inkFrame(element) {
  const { lastFrame, unmount } = render(element);
  const text = lastFrame();
  unmount();
  return text;
}

const play = (events, t) => events.reduce((s, e) => reduce(s, e, t), initial());

/** Блок блокеров печатает точка входа; здесь тот же вызов с теми же данными. */
function blockersOf(result, t) {
  const findings = result.result.findings;
  const count = (level) => findings.filter((f) => f.level === level).length;
  let text = '';
  printBlockers({
    findings, t, out: { write: (s) => { text += s; }, isTTY: true }, color: true,
    summary: t('doctor.summary', { ok: count('ok'), warnings: count('warn'), critical: count('critical') }),
  });
  return `${text}\n ${ansi('error', t(result.verdict))}\n`;
}

/** Контекст команды на записанных ответах: настоящий код, записанный вход. */
function ctxFor(locale, { fixtures, os, version = '17.11.4-ee.0', flags = {} }) {
  const t = createTranslator(locale);
  return {
    t, flags, paint: ansi, data,
    config: { proxy: null, minFreeGb: 5, backupDir: '/mnt/backup/gitlab' },
    exec: createExec({ mode: MODE.REPLAY, fixtures }),
    os, uid: 0, env: {}, isTty: true,
    gitlabInfo: { aptVersion: version, version: version.replace(/-ee\.0$/, ''), edition: 'ee', package: 'gitlab-ee' },
  };
}

const UBUNTU_22 = { id: 'ubuntu', versionId: '22.04', pretty: 'Ubuntu 22.04.4 LTS' };
const UBUNTU_20 = { id: 'ubuntu', versionId: '20.04', pretty: 'Ubuntu 20.04.6 LTS' };

const shots = [];
const add = (name, raw, title, cols) => shots.push(shoot(name, raw, { title, ...(cols ? { cols } : {}) }));

for (const locale of ['ru', 'en']) {
  const t = createTranslator(locale);
  const suffix = locale === 'ru' ? '.ru' : '';

  // 1. Живая диагностика: пройденная цепочка снимается там, где репозиторий
  //    действительно подключён, — внутри стенда.
  add(`proxy-test${suffix}`, capture(
    `docker run --rm --network host -v ${process.cwd()}/dist:/d:ro -v /root/.ccr:/ca:ro `
    + `gitlab-rehearsal:base node /d/gitlab-upgrade.mjs proxy test `
    + `--proxy ${PROXY} --proxy-ca /ca/ca-bundle.crt --lang ${locale}`,
  ), 'gitlab-upgrade proxy test');

  // 2. Живой обрыв: прокси на месте, но никто не слушает.
  add(`proxy-test-broken${suffix}`, capture(
    `node ${BIN} proxy test --proxy socks5h://10.0.0.5:1080 --lang ${locale}`,
  ), 'gitlab-upgrade proxy test');

  // 3. Блокеры: инстанс, который обновлять нельзя.
  const sick = ctxFor(locale, {
    fixtures: {
      ...fixturesFor({ version: '16.11.10-ee.0', madison: MADISON }),
      ...checkFixtures({ migrations: '3 1', pg: 'psql (PostgreSQL) 13.11', status: ctlStatusDegraded, df: dfTight }),
    },
    os: UBUNTU_20,
    version: '16.11.10-ee.0',
    flags: { to: '17.11.7-ee' },
  });
  const doctor = await commandDoctor(sick);
  add(`doctor${suffix}`, doctor.lines.join('\n'), 'sudo gitlab-upgrade doctor');

  // Блок блокеров печатает точка входа, а не команда — повторяем то же самое.
  add(`blockers${suffix}`, blockersOf(doctor, t), 'sudo gitlab-upgrade doctor');

  // 4. План: здоровый инстанс, настоящий список версий из репозитория.
  const healthy = ctxFor(locale, {
    fixtures: { ...fixturesFor({ version: '15.11.13-ee.0', madison: MADISON }), ...checkFixtures() },
    os: UBUNTU_22,
    version: '15.11.13-ee.0',
    flags: { to: '17.11.7-ee' },
  });
  const plan = await commandPlan(healthy);
  add(`plan${suffix}`, plan.lines.join('\n'), 'gitlab-upgrade plan --to 17.11.7-ee');

  // 5. Лента: экран `run` по записанному потоку событий.
  const now = () => Date.parse('2026-08-30T15:45:00.000Z');
  add(`run${suffix}`, inkFrame(
    <Run state={play(LONG_RUN, t)} t={t} theme={inkTheme} now={now} />,
  ), 'sudo gitlab-upgrade run --yes');

  // 6. Экран пути по [p].
  add(`path${suffix}`, inkFrame(
    <PathView state={play(LONG_RUN, t)} selected={2} t={t} theme={inkTheme} elapsed="03:30:12" />,
  ), 'gitlab-upgrade run — [p]');

  // 7. Компактный экран патча.
  add(`patch${suffix}`, inkFrame(
    <Run state={play(PATCH_RUN, t)} t={t} theme={inkTheme} now={() => Date.parse('2026-08-30T21:08:00.000Z')} />,
  ), 'sudo gitlab-upgrade run --yes');
}

for (const s of shots) process.stdout.write(`${s.name.padEnd(22)} ${s.size}\n`);
