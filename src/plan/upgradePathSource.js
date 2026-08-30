/**
 * Разбор официального config/upgrade_path.yml.
 *
 * Файл плоский — пары major/minor с необязательным комментарием, — поэтому
 * полноценный YAML-парсер здесь был бы лишней зависимостью на закрытом контуре.
 */
export const OFFICIAL_URL = 'https://gitlab.com/gitlab-org/gitlab/-/raw/master/config/upgrade_path.yml';

export function parseUpgradePathYml(text) {
  const stops = [];
  let major = null;
  let current = null;

  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const mMajor = /^-\s*major:\s*(\d+)\s*$/.exec(line);
    if (mMajor) { major = Number(mMajor[1]); current = null; continue; }

    const mMinor = /^\s+minor:\s*(\d+)\s*$/.exec(line);
    if (mMinor && major !== null) {
      current = { version: `${major}.${Number(mMinor[1])}` };
      stops.push(current);
      continue;
    }

    const mComment = /^\s+comments:\s*"?(.*?)"?\s*$/.exec(line);
    if (mComment && current) {
      const note = mComment[1].trim();
      if (note) {
        current.note = note;
        // «Conditional stop» означает «нужна не всем». Мы её всё равно проходим:
        // лишняя остановка стоит времени, пропущенная — целостности инстанса.
        if (/conditional stop/i.test(note)) current.conditional = true;
      }
    }
  }
  return stops;
}

/** Данные считаются протухшими через полгода — GitLab добавляет остановки регулярно. */
export const STALE_AFTER_DAYS = 180;

export function isStale(verifiedAt, now = new Date()) {
  const then = Date.parse(verifiedAt);
  if (Number.isNaN(then)) return true;
  return (now.getTime() - then) / 86_400_000 > STALE_AFTER_DAYS;
}

export const stopVersions = (stops) => stops.map((s) => (typeof s === 'string' ? s : s.version));
