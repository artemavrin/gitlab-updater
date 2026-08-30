import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { COMMANDS, COMMAND_NAMES, FLAGS } from '../src/cli/registry.js';
import { buildCatalog } from '../src/cli/catalog.js';
import { renderHelp, renderCommandHelp } from '../src/cli/help.js';
import { createTranslator, LOCALES } from '../src/i18n/index.js';
import { createExec, MODE } from '../src/core/exec.js';
import { commandCheck } from '../src/commands/check.js';
import { commandPlan } from '../src/commands/plan.js';
import { EXIT } from '../src/plan/planner.js';
import { ok, fail } from '../src/cli/envelope.js';
import { fixturesFor, osReleaseJammy } from './fixtures/index.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = {
  upgradePath: JSON.parse(readFileSync('data/upgrade-path.json', 'utf8')),
  osMatrix: JSON.parse(readFileSync('data/os-matrix.json', 'utf8')),
  pgRequirements: JSON.parse(readFileSync('data/pg-requirements.json', 'utf8')),
};
const dir = mkdtempSync(join(tmpdir(), 'glu-agent-'));
const osFile = join(dir, 'os-release');
writeFileSync(osFile, osReleaseJammy);

const ctx = (version = '17.11.4-ee.0') => ({
  exec: createExec({ mode: MODE.REPLAY, fixtures: fixturesFor({ version }) }),
  t: createTranslator('ru'),
  flags: { from: null, to: null, targetMajor: null, safeForOs: false, patchOnly: false },
  config: { proxy: null },
  data,
  osPath: osFile,
});

test('у каждой команды есть краткое описание в обеих локалях', () => {
  for (const lang of Object.keys(LOCALES)) {
    const t = createTranslator(lang);
    for (const name of COMMAND_NAMES) {
      const key = `cmd.${name}.summary`;
      assert.notEqual(t(key), key, `${lang}: нет описания команды ${name}`);
    }
  }
});

test('у каждого флага есть описание в обеих локалях', () => {
  for (const lang of Object.keys(LOCALES)) {
    const t = createTranslator(lang);
    for (const name of Object.keys(FLAGS)) {
      const key = `flag.${name}.desc`;
      assert.notEqual(t(key), key, `${lang}: нет описания флага --${name}`);
    }
  }
});

test('у каждого поля result есть описание в обеих локалях', () => {
  for (const lang of Object.keys(LOCALES)) {
    const t = createTranslator(lang);
    for (const [cmd, def] of Object.entries(COMMANDS)) {
      for (const field of Object.keys(def.result ?? {})) {
        const key = `result.${cmd}.${field}`;
        assert.notEqual(t(key), key, `${lang}: нет описания поля ${key}`);
      }
    }
  }
});

test('у каждого кода возврата есть расшифровка', () => {
  const t = createTranslator('en');
  for (const def of Object.values(COMMANDS)) {
    for (const meaning of Object.values(def.exits)) {
      assert.notEqual(t(`exit.${meaning}`), `exit.${meaning}`, `нет расшифровки кода ${meaning}`);
    }
  }
});

test('коды возврата в реестре совпадают с константами планировщика', () => {
  assert.deepEqual(
    Object.keys(COMMANDS.check.exits).map(Number).sort((a, b) => a - b),
    [EXIT.CURRENT, EXIT.ERROR, EXIT.PATCH, EXIT.MINOR, EXIT.MAJOR].sort((a, b) => a - b)
  );
});

test('справка перечисляет все флаги команды — расходиться с реестром нечему', () => {
  const t = createTranslator('en');
  for (const name of COMMAND_NAMES) {
    const text = renderCommandHelp(t, name).join('\n');
    for (const flag of COMMANDS[name].flags) {
      assert.match(text, new RegExp(`--${flag}\\b`), `${name}: в справке нет --${flag}`);
    }
  }
});

test('общая справка перечисляет все команды и все флаги', () => {
  const text = renderHelp(createTranslator('ru')).join('\n');
  for (const name of COMMAND_NAMES) assert.match(text, new RegExp(`\\b${name}\\b`));
  for (const flag of Object.keys(FLAGS)) assert.match(text, new RegExp(`--${flag}\\b`));
});

