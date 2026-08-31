import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMadison, compareVersions, parseVersion } from '../src/plan/version.js';
import { buildPlan, PROFILE } from '../src/plan/planner.js';
import upgradePath from '../data/upgrade-path.json' with { type: 'json' };

/**
 * Тесты на записанном ответе настоящего репозитория, а не на выборке.
 *
 * Именно выборка в прошлый раз спрятала пропущенную остановку 17.1: в
 * фикстуре не было ни одной версии 17.1, и пропуск шага не мог проявиться.
 */
const RAW = readFileSync(new URL('./fixtures/recorded/madison-ee-jammy.txt', import.meta.url), 'utf8');
const VERSIONS = parseMadison(RAW);

test('парсер разбирает весь реальный вывод, а не большинство строк', () => {
  const lines = RAW.split('\n').filter((l) => l.trim()).length;
  assert.equal(VERSIONS.length, lines, `разобрано ${VERSIONS.length} из ${lines}`);
  assert.ok(lines > 300, 'записанный ответ должен быть настоящим, а не огрызком');
});

test('версии отсортированы и границы совпадают с репозиторием', () => {
  for (let i = 1; i < VERSIONS.length; i++) {
    assert.ok(compareVersions(VERSIONS[i - 1], VERSIONS[i]) <= 0, 'порядок нарушен');
  }
  // На jammy пакетов ниже 15.5 нет вовсе — инстанс 13.x там не соберёт путь.
  assert.equal(VERSIONS[0].raw, '15.5.0-ee.0');
});

test('путь с 15.11 проходит все обязательные остановки, что есть в репозитории', () => {
  const plan = buildPlan({ current: '15.11.13-ee', available: VERSIONS, stops: upgradePath.stops });
  assert.equal(plan.profile, PROFILE.LONG);
  const got = plan.steps.map((s) => `${s.major}.${s.minor}`);
  const from = parseVersion('15.11.13-ee');
  const to = plan.target;
  // Каждая официальная остановка между началом и целью обязана быть в пути.
  for (const stop of upgradePath.stops) {
    const v = parseVersion(String(stop.version ?? stop));
    if (compareVersions(v, from) <= 0 || compareVersions(v, to) > 0) continue;
    const available = VERSIONS.some((x) => x.major === v.major && x.minor === v.minor);
    if (!available) continue;
    assert.ok(got.includes(`${v.major}.${v.minor}`), `пропущена остановка ${v.major}.${v.minor}`);
  }
});

test('путь монотонен и не топчется на месте', () => {
  const plan = buildPlan({ current: '16.11.10-ee', available: VERSIONS, stops: upgradePath.stops });
  for (let i = 1; i < plan.steps.length; i++) {
    assert.ok(compareVersions(plan.steps[i - 1], plan.steps[i]) < 0, 'шаг не двигает версию вперёд');
  }
  assert.ok(plan.steps.length > 0);
});

test('патч внутри минорной версии остаётся одним шагом', () => {
  const plan = buildPlan({ current: '17.11.4-ee', available: VERSIONS, stops: upgradePath.stops, to: '17.11.7-ee' });
  assert.equal(plan.profile, PROFILE.PATCH);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].raw, '17.11.7-ee.0');
});

/**
 * Потолки ОС сверены с репозиторием, а не взяты из головы.
 *
 * До 31.08.2026 здесь стояло «Ubuntu 20.04 → 17.7», хотя для focal
 * опубликовано до 18.11.11 — ошибка больше чем на мажорную версию, и
 * пользователь с focal получил бы предложение остановиться на полтора года
 * раньше, чем нужно. Числа теперь проверены `apt-cache madison` в
 * контейнере с официальным репозиторием для каждого кодового имени.
 */
test('потолки ОС не ниже того, что реально опубликовано', () => {
  const matrix = JSON.parse(readFileSync('data/os-matrix.json', 'utf8'));
  // jammy проверяется записанным ответом: 19.3.1 опубликована, потолка нет.
  assert.equal(matrix.max['ubuntu:22.04'], null, 'у поддерживаемой ОС потолка быть не должно');
  assert.equal(VERSIONS.at(-1).raw, '19.3.1-ee.0');

  // Числа, снятые с репозитория 31.08.2026. Меняются только вместе со сверкой.
  assert.equal(matrix.max['ubuntu:20.04'], '18.11');
  assert.equal(matrix.max['ubuntu:18.04'], '16.11');
  assert.ok(matrix.source, 'у данных должен быть указан источник');
  assert.ok(matrix.verified_at, 'и дата сверки');
});

/**
 * Требования PostgreSQL: ниже GitLab 16 их не ставим, и это решение, а не пробел.
 *
 * В таблице версий пакета для 14.0 и 15.0 стоят числа 12.7 и 12.10, и однажды
 * я принял их за минимум. Это столбцы «ships» и «default for upgrades» — то,
 * что пакет приносит и во что обновляет сам. Примечание в строке 14.0 вообще
 * про repmgr, а не про PostgreSQL. Ошибка стоила бы пользователю остановки на
 * первом же шаге: 13.12 несёт PostgreSQL 12.6, и взять 12.7 до установки 14.0
 * ему негде — их приносит сама 14.0.
 *
 * Жёстких барьеров в таблице два, оба со словами «package upgrades are
 * aborted»: 17.0.0 требует PostgreSQL 14, 18.0.0 требует 16. Оба уже покрыты
 * диапазонами 17.0 и 18.0 из таблицы requirements.
 */
test('требования PostgreSQL не выдуманы ниже 16 и совпадают с таблицей выше', async () => {
  const pg = JSON.parse(readFileSync('data/pg-requirements.json', 'utf8'));
  const { postgresRange } = await import('../src/plan/matrices.js');

  // Путь с 13.x не должен упираться в барьер, которого документация не ставит.
  assert.equal(postgresRange(pg, '13.12.15-ee.0'), null);
  assert.equal(postgresRange(pg, '14.0.12-ee.0'), null);
  assert.equal(postgresRange(pg, '15.11.13-ee.0'), null);

  // Выше — таблица «Minimum PostgreSQL version», слово в слово.
  assert.equal(postgresRange(pg, '16.11.10-ee.0').min, '13.6');
  assert.equal(postgresRange(pg, '17.11.6-ee.0').min, '14.14');  // барьер 17.0.0: PG 14
  assert.equal(postgresRange(pg, '18.11.11-ee.0').min, '16.5');  // барьер 18.0.0: PG 16
  assert.ok(pg.hard_gates.includes('aborted'), 'барьеры должны быть названы своими словами');
});
