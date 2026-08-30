import { readFileSync } from 'node:fs';

/** Разбор /etc/os-release. */
export function parseOsRelease(text) {
  const map = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i < 0 || line.startsWith('#')) continue;
    map[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, '');
  }
  if (!map.ID) return null;
  return {
    id: map.ID.toLowerCase(),
    versionId: map.VERSION_ID ?? null,
    pretty: map.PRETTY_NAME ?? `${map.ID} ${map.VERSION_ID ?? ''}`.trim(),
    supported: ['ubuntu', 'debian'].includes(map.ID.toLowerCase()),
  };
}

export function detectOs(path = '/etc/os-release') {
  try {
    return parseOsRelease(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
