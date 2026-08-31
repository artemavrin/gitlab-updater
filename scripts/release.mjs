import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Подготовка релиза одной командой: версия, коммит и тег вместе.
 *
 *   npm run release 0.1.4
 *
 * Дважды подряд релиз падал на одном и том же: версия поднималась коммитом
 * «release: X», после него шли ещё правки, и тег вставал на них — а
 * package.json оставался на X. Workflow это ловит, но уже после тега, и чинить
 * приходится удалением опубликованного тега.
 *
 * Здесь разойтись нечему: версия, коммит и тег делаются в одном действии, и
 * тег указывает ровно на тот коммит, который эту версию несёт. Push остаётся
 * человеку — публикация должна быть отдельным осознанным движением.
 */

const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) fail(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return (r.stdout ?? '').trim();
};

function fail(message) {
  process.stderr.write(`ошибка: ${message}\n`);
  process.exit(1);
}

const version = process.argv[2];
if (!version) fail('нужна версия: npm run release 0.1.4');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`версия должна быть вида 1.2.3, а не «${version}»`);

const tag = `v${version}`;

// Грязное дерево означает, что в релиз попадёт не то, что проверено.
if (git('status', '--porcelain')) fail('в рабочем дереве есть несохранённые изменения');

if (git('tag', '--list', tag)) fail(`тег ${tag} уже существует`);

// Заметки — половина релиза. Без них публикуется страница, по которой нельзя
// понять, что изменилось, а дописать их потом значит описать не тот релиз:
// ровно эта ошибка уже случалась дважды.
const notes = `.github/release-notes/${tag}.md`;
if (!existsSync(notes)) fail(`нет заметок ${notes} — напишите их до тега`);

const pkgPath = 'package.json';
const raw = readFileSync(pkgPath, 'utf8');
const current = JSON.parse(raw).version;
if (current === version) fail(`в package.json уже ${version}`);

// Правим строку, а не пересобираем JSON: так сохраняются отступы и порядок.
const next = raw.replace(/(^\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
if (next === raw) fail('не нашёл поле version в package.json');
writeFileSync(pkgPath, next);

// Проверки до тега, а не после: тег на непроверенном коммите придётся удалять.
for (const [name, args] of [['линт', ['run', 'lint']], ['тесты', ['test']], ['сборку', ['run', 'build']]]) {
  const r = spawnSync('npm', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    writeFileSync(pkgPath, raw);
    fail(`не прошло ${name}; версия возвращена на ${current}`);
  }
}

git('add', pkgPath);
git('commit', '-m', `release: ${version}`);
git('tag', '-a', tag, '-m', `gitlab-upgrade ${version}`);

process.stdout.write([
  '',
  `  ${current} → ${version}, тег ${tag} на этом же коммите`,
  '',
  '  опубликовать:',
  `    git push origin HEAD:main && git push origin ${tag}`,
  '',
].join('\n'));
