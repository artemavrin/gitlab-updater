import test from 'node:test';
import assert from 'node:assert/strict';
import { REMEDIES, NO_REMEDY, remedyFor } from '../src/checks/remedies.js';
import { LOCALES, createTranslator } from '../src/i18n/index.js';

const LOCALE_IDS = Object.keys(LOCALES);

/** Все находки, которые вообще могут случиться, — по ключам локали. */
const FINDINGS = Object.keys(LOCALES.en)
  .filter((k) => k.startsWith('check.') && /\.(warn|critical)$/.test(k))
  .map((k) => k.slice('check.'.length));

test('у каждой находки есть либо починка, либо явное «команды нет»', () => {
  for (const key of FINDINGS) {
    const known = Object.hasOwn(REMEDIES, key) || NO_REMEDY.has(key);
    // Молчание неотличимо от забытой строки в таблице: список должен быть явным.
    assert.ok(known, `находка ${key} не описана ни в REMEDIES, ни в NO_REMEDY`);
  }
});

test('в таблице нет починок для несуществующих находок', () => {
  const all = new Set(FINDINGS);
  for (const key of [...Object.keys(REMEDIES), ...NO_REMEDY]) {
    assert.ok(all.has(key), `починка ${key} описана, а такой находки нет`);
  }
});

for (const locale of LOCALE_IDS) {
  test(`каждая починка переведена — ${locale}`, () => {
    const t = createTranslator(locale);
    for (const spec of Object.values(REMEDIES).flatMap((e) => (e.table ? e.table.map((r) => r.spec) : [e]))) {
      assert.ok(t.has(`remedy.${spec.id}`), `${locale}: нет текста remedy.${spec.id}`);
      assert.ok(t(`remedy.${spec.id}`).length > 0);
    }
  });
}

const specsOf = (entry) => (entry.table ? entry.table.map((r) => r.spec) : [entry]);
const ALL_SPECS = Object.values(REMEDIES).flatMap(specsOf);

test('починка — команда, флаг или документация, но ровно что-то одно', () => {
  for (const spec of ALL_SPECS) {
    const kinds = [
      Array.isArray(spec.argv) && spec.argv.length > 0,
      typeof spec.flag === 'string' && spec.flag.startsWith('--'),
      spec.argv === null && !spec.flag && Boolean(spec.docs),
    ].filter(Boolean);
    assert.equal(kinds.length, 1, `${spec.id}: должно быть ровно одно из argv/flag/docs`);
  }
});

/**
 * Порог rake-задачи сверен с исходниками, а не написан по памяти.
 *
 * Прошлая версия этого теста закрепляла две мои выдумки: что задачи появились
 * в 18.5 и что в 18.9 появилась `:list`. Первое отняло у человека рабочую
 * команду на 18.2.8 — там инструмент отдал только ссылку. Второе хуже:
 * `:list` не существует ни в одном теге, и на 18.9+ инструмент печатал бы
 * команду, которая не выполнится.
 *
 * Проверено: lib/tasks/gitlab/background_migrations.rake есть с v14.6.0-ee
 * (в v14.5.4-ee только :finalize, в v14.0.12-ee файла нет), задача :status в
 * нём с тех же пор и до v18.11.0-ee, а задачи :list нет нигде.
 */
test('rake-задача выбирается по версии инстанса', () => {
  const f = { id: 'migrations-failed', level: 'critical', params: {} };
  const status = ['gitlab-rake', 'gitlab:background_migrations:status'];

  // Та самая версия с живого сервера: команда есть, и она обязана быть названа.
  assert.deepEqual(remedyFor(f, { version: '18.2.8-ee' }).argv, status);
  assert.deepEqual(remedyFor(f, { version: '18.11.0-ee' }).argv, status, 'в новых версиях задача та же');
  assert.deepEqual(remedyFor(f, { version: '14.6.0-ee' }).argv, status, 'нижняя граница включительно');

  assert.equal(remedyFor(f, { version: '14.5.4-ee' }).argv, null,
    'в 14.5 задачи :status ещё нет — остаётся документация');
  // Версия неизвестна — самый общий вариант, а не самый новый.
  assert.equal(remedyFor(f, {}).argv, null);
});

test('в починках нет ни одной выдуманной rake-задачи', () => {
  // Задач в файле ровно две за всю историю: :status и :finalize. Всё, что
  // инструмент называет, должно быть одной из них — иначе это опять сочинение.
  const REAL = new Set(['gitlab:background_migrations:status', 'gitlab:background_migrations:finalize']);
  for (const spec of ALL_SPECS) {
    const task = spec.argv?.find((a) => a.startsWith('gitlab:background_migrations:'));
    if (task) assert.ok(REAL.has(task), `задачи ${task} не существует`);
  }
});

