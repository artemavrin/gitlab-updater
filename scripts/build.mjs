import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'dist/gitlab-upgrade.mjs';

mkdirSync('dist', { recursive: true });

/**
 * На сервер уезжает один файл. Никакого npm install через прокси,
 * никаких node_modules на проде — только Node >= 20.
 */
await build({
  entryPoints: ['bin/gitlab-upgrade.js'],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: false,          // читаемость важнее байт: этот файл будут открывать на сервере
  legalComments: 'none',
  jsx: 'automatic',       // экраны — .jsx; react/jsx-runtime уезжает в бандл
  // Ink грузит девтулзы динамически и только при DEV=true. Без подмены esbuild
  // тянет react-devtools-core в бандл целиком — 700 КБ ради ветки, которой на
  // сервере не бывает.
  alias: { 'react-devtools-core': './scripts/stubs/react-devtools-core.js' },
  // Shebang эсбилд поднимает из точки входа сам — второй сломал бы файл.
  // createRequire нужен транзитивным CJS-зависимостям Ink: внутри ESM-бандла
  // их require() иначе падает на первом же обращении к node:assert.
  banner: {
    js: [
      `// gitlab-upgrade ${pkg.version} — https://github.com/artemavrin/gitlab-updater`,
      `import { createRequire as __createRequire } from 'node:module';`,
      `const require = __createRequire(import.meta.url);`,
    ].join('\n'),
  },
});

const bytes = readFileSync(out);
const sha = createHash('sha256').update(bytes).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  gitlab-upgrade.mjs\n`);
process.stdout.write(`${out}  ${(bytes.length / 1024).toFixed(1)} КБ\nsha256 ${sha}\n`);
