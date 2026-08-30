import { parseVersion } from '../plan/version.js';

export const PACKAGES = ['gitlab-ee', 'gitlab-ce'];

/**
 * Версия и редакция GitLab.
 *
 * Порядок источников: dpkg (авторитетен и даёт точную apt-версию),
 * затем VERSION-файл omnibus. Редакция определяется именем пакета —
 * менять её на пути нельзя, это отдельная критическая проверка.
 */
export async function detectGitlab(exec, { versionFile = '/opt/gitlab/embedded/service/gitlab-rails/VERSION' } = {}) {
  for (const pkg of PACKAGES) {
    const r = await exec(['dpkg-query', '-W', '-f=${Version}', pkg], { readOnly: true, allowFailure: true });
    const raw = r.stdout.trim();
    if (r.code === 0 && raw) {
      const v = parseVersion(raw);
      if (v) return { version: v, aptVersion: raw, package: pkg, edition: pkg.endsWith('-ee') ? 'ee' : 'ce', source: 'dpkg' };
    }
  }
  const r = await exec(['cat', versionFile], { readOnly: true, allowFailure: true });
  if (r.code === 0 && r.stdout.trim()) {
    const v = parseVersion(r.stdout.trim());
    if (v) return { version: v, aptVersion: r.stdout.trim(), package: null, edition: v.edition, source: 'version-file' };
  }
  return null;
}
