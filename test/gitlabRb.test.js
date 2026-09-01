import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSettings, firstConflict, readSettings, settingsGrep } from '../src/detect/gitlabRb.js';
import { REMEDIES, NO_REMEDY } from '../src/checks/remedies.js';
import { LOCALES, createTranslator } from '../src/i18n/index.js';

const rbConflicts = JSON.parse(readFileSync('data/gitlab-rb-conflicts.json', 'utf8'));
const KEYS = [...new Set(rbConflicts.rules.flatMap((r) => r.all_true))];

/**
 * Несовместимые настройки gitlab.rb.
 *
 * Живой случай: на 13.12 сочетание smtp_tls + smtp_enable_starttls_auto
 * лежало в файле годами, а на седьмом шаге из девятнадцати (15.11.13)
 * reconfigure отказался работать — уже ПОСЛЕ установки пакета. Пакет остался
 * ненастроенным, миграции не прошли, следующий бэкап упал на схеме.
 */

test('булевы значения разбираются, комментарии — нет', () => {
  const found = parseSettings(`
# gitlab_rails['smtp_tls'] = true
  gitlab_rails['smtp_enable'] = true
gitlab_rails['smtp_tls'] = true
   # закомментированная строка с тем же ключом ничего не значит
gitlab_rails['smtp_enable_starttls_auto'] = false
gitlab_rails['smtp_port'] = 587
`);
  assert.equal(found.get("gitlab_rails['smtp_enable']"), 'true');
  assert.equal(found.get("gitlab_rails['smtp_tls']"), 'true');
  assert.equal(found.get("gitlab_rails['smtp_enable_starttls_auto']"), 'false');
  assert.equal(found.get("gitlab_rails['smtp_port']"), '587');
});

test('последнее присваивание побеждает — так же, как это видит Ruby', () => {
  const found = parseSettings(`gitlab_rails['smtp_tls'] = true\ngitlab_rails['smtp_tls'] = false\n`);
  assert.equal(found.get("gitlab_rails['smtp_tls']"), 'false');
});

test('двойные кавычки в ключе — тот же ключ', () => {
  // gitlab.rb допускает обе формы, а правило написано в одной.
  const found = parseSettings(`gitlab_rails["smtp_tls"] = true\n`);
  assert.equal(found.get("gitlab_rails['smtp_tls']"), 'true');
});

const bothOn = parseSettings([
  "gitlab_rails['smtp_enable'] = true",
  "gitlab_rails['smtp_tls'] = true",
  "gitlab_rails['smtp_enable_starttls_auto'] = true",
].join('\n'));

test('правило срабатывает на шаге, где запрет уже есть', () => {
  const steps = [
    { version: '14.0.12-ee.0' }, { version: '15.0.5-ee.0' },
    { version: '15.11.13-ee.0' }, { version: '16.3.9-ee.0' },
  ];
  const hit = firstConflict(rbConflicts.rules, bothOn, steps);
  assert.ok(hit, 'сочетание smtp_tls + starttls_auto обязано находиться');
  assert.equal(hit.rule.id, 'smtp-tls-starttls');
  // Именно 15.11.13, а не 16.3.9: сорвётся первый же шаг с запретом.
  assert.equal(hit.step, '15.11.13-ee.0');
});

test('путь, который до запрета не доходит, не трогаем', () => {
  // Проверено по исходникам omnibus-gitlab: smtp_helper.rb есть с тега
  // 15.11.4+ee.0 и нет в 15.11.3. Тот, кто идёт до 15.11.3, ничего не должен
  // чинить ради версии, до которой не пойдёт.
  const steps = [{ version: '14.10.5-ee.0' }, { version: '15.11.3-ee.0' }];
  assert.equal(firstConflict(rbConflicts.rules, bothOn, steps), null);
});

test('одной включённой настройки мало — это рабочая конфигурация', () => {
  // Обратное направление важнее прямого: проверка, которая останавливает
  // исправный сервер, будет снята вместе со всеми остальными.
  const steps = [{ version: '16.3.9-ee.0' }];
  for (const off of ["gitlab_rails['smtp_tls']", "gitlab_rails['smtp_enable_starttls_auto']", "gitlab_rails['smtp_enable']"]) {
    const settings = new Map(bothOn);
    settings.set(off, 'false');
    assert.equal(firstConflict(rbConflicts.rules, settings, steps), null, `${off} = false — конфликта нет`);
  }
  assert.equal(firstConflict(rbConflicts.rules, new Map(), steps), null, 'пустой gitlab.rb — не конфликт');
});

test('читаем только нужные ключи, а не файл целиком', async () => {
  // В gitlab.rb лежат пароль SMTP и токены. Поднимать их в память ради двух
  // булевых значений незачем — тем более что вывод упавшей команды инструмент
  // сохраняет в файл.
  const seen = [];
  await readSettings(async (argv) => { seen.push(argv); return { code: 1, stdout: '' }; }, KEYS);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'grep', `команда должна быть grep, а не ${seen[0][0]}`);
  assert.ok(!seen[0].includes('cat'), seen[0].join(' '));
  for (const key of KEYS) assert.ok(seen[0][2].includes(key.replace(/[[\]]/g, '\\$&')), `${key} не попал в шаблон`);
});

