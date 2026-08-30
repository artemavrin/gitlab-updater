import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

/**
 * Node не умеет .jsx. На сервер уезжает бандл, где JSX уже развёрнут, но
 * тесты и запуск из исходников должны работать без сборки — иначе экраны
 * проверялись бы только после `npm run build`, то есть почти никогда.
 * Хуки живут в devDependencies и в бандл не попадают.
 */
export async function load(url, context, next) {
  if (!url.endsWith('.jsx')) return next(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  const { code } = await transform(source, {
    loader: 'jsx', jsx: 'automatic', format: 'esm', sourcefile: fileURLToPath(url),
  });
  return { format: 'module', shortCircuit: true, source: code };
}
