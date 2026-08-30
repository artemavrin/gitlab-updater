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
  // Shebang эсбилд поднимает из точки входа сам — второй сломал бы файл.
  banner: { js: `// gitlab-upgrade ${pkg.version} — https://github.com/artemavrin/gitlab-updater` },
});

const bytes = readFileSync(out);
const sha = createHash('sha256').update(bytes).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  gitlab-upgrade.mjs\n`);
process.stdout.write(`${out}  ${(bytes.length / 1024).toFixed(1)} КБ\nsha256 ${sha}\n`);
