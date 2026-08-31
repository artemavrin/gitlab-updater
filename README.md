# gitlab-upgrade

Safe upgrades for self-managed **GitLab Omnibus** on Ubuntu and Debian — the routine patch just as much as the long climb out of 13.x.

Русская версия: [README.ru.md](README.ru.md)

> **Status: phases 0-3.6.** Detection, planning, readiness checks, backup, install, migration waiting, state, resume, notifications, detach, the terminal screens and proxy diagnostics all work, covered by 266 offline tests. `run` changes the server; everything else is read-only. Not yet rehearsed against a live GitLab — see [rehearsal/](rehearsal/README.md).

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

## Screens

<img src="docs/media/blockers.png" width="820" alt="Blockers: what stops the upgrade and the command that fixes each one">

Every finding names the command that fixes it — taken from a table checked against docs.gitlab.com, and picked by your installed version where the command depends on it. Where GitLab documents no command, you get the documentation link instead of an invented one.

<img src="docs/media/run.png" width="820" alt="The run feed: steps, phases and the Ctrl-C safety line">

`run` is a scrollable feed, not a fixed frame: on the fifth hour you can still scroll back to the first step. Only the bottom line is live. It turns yellow while `dpkg` is running, and the first Ctrl-C there explains the cost instead of killing the process.

<img src="docs/media/path.png" width="820" alt="The upgrade path screen, opened with [p]">

`[p]` opens the path: one line per step, columns aligned so steps are comparable, the selected step expanded.

<img src="docs/media/plan.png" width="820" alt="plan: detection, readiness checks and the computed route">

<img src="docs/media/patch.png" width="820" alt="The compact screen for a routine patch">

A routine patch gets its own screen — no step counter, no path, no history. Twelve minutes of work should not look like preparation for surgery.

> The `proxy test` shots below are live runs against a real proxy and the real `packages.gitlab.com`. The others are rendered by the real code from recorded fixtures — the repository listing is the actual `apt-cache madison` output, 398 versions; the upgrade feed replays a recorded event stream.

## Use

```bash
gitlab-upgrade check             # is there anything to upgrade? exit code says what kind
gitlab-upgrade plan              # full plan, changes nothing
gitlab-upgrade doctor            # readiness only, with the command that fixes each finding
gitlab-upgrade proxy test        # where the chain to the repository breaks
gitlab-upgrade --lang en plan
```

`check` is built for cron and monitoring:

| exit code | meaning |
|---|---|
| `0` | already on the latest available version |
| `10` | a patch is available in the current minor |
| `20` | a new minor is available |
| `30` | a new major is available |
| `1` | error — repository unreachable, version undetectable |

### Running the upgrade

`run` is the only command that changes the server, and it needs `--yes`.

```bash
sudo gitlab-upgrade run --yes                    # execute the plan
sudo gitlab-upgrade run --dry-run                # preview, changes nothing, no --yes needed
sudo gitlab-upgrade resume --yes                 # continue after a stop
```

Each step runs in a fixed order that is never reshuffled: backup, then install, then wait for services, then wait for background migrations before the next step. The phase is written to `/var/lib/gitlab-upgrade/state.json` *before* the action it names, so after a `kill -9` there is no guessing about what already happened.

`resume` reconciles the saved state against what is actually installed and refuses to continue when they diverge — between a crash and a resume, someone may have upgraded the server by hand, and the saved plan was computed from a different version. The install phase is the one window where either version is legitimately on disk, and reconciliation accepts both.

Backups follow the profile: `db` for a patch, the first one full and the rest fast for a long path. The dump itself goes wherever `gitlab_rails['backup_path']` points — the tool reads that rather than naming a directory the dump is not in — and the per-step config copies, including `gitlab-secrets.json` without which no dump can be restored, go to `--backup-dir` along with whatever `--backup-hook` receives.

### Walking away

`run --detach` puts the upgrade under `systemd-run` (or `setsid` where systemd is absent), so a dropped SSH session cannot end it. `attach` reconnects to the running one:

```bash
sudo gitlab-upgrade run --yes --detach
sudo gitlab-upgrade attach --follow
```

This works because the JSONL journal on disk *is* the event stream that drives the screen — attach replays it and then follows, and Ctrl-C stops watching without touching the upgrade.

Notifications go to Telegram, Slack or a plain webhook, configured through `/etc/gitlab-upgrade/config.json` or `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, `SLACK_WEBHOOK_URL`, `NOTIFY_WEBHOOK_URL`. Which events are sent follows the profile: a patch reports only failures, a long path reports every step. Every message carries the host name and the current version, because they are read on a phone with no context and possibly about several servers; the stop message names the backup directory and the command to continue with. A channel that fails to deliver never interrupts the upgrade — a lost message costs information, an aborted upgrade costs the evening.

### Readiness checks

`doctor` runs the checks and nothing else — safe to run at any time.

```
$ sudo gitlab-upgrade doctor

   ✓  root privileges       present
   ✓  GitLab services       12/12 running
   ✓  background migrations none outstanding
   ✓  gitlab-secrets.json   present
   ✓  disk space            142.1 GB free
   !  session               SSH without tmux: a dropped connection ends the watch
   ✓  PostgreSQL            15.6

   9 passed · 1 warnings · 0 critical
