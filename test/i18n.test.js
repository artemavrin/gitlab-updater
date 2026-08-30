import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, createTranslator, resolveLocale, DEFAULT_LOCALE } from '../src/i18n/index.js';

test('паритет ключей между локалями', () => {
  const [a, b] = Object.keys(LOCALES);
  const ka = Object.keys(LOCALES[a]).sort();
  const kb = Object.keys(LOCALES[b]).sort();
  assert.deepEqual(ka, kb, `ключи ${a} и ${b} разошлись`);
});

test('ни одна локаль не содержит пустых значений', () => {
  for (const [name, dict] of Object.entries(LOCALES)) {
    for (const [key, value] of Object.entries(dict)) {
      const empty = Array.isArray(value) ? value.some((v) => !String(v).trim()) : !String(value).trim();
      assert.ok(!empty, `${name}: пустое значение у ${key}`);
    }
  }
});

test('русская плюрализация на границах 1/2/5/11/21', () => {
  const t = createTranslator('ru');
  const forms = [1, 2, 5, 11, 21, 101].map((n) => t('plan.steps', { n }));
  assert.deepEqual(forms, ['1 шаг', '2 шага', '5 шагов', '11 шагов', '21 шаг', '101 шаг']);
});

test('английская плюрализация — две формы', () => {
  const t = createTranslator('en');
  assert.deepEqual([1, 2, 5].map((n) => t('plan.steps', { n })), ['1 step', '2 steps', '5 steps']);
});

test('неизвестный ключ возвращается как есть, а не пустой строкой', () => {
  assert.equal(createTranslator('ru')('нет.такого.ключа'), 'нет.такого.ключа');
});

test('порядок источников: флаг > env > конфиг > локаль > en', () => {
  assert.equal(resolveLocale({ flag: 'en', env: { LANG: 'ru_RU.UTF-8' }, config: 'ru' }), 'en');
  assert.equal(resolveLocale({ env: { GITLAB_UPGRADE_LANG: 'ru' }, config: 'en' }), 'ru');
  assert.equal(resolveLocale({ env: {}, config: 'ru' }), 'ru');
  assert.equal(resolveLocale({ env: { LANG: 'ru_RU.UTF-8' } }), 'ru');
  assert.equal(resolveLocale({ env: { LANG: 'C' } }), DEFAULT_LOCALE);
  assert.equal(resolveLocale({ env: { LANG: 'fr_FR.UTF-8' } }), DEFAULT_LOCALE, 'непереведённая локаль не должна ломать запуск');
});