test('нечитаемый gitlab.rb — «не знаем», а не «в порядке»', async () => {
  // grep отвечает 2, когда файла нет или не хватило прав: под обычным
  // пользователем gitlab.rb (0600 у root) не читается.
  assert.equal(await readSettings(async () => ({ code: 2, stdout: '' }), KEYS), null);
  assert.equal(await readSettings(async () => { throw new Error('нет grep'); }, KEYS), null);
  // А «ни одной строки» — полноценный ответ: настроек просто нет.
  assert.deepEqual(await readSettings(async () => ({ code: 1, stdout: '' }), KEYS), new Map());
});

test('шаблон grep выдерживает квадратные скобки и кавычки ключа', () => {
  const [, , pattern] = settingsGrep(["gitlab_rails['smtp_tls']"]);
  const re = new RegExp(pattern.replace(/\\s/g, '[ \\t]'));
  assert.ok(re.test("gitlab_rails['smtp_tls'] = true"));
  assert.ok(!re.test("gitlab_rails['smtp_tlsx'] = true"), 'скобки должны быть литералами, а не классом символов');
});

/**
 * Правило в данных без текста и без починки — это правило, которое сработает
 * и не сможет ничего сказать. Ровно посреди подъёма.
 */
test('у каждого правила есть текст находки и запись о починке', () => {
  for (const rule of rbConflicts.rules) {
    const key = `rb-${rule.id}.critical`;
    assert.ok(Object.hasOwn(REMEDIES, key) || NO_REMEDY.has(key), `${key}: нет ни починки, ни явного «команды нет»`);
    for (const locale of Object.keys(LOCALES)) {
      const t = createTranslator(locale);
      assert.ok(t.has(`check.${key}`), `${locale}: нет текста check.${key}`);
      // Версию запрета и шаг человек обязан увидеть: без них находка
      // сообщает о проблеме, но не о том, когда она случится.
      const text = t(`check.${key}`, { since: rule.since, step: '15.11.13-ee.0' });
      assert.ok(text.includes(rule.since), `${locale}: текст не называет версию запрета`);
      assert.ok(text.includes('15.11.13-ee.0'), `${locale}: текст не называет шаг`);
    }
  }
});

test('данные о правилах сверены с исходником, а не с документацией', () => {
  // Документация не называет версию, в которой запрет появился. Без ссылки на
  // конкретный коммит порог «since» проверить нечем, а ошибка в нём — либо
  // пропущенный обрыв, либо остановленный исправный сервер.
  assert.match(rbConflicts.verified_at, /^\d{4}-\d{2}-\d{2}$/);
  for (const rule of rbConflicts.rules) {
    assert.match(rule.since, /^\d+\.\d+\.\d+$/, `${rule.id}: since должен быть точной версией`);
    assert.match(rule.source, /^https:\/\//, `${rule.id}: нет ссылки на исходник`);
    assert.ok(rule.since_note?.length > 40, `${rule.id}: не объяснено, откуда взят порог`);
    assert.ok(rule.all_true?.length >= 2, `${rule.id}: правило из одного ключа — это не конфликт`);
  }
});

/**
 * И настоящий grep, а не только регулярка в Node.
 *
 * Шаблон уходит в GNU grep -E, где `\s` — расширение, а `[` и `]` без
 * экранирования открыли бы класс символов. Проверять это в JS-регулярке
 * бессмысленно: она разбирает шаблон по своим правилам. Ровно на таком
 * предположении инструмент уже ошибался.
 */
test('шаблон работает в настоящем grep и не выносит из файла лишнего', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-'));
  const rb = join(dir, 'gitlab.rb');
  writeFileSync(rb, [
    '### комментарий',
    "# gitlab_rails['smtp_tls'] = true",
    "gitlab_rails['smtp_enable'] = true",
    'gitlab_rails[\'smtp_password\'] = "пароль-который-не-должен-уехать"',
    "  gitlab_rails['smtp_tls'] = true",
    "gitlab_rails['smtp_enable_starttls_auto'] = true",
    '',
  ].join('\n'));

  const argv = settingsGrep(KEYS, { rb });
  const out = await new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(null); // нет grep — не наш случай
      if (err && err.code !== 1) return reject(err);
      resolve(stdout);
    });
  });
  try {
    if (out === null) return;
    assert.ok(!out.includes('пароль-который-не-должен-уехать'), 'из gitlab.rb вынесли лишнее');
    const found = parseSettings(out);
    assert.equal(found.size, 3, out);
    assert.ok(firstConflict(rbConflicts.rules, found, [{ version: '15.11.13-ee.0' }]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
