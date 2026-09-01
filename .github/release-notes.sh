#!/bin/bash
# Собирает тело релиза: сначала заметки к конкретной версии, если они есть,
# затем неизменная часть — что это и как поставить.
#
# Отдельным скриптом, а не строкой в workflow, чтобы результат можно было
# посмотреть до тега: релиз выпускается один раз, и опечатку в нём правят
# уже поверх опубликованной страницы.
set -euo pipefail

TAG="${TAG:?нужен TAG}"
REPO="${REPO:-artemavrin/gitlab-updater}"
here="$(cd "$(dirname "$0")" && pwd)"

specific="$here/release-notes/$TAG.md"
if [ -f "$specific" ]; then
  cat "$specific"
  printf '\n---\n\n'
fi

cat <<TXT
Safe upgrades for self-managed **GitLab Omnibus** on Ubuntu and Debian —
the routine patch just as much as the long climb out of 13.x.

## Install

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/$REPO/main/setup.sh | sudo sh
\`\`\`

The installer verifies the checksum before the file reaches your \`PATH\`,
honours \`HTTPS_PROXY\`, and installs to \`/usr/local/bin\` — or \`~/.local/bin\`
when you are not root. It takes \`--version\`, \`--dir\`, \`--proxy\`, \`--node\`,
\`--dry-run\` and \`--uninstall\`.

Machines often carry several Node installations, and \`sudo\` sees a different
\`PATH\` than you do. The installer looks past \`PATH\` — \`/usr/local\`, \`nvm\`,
the home directory of whoever called \`sudo\` — and pins the interpreter it
found, so the installed command runs under \`sudo\` too. Point it at a specific
one with \`--node /path/to/node\` if you would rather choose.

Or by hand — one file, no \`npm install\`, no \`node_modules\` on the server.
Node ≥ 20 is the only requirement.

\`\`\`bash
curl -fsSLO https://github.com/$REPO/releases/download/$TAG/gitlab-upgrade.mjs
curl -fsSLO https://github.com/$REPO/releases/download/$TAG/gitlab-upgrade.mjs.sha256
sha256sum -c gitlab-upgrade.mjs.sha256
sudo install -m 0755 gitlab-upgrade.mjs /usr/local/bin/gitlab-upgrade
sudo gitlab-upgrade check
\`\`\`

If the server has no outbound access, download on a machine that does and
\`scp\` the file over. The tool needs the proxy only for \`packages.gitlab.com\`.

## Start here

Nothing below \`run\` changes the server, so there is no cost to looking first.

\`\`\`bash
sudo gitlab-upgrade check     # is there anything to upgrade? the exit code says what kind
sudo gitlab-upgrade doctor    # readiness, with the command that fixes each finding
sudo gitlab-upgrade plan      # the whole route, computed from GitLab's own required stops
gitlab-upgrade proxy test     # where the chain breaks — this one needs no root
\`\`\`

The required stops come from GitLab's official \`config/upgrade_path.yml\`,
never written by hand — \`refresh-path\` diffs them against upstream and a test
fails if they drift.

## Read this before the first real run

**This is being driven against a live self-managed instance right now** — a
19-step climb out of 13.12 — and several of the readiness checks exist because
that climb broke on them: a package dpkg unpacked but never configured, an SMTP
setting that a later version refuses, a PostgreSQL barrier that could not be
cleared. Everything else still rests on recorded responses, official
documentation and offline tests.

Start with \`check\`, \`doctor\` and \`plan\`, then \`run --dry-run\`, and keep a
snapshot of the machine — the tool prints that reminder itself, because
migrations are irreversible and a backup is the only way back.

\`rehearsal/\` contains the stand for a dress rehearsal on a throwaway machine,
if you would rather see it work before pointing it at anything you care about.

---

[All commits in this release](https://github.com/$REPO/commits/$TAG)
TXT
