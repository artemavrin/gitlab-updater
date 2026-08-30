import { writeFileSync } from 'node:fs';
import { request } from '../core/http.js';
import { parseProxy } from '../core/http.js';
import { parseUpgradePathYml, OFFICIAL_URL, stopVersions } from '../plan/upgradePathSource.js';

/**
 * Сверка обязательных остановок с официальным config/upgrade_path.yml.
 *
 * Зашитый список протухает: GitLab добавляет остановки регулярно, и ошибка
 * здесь не проявляется до боевого апгрейда. Поэтому данные лежат отдельным
 * файлом с датой проверки, а эта команда их сверяет и обновляет.
 */
export async function commandRefreshPath({ t, flags, config, data, dataPath, fetcher = request }) {
  let text;
  try {
    const res = await fetcher(OFFICIAL_URL, { proxy: parseProxy(config.proxy), ca: config.proxyCa ?? null });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    text = res.body;
  } catch (err) {
    return { code: 1, errorCode: 'upgrade-path-unreachable', lines: [t('refresh.failed', { reason: err.message })] };
  }

  const official = parseUpgradePathYml(text);
  if (!official.length) {
    return { code: 1, errorCode: 'upgrade-path-unreachable', lines: [t('refresh.failed', { reason: 'empty' })] };
  }

  const ours = stopVersions(data.upgradePath.stops);
  const theirs = stopVersions(official);
  const added = theirs.filter((v) => !ours.includes(v));
  const removed = ours.filter((v) => !theirs.includes(v));
  const changed = added.length + removed.length;

  const lines = [''];
  const result = { stops: theirs.length, added, removed, applied: false };

  if (!changed) {
    lines.push(` ${t('refresh.same', { n: theirs.length })}`, '');
    return { code: 0, lines, result };
  }

  lines.push(` ${t('refresh.diff', { n: changed })}`, '');
  if (added.length) lines.push(`   + ${t('refresh.added')}: ${added.join(', ')}`);
  if (removed.length) lines.push(`   − ${t('refresh.removed')}: ${removed.join(', ')}`);
  lines.push('');

  if (!flags.yes) {
    lines.push(` ${t('refresh.dryRun')}`, '');
    return { code: 0, lines, result };
  }

  const verifiedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(dataPath, JSON.stringify({ ...data.upgradePath, verified_at: verifiedAt, stops: official }, null, 2) + '\n');
  result.applied = true;
  lines.push(` ${t('refresh.written', { path: dataPath, date: verifiedAt })}`, '');
  return { code: 0, lines, result };
}
