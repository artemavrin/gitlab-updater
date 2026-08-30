# gitlab-upgrade

Safe upgrades for self-managed **GitLab Omnibus** on Ubuntu and Debian — the routine patch just as much as the long climb out of 13.x.

Русская версия: [README.ru.md](README.ru.md)

> **Status: phase 0.** Detection, planning, `check` and `plan` work and are tested. Backup, install and migration waiting are not implemented yet — the tool cannot change anything on your server today.

## Why

Most upgrade tooling assumes one scenario: a multi-hour migration with a chain of required stops. Applying that ceremony to a `17.11.4 → 17.11.6` patch means an 80-minute full backup and a `tmux` lecture for twelve minutes of work — so nobody uses it for routine updates, which are the vast majority.

Here the planner computes the path first and derives a **profile** from it. The profile scales backup mode, check depth, confirmation, screen and notifications. You always type the same thing.

| profile | example | steps | backup | predownload |
|---|---|---|---|---|
| `patch` | 17.11.4 → 17.11.6 | 1 | database and config | no |
| `minor` | 17.11 → 18.0 | 1–2 | database and config | no |
| `long` | 15.11 → 17.11 | 3+ | first full, then fast | yes |

## Install

One file. No `npm install`, no `node_modules` on the server — Node ≥ 20 is the only requirement.

```bash
curl -fsSLO https://github.com/artemavrin/gitlab-updater/releases/latest/download/gitlab-upgrade.mjs
curl -fsSLO https://github.com/artemavrin/gitlab-updater/releases/latest/download/gitlab-upgrade.mjs.sha256
sha256sum -c gitlab-upgrade.mjs.sha256
sudo install -m 0755 gitlab-upgrade.mjs /usr/local/bin/gitlab-upgrade
```

If the server has no outbound access, download on a machine that does and `scp` the file over.

## Use

```bash
sudo gitlab-upgrade check        # is there anything to upgrade? exit code says what kind
sudo gitlab-upgrade plan         # full plan, changes nothing
sudo gitlab-upgrade --lang en plan
```

`check` is built for cron and monitoring:

| exit code | meaning |
|---|---|
| `0` | already on the latest available version |
| `10` | a patch is available in the current minor |
| `20` | a new minor is available |
| `30` | a new major is available |
| `1` | error — repository unreachable, version undetectable |

## Behind a proxy

There is no direct route to `packages.gitlab.com` in many closed networks. Point the tool at an HTTP or SOCKS5 proxy and it configures **only that host** — your internal Ubuntu mirror keeps working directly.

```bash
sudo gitlab-upgrade --proxy socks5h://user:pass@10.0.0.5:1080 check
```

Proxy settings go into a temporary `apt.conf` passed with `apt-get -c`, never into `/etc/apt/apt.conf.d/`: `kill -9` leaves no misconfigured system behind, and the password never appears in `ps aux`. TLS verification is never disabled; for an intercepting proxy use `--proxy-ca`. Package integrity rests on the repository's GPG signature regardless of TLS.

## Language

Russian and English. Resolution order: `--lang` → `GITLAB_UPGRADE_LANG` → config → `LC_ALL`/`LC_MESSAGES`/`LANG` → English.

## Development

```bash
npm ci
npm run lint      # locale key parity, no UI text outside locales, no exec outside core
npm test          # 55 tests, no GitLab and no network required
npm run build     # dist/gitlab-upgrade.mjs
```

Tests run against recorded command output, and the network layer is exercised against a fake SOCKS5 server, so the whole suite is offline.

## Design documents

[PLAN.md](docs/PLAN.md) · [FLOWS.md](docs/FLOWS.md) · [UI.md](docs/UI.md) · [AUDIT.md](docs/AUDIT.md) · [prototype.html](docs/prototype.html)

## License

MIT
