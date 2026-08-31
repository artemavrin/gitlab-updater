import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandConfig } from '../src/commands/config.js';
import { SETTINGS, SETTING_NAMES, parseSetting, setSetting, unsetSetting, settingKey } from '../src/cli/settings.js';
import { resolveConfig } from '../src/cli/config.js';
import { createTranslator, LOCALES } from '../src/i18n/index.js';
import { EXIT } from '../src/plan/planner.js';

const t = createTranslator('ru');
const dir = () => mkdtempSync(join(tmpdir(), 'cfg-'));

function ctx(path, args, over = {}) {
  const { values, sources } = resolveConfig({ path, flags: {}, env: {} });
  return { t, args, flags: { configPath: path }, config: { ...values, configPath: path }, sources, ...over };
}

test('значение проверяется на месте, а не при следующем запуске', () => {
  // Настройка, которая не работает, не должна тихо записаться и
  // обнаружиться через месяц посреди апгрейда.
  assert.throws(() => parseSetting('proxy', 'ftp://x'), (e) => e.code === 'setting-not-proxy');
  assert.throws(() => parseSetting('min-free-gb', 'много'), (e) => e.code === 'setting-not-number');
  assert.throws(() => parseSetting('min-free-gb', '0'), (e) => e.code === 'setting-not-number');
  assert.throws(() => parseSetting('lang', 'de'), (e) => e.code === 'setting-not-choice');
  assert.throws(() => parseSetting('notify', 'может быть'), (e) => e.code === 'setting-not-boolean');
  assert.throws(() => parseSetting('proxy-ca', '/нет/такого'), (e) => e.code === 'setting-missing-path');
  assert.throws(() => parseSetting('nonsense', 'x'), (e) => e.code === 'setting-unknown');

  assert.equal(parseSetting('proxy', 'socks5h://10.0.0.5:1080'), 'socks5h://10.0.0.5:1080');
  assert.equal(parseSetting('notify', 'no'), false);
  assert.equal(parseSetting('min-free-gb', '12'), 12);
});

test('ошибка про прокси не печатает пароль', () => {
  // Сообщение об ошибке уезжает в тикеты чаще, чем сам конфиг.
  try {
    parseSetting('proxy', 'ftp://user:s3cret@10.0.0.5:1080');
    assert.fail('должно было упасть');
  } catch (e) {
    assert.ok(!JSON.stringify(e.params).includes('s3cret'), JSON.stringify(e.params));
  }
});

test('файл пишется атомарно и с правами 0600', () => {
  const d = dir();
  const path = join(d, 'config.json');
  setSetting('proxy', 'socks5h://10.0.0.5:1080', { path });
  // В конфиге лежат пароль прокси и токен бота.
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { proxy: 'socks5h://10.0.0.5:1080' });
  // Временных файлов после себя не оставляем.
  assert.deepEqual(readdirSync(d), ['config.json']);
  rmSync(d, { recursive: true, force: true });
});

test('set не затирает соседние ключи, unset убирает только свой', () => {
  const d = dir();
  const path = join(d, 'config.json');
  writeFileSync(path, JSON.stringify({ backupDir: '/mnt/backup', notify: false }));
  setSetting('proxy', 'http://10.0.0.5:8080', { path });
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.backupDir, '/mnt/backup');
  assert.equal(after.notify, false);

  unsetSetting('proxy', { path });
  const later = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(Object.hasOwn(later, 'proxy'), false);
  assert.equal(later.backupDir, '/mnt/backup');
  rmSync(d, { recursive: true, force: true });
});

test('секреты не показываются целиком нигде', async () => {
  const d = dir();
  const path = join(d, 'config.json');
  writeFileSync(path, JSON.stringify({
    proxy: 'socks5h://svc:s3cret@10.0.0.5:1080',
    telegramToken: '123456:AAbbCCddEEff',
    slackWebhook: 'https://hooks.slack.com/services/T/B/xyz',
  }));

  const res = await commandConfig(ctx(path, ['list']));
  const printed = res.lines.join('\n') + JSON.stringify(res.result);
  // Токен бота в выводе команды однажды окажется в чужом тикете вместе со
  // всей вставленной простынёй.
  for (const secret of ['s3cret', 'AAbbCCddEEff', 'xyz']) {
    assert.ok(!printed.includes(secret), `${secret} утёк:\n${printed}`);
  }
  // Но отличить «задан» от «не задан» должно быть можно.
  assert.match(printed, /10\.0\.0\.5/);
  assert.match(printed, /задано/);
  rmSync(d, { recursive: true, force: true });
});

test('list показывает источник каждого значения', async () => {
  const d = dir();
  const path = join(d, 'config.json');
  writeFileSync(path, JSON.stringify({ backupDir: '/mnt/backup' }));
  const res = await commandConfig(ctx(path, ['list']));
  const out = res.lines.join('\n');
  // Половина обращений «оно не видит мою настройку» закрывается тем, что
  // видно: значение пришло из env, а под sudo окружение другое.
  assert.match(out, /backup-dir\s+\/mnt\/backup\s+← конфиг/);
  assert.match(out, /min-free-gb\s+5\s+← умолчание/);
  rmSync(d, { recursive: true, force: true });
});

test('после записи прокси предлагается его проверить', async () => {
  const d = dir();
  const path = join(d, 'config.json');
  const res = await commandConfig(ctx(path, ['set', 'proxy', 'socks5h://10.0.0.5:1080']));
  assert.equal(res.code, EXIT.CURRENT);
  assert.match(res.lines.join('\n'), /proxy test/);
  rmSync(d, { recursive: true, force: true });
});

test('непонятный запрос — код возврата, а не молчание', async () => {
  const d = dir();
  const path = join(d, 'config.json');
  for (const args of [['set'], ['set', 'proxy'], ['get', 'nonsense'], ['dance']]) {
    const res = await commandConfig(ctx(path, args));
    assert.equal(res.code, EXIT.ERROR, `${args.join(' ')} должно падать`);
    assert.ok(res.errorCode, 'у отказа должен быть код');
  }
  // Ошибка проверки значения несёт свой код, а не общий.
  const bad = await commandConfig(ctx(path, ['set', 'lang', 'de']));
  assert.equal(bad.errorCode, 'setting-not-choice');
  rmSync(d, { recursive: true, force: true });
});

test('get --quiet печатает только значение', async () => {
  const d = dir();
  const path = join(d, 'config.json');
  writeFileSync(path, JSON.stringify({ minFreeGb: 12 }));
  const res = await commandConfig(ctx(path, ['get', 'min-free-gb'], { flags: { configPath: path, quiet: true } }));
  assert.deepEqual(res.lines, ['12']);
  rmSync(d, { recursive: true, force: true });
});

for (const locale of Object.keys(LOCALES)) {
  test(`каждая настройка и каждая ошибка переведены — ${locale}`, () => {
    const tr = createTranslator(locale);
    for (const name of SETTING_NAMES) {
      assert.ok(Object.hasOwn(SETTINGS[name], 'kind'), `${name} без типа`);
      assert.ok(settingKey(name).length > 0);
    }
    for (const code of ['setting-unknown', 'setting-not-boolean', 'setting-not-number', 'setting-not-choice',
      'setting-not-proxy', 'setting-missing-path', 'setting-not-file', 'setting-not-dir',
      'setting-unreadable', 'setting-empty']) {
      assert.ok(tr.has(`error.setting.${code}`), `${locale}: нет текста для ${code}`);
    }
  });
}
