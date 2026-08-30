/** Свободное место по точкам монтирования (df -B1 --output=...). */
export function parseDf(stdout) {
  const rows = String(stdout).trim().split('\n').slice(1);
  return rows.map((line) => {
    const [source, size, avail, target] = line.trim().split(/\s+/);
    return { source, size: Number(size), avail: Number(avail), target };
  }).filter((r) => Number.isFinite(r.avail));
}

export async function freeBytes(exec, paths) {
  const r = await exec(['df', '-B1', '--output=source,size,avail,target', ...paths], { readOnly: true, allowFailure: true });
  if (r.code !== 0) return [];
  return parseDf(r.stdout);
}

export const GB = 1024 ** 3;
export const toGb = (bytes) => Math.round((bytes / GB) * 10) / 10;