```

`plan` runs the same checks before showing the path, because a plan divorced from readiness is misleading. Critical findings change the exit code to 1 with `checks-failed` while still printing the plan — it is informative even when it cannot be executed right now.

Depth follows the profile: a patch pays for the fast set only, since four minutes of ceremony for twelve minutes of work is how a tool stops being used for routine updates.

Two rules that do not bend. A failed background migration is critical and `--force` does not clear it — the next step would migrate over unfinished data. And an unknown state is a warning, never an ok: if the migration query fails, the tool says so rather than reporting all clear.

### The next release, and why

`plan` shows the whole path; when scripting you usually want the one version to install right now.

```bash
$ gitlab-upgrade next

 17.1.8-ee.0
 conditional stop - taken to be safe · 4 more step(s) after it

   [Conditional stop](…gitlab_17_changes…#long-running-pipeline-messages-data-change). Not required by all instances.

   https://docs.gitlab.com/update/versions/gitlab_17_changes/
```

The justification comes from GitLab's own `upgrade_path.yml`, not from our judgement: `reason`, the `stop` it corresponds to, whether it is `conditional`, the upstream `note` verbatim, a link to the official notes for that major series, and `source` plus `verifiedAt` so the answer is auditable.

For scripts, `--quiet` prints only the version:

```bash
v=$(sudo gitlab-upgrade next --quiet) && [ -n "$v" ] && sudo apt-get install "gitlab-ee=$v"
```

Exit codes differ from `check` on purpose: `check` describes the whole gap to the target, `next` the size of the immediate step. From 16.3 the next step is 16.7 — a minor hop — even though the full path is a major upgrade.

## Behind a proxy

There is no direct route to `packages.gitlab.com` in many closed networks. Point the tool at an HTTP or SOCKS5 proxy and it configures **only that host** — your internal Ubuntu mirror keeps working directly.

<img src="docs/media/proxy-test.png" width="820" alt="proxy test: configuration, TCP, handshake, CONNECT, TLS, HTTP and apt">

`proxy test` walks the chain rung by rung and stops at the first break, so "no packages visible" stops being a guessing game. It needs no root — you run diagnostics before you have sudo, or they are useless.

<img src="docs/media/proxy-test-broken.png" width="820" alt="proxy test stopping at the first broken rung">

```bash
sudo gitlab-upgrade --proxy socks5h://user:pass@10.0.0.5:1080 check
```

Proxy settings go into a temporary `apt.conf` passed with `apt-get -c`, never into `/etc/apt/apt.conf.d/`: `kill -9` leaves no misconfigured system behind, and the password never appears in `ps aux`. TLS verification is never disabled; for an intercepting proxy use `--proxy-ca`. Package integrity rests on the repository's GPG signature regardless of TLS.

The required stops in `data/upgrade-path.json` are generated from GitLab's official `config/upgrade_path.yml`, never written by hand. `gitlab-upgrade refresh-path` compares them with upstream and shows a diff; a test fails if they drift, and `plan` warns when the data has not been verified for 180 days.

Conditional stops — currently 17.1 — are taken like required ones. Whether one applies to a given instance cannot be determined reliably, and an extra step costs about forty minutes against the integrity of the data.

## For agents

The CLI is discoverable without parsing human help. `gitlab-upgrade api` (or `--help --json`) emits a catalog of every command, flag, exit code, result field and error code:

```bash
gitlab-upgrade api | jq '.commands.check'
```

Each command declares `mutating` and `requiresRoot`, so an agent can tell what is safe to call before calling it. Today `check`, `plan`, `api` and `version` are all read-only.

**Contract.** `--json` puts exactly one document on stdout:

```json
{
  "tool": "gitlab-upgrade", "version": "0.1.0", "command": "check",
  "ok": true, "exit": 10,
  "result": { "current": "17.11.4-ee.0", "target": "17.11.6-ee.0",
              "updateKind": "patch", "profile": "patch", "steps": 1 },
  "findings": [], "error": null
}
```

On failure `ok` is `false` and `error` carries a stable `code` (`gitlab-not-found`, `repository-unreachable`, `os-unsupported`, …) alongside a translated `message`.

Three rules worth knowing:

- **Key off ids, not text.** Command names, flag names, `error.code`, `exits[].id` and `result` field names are stable and never translated. `summary`, `description` and `message` are for showing to a human.
- **The exit code is the primary answer.** `check` returns 0/10/20/30 for current/patch/minor/major and 1 for error — no output parsing needed to branch.
- **Streams do not mix.** `--json` writes the result to stdout; `--events` writes the JSONL event stream to stderr. `gitlab-upgrade plan --json --events 2>events.jsonl` gives you both, cleanly separated.

Per-command help is available in either language: `gitlab-upgrade help check`, `gitlab-upgrade --lang ru help plan`.

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