test('незаполненный плейсхолдер не выдаётся за готовую команду', () => {
  // Строка вида `gitlab-ctl restart {missing}` выглядит копируемой, но не
  // выполнится — лучше не показать ничего.
  assert.equal(remedyFor({ id: 'services', level: 'critical', params: {} }), null);
  assert.deepEqual(
    remedyFor({ id: 'services', level: 'critical', params: { missing: 'sidekiq' } }).argv,
    ['gitlab-ctl', 'restart', 'sidekiq'],
  );
});

test('у пройденной проверки починки нет', () => {
  assert.equal(remedyFor({ id: 'postgres', level: 'ok', params: {} }), null);
});

test('ссылки на документацию ведут на docs.gitlab.com по https', () => {
  for (const spec of ALL_SPECS) {
    if (!spec.docs) continue;
    assert.match(spec.docs, /^https:\/\/docs\.gitlab\.com\//, `${spec.id}: подозрительная ссылка ${spec.docs}`);
  }
});

/**
 * Все находки, какие бывают, — с правдоподобно длинными параметрами.
 * Так проверяется не одна выборка, а весь набор в обеих локалях.
 */
const SAMPLE = {
  missing: 'sidekiq', running: '8', total: '9', n: '12',
  detail: 'PG::UniqueViolation on project_statistics.project_id',
  path: '/var/opt/gitlab', free: '1', need: '5',
  have: '13.11', max: '16', target: '17.11.6-ee',
  os: 'Ubuntu 20.04.6 LTS', check: 'postgres', stop: '16.7.10-ee',
};

const everyFinding = () => FINDINGS.map((key) => {
  const [level] = key.split('.').slice(-1);
  const id = key.slice(0, -(level.length + 1));
  const message = LOCALES.en[`check.${key}`];
  const params = Object.fromEntries(
    [...String(message).matchAll(/\{(\w+)\}/g)].map((m) => [m[1], SAMPLE[m[1]] ?? 'x']),
  );
  // check — идентификатор проверки, а не находки: у `migrations-failed`
  // заголовок берётся у `migrations`.
  return { id, level, check: id.split('-')[0], params, remedy: remedyFor({ id, level, params }) };
});

for (const locale of LOCALE_IDS) {
  test(`ни одна строка блокеров не длиннее 78 колонок — ${locale}`, async () => {
    const { renderBlockers, renderFindings } = await import('../src/commands/doctor.js');
    const t = createTranslator(locale);
    const findings = everyFinding();
    for (const line of [...renderBlockers(t, findings), ...renderFindings(t, findings)]) {
      assert.ok([...line].length <= 78, `${locale}: ${[...line].length} колонок — «${line}»`);
    }
  });

  test(`объяснение блокера не обрезается — ${locale}`, async () => {
    const { renderBlockers } = await import('../src/commands/doctor.js');
    const t = createTranslator(locale);
    const text = renderBlockers(t, everyFinding()).join('\n');
    // Обрезалось именно объяснение, почему нельзя идти дальше.
    assert.ok(!text.includes('…'), `${locale}: в блоке блокеров есть обрезка`);
    for (const key of FINDINGS) {
      const [level] = key.split('.').slice(-1);
      const id = key.slice(0, -(level.length + 1));
      const params = Object.fromEntries(
        [...String(LOCALES[locale][`check.${key}`]).matchAll(/\{(\w+)\}/g)].map((m) => [m[1], SAMPLE[m[1]] ?? 'x']),
      );
      const last = t(`check.${id}.${level}`, params).split(/\s+/).pop();
      assert.ok(text.includes(last), `${locale}/${key}: последнее слово «${last}» не доехало`);
    }
  });
}

test('починка без команды не печатает пустую строку вместо неё', async () => {
  const { renderBlockers } = await import('../src/commands/doctor.js');
  const { remedyFor: remedy } = await import('../src/checks/remedies.js');
  const t = createTranslator('ru');
  const f = { id: 'migrations-failed', check: 'migrations', level: 'critical', params: { n: 1 } };
  const out = renderBlockers(t, [{ ...f, remedy: remedy(f, { version: '16.11.10-ee' }) }]).join('\n');
  assert.ok(!/\bnull\b|\bundefined\b/.test(out), `в выводе есть заглушка:\n${out}`);
  assert.ok(out.includes('https://docs.gitlab.com/update/background_migrations/'));
});
