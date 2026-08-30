import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { LOCALES } from '../src/i18n/index.js';

/**
 * Свой линтер вместо eslint: проверяет ровно те инварианты, которые
 * у этого проекта легко сломать, и не тянет зависимостей.
 */
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stringLiterals = (src) => [...src.matchAll(/'([^'\\\n]|\\.)*'|"([^"\\\n]|\\.)*"|`([^`\\]|\\.)*`/g)].map((m) => m[0]);

const errors = [];
const warnings = [];

// 1. Паритет ключей локалей
{
  const [a, b] = Object.keys(LOCALES);
  const ka = new Set(Object.keys(LOCALES[a]));
  const kb = new Set(Object.keys(LOCALES[b]));
  for (const k of ka) if (!kb.has(k)) errors.push(`i18n: ключ «${k}» есть в ${a}, но нет в ${b}`);
  for (const k of kb) if (!ka.has(k)) errors.push(`i18n: ключ «${k}» есть в ${b}, но нет в ${a}`);
}

// 2. Пользовательский текст живёт только в локалях.
//    Строго — там, где формируется вывод; предупреждением — в тексте исключений.
const STRICT = ['src/commands', 'src/render', 'src/plan', 'src/detect', 'src/ui'];
const LOOSE = ['src/core', 'src/net', 'src/cli'];
const CYRILLIC = /[Ѐ-ӿ]/;

// .jsx проверяется наравне с .js: экраны — самое место для забытой строки.
const SOURCES = (f) => ['.js', '.jsx'].includes(extname(f));

for (const file of walk('src').filter(SOURCES)) {
  if (file.startsWith('src/i18n')) continue;
  const bad = stringLiterals(stripComments(readFileSync(file, 'utf8'))).filter((s) => CYRILLIC.test(s));
  if (!bad.length) continue;
  const where = STRICT.some((d) => file.startsWith(d)) ? errors : LOOSE.some((d) => file.startsWith(d)) ? warnings : errors;
  for (const s of bad) where.push(`${file}: текст в коде вместо локали — ${s.slice(0, 60)}`);
}

// 3. Ни один внешний вызов не должен идти мимо src/core/exec.js
for (const file of walk('src').filter(SOURCES)) {
  if (file === 'src/core/exec.js') continue;
  const src = stripComments(readFileSync(file, 'utf8'));
  if (/\b(execSync|spawnSync|child_process)\b/.test(src)) {
    errors.push(`${file}: запуск команд мимо src/core/exec.js`);
  }
}

for (const w of warnings) process.stdout.write(`warn  ${w}\n`);
for (const e of errors) process.stdout.write(`error ${e}\n`);
process.stdout.write(`\nлинт: ошибок ${errors.length}, предупреждений ${warnings.length}\n`);
process.exitCode = errors.length ? 1 : 0;