test('справка по неизвестной команде не падает, а объясняет', () => {
  const text = renderCommandHelp(createTranslator('ru'), 'нетакой').join('\n');
  assert.match(text, /неизвестная команда/);
});

/**
 * Анти-дрейф: объявленные поля result должны в точности совпадать
 * с тем, что команда действительно возвращает.
 */
test('фактический result совпадает с объявленным в реестре', async () => {
  for (const [name, run] of [['check', commandCheck], ['plan', commandPlan]]) {
    for (const version of ['17.11.4-ee.0', '15.11.13-ee.0', '17.11.6-ee.0']) {
      const res = await run(ctx(version));
      const declared = Object.keys(COMMANDS[name].result).sort();
      const actual = Object.keys(res.result ?? {}).sort();
      assert.deepEqual(actual, declared, `${name} на ${version}: поля result разошлись с реестром`);
    }
  }
});

test('конверт одинаков у успеха и у ошибки', () => {
  const good = ok('check', { version: '0.1.0', exit: 10, result: { current: 'x' } });
  const bad = fail('check', { version: '0.1.0', code: 'no-gitlab', message: 'нет GitLab' });
  assert.deepEqual(Object.keys(good).sort(), Object.keys(bad).sort());
  assert.equal(good.ok, true);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'no-gitlab');
});

test('каталог валиден, полон и не течёт непереведёнными ключами', () => {
  const c = buildCatalog(createTranslator('en'), { version: '0.1.0' });
  assert.equal(c.contract, 1);
  assert.deepEqual(Object.keys(c.commands).sort(), [...COMMAND_NAMES].sort());
  assert.ok(c.usage.readOnly.includes('check'));
  const flat = JSON.stringify(c);
  assert.ok(!/"cmd\.|"flag\.|"exit\.|"result\./.test(flat), 'в каталог утёк ключ локали вместо текста');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(c)));
});

test('каждый код ошибки описан в каталоге', () => {
  const c = buildCatalog(createTranslator('ru'), { version: '0.1.0' });
  for (const [code, text] of Object.entries(c.errorCodes)) {
    assert.notEqual(text, `error.code.${code}`, `нет описания кода ${code}`);
  }
  assert.ok(Object.hasOwn(c.errorCodes, 'repository-unreachable'));
  // Перечень выводится из локалей: захардкоженный список молча отстал бы
  // от кодов, которые команды реально возвращают.
  for (const code of ['migrations-failed', 'already-running', 'step-failed', 'package-unknown']) {
    assert.ok(Object.hasOwn(c.errorCodes, code), `в каталоге нет кода ${code}`);
  }
});

test('недоступный репозиторий даёт конкретный код, а не общий', async () => {
  const broken = ctx();
  broken.exec = createExec({ mode: MODE.REPLAY, fixtures: { ...fixturesFor(), 'apt-cache madison gitlab-ee': { code: 100, stdout: '', stderr: 'E: nope' } } });
  const res = await commandCheck(broken);
  assert.equal(res.errorCode, 'repository-unreachable');
  assert.equal(res.detail, 'E: nope');
});

test('api отдаёт валидный JSON через настоящий запуск CLI', () => {
  const out = execFileSync('node', ['bin/gitlab-upgrade.js', 'api'], { encoding: 'utf8' });
  const c = JSON.parse(out);
  assert.equal(c.tool, 'gitlab-upgrade');
  assert.ok(c.commands.check.mutating === false);
  assert.ok(c.commands.check.requiresRoot === true);
});

test('--json отдаёт ровно один документ, а --events не смешивается с ним', () => {
  const out = execFileSync('node', ['bin/gitlab-upgrade.js', 'version', '--json'], { encoding: 'utf8' });
  const env = JSON.parse(out);
  assert.equal(env.command, 'version');
  assert.equal(env.ok, true);
  assert.equal(env.result.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
});
