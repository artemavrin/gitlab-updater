#!/bin/sh
# Установка gitlab-upgrade одной строкой.
#
#   curl -fsSL https://raw.githubusercontent.com/artemavrin/gitlab-updater/main/setup.sh | sh
#
# Скрипт целиком завёрнут в функцию и вызывается последней строкой: если
# соединение оборвётся на середине, `sh` не выполнит половину установки —
# главная опасность способа «curl | sh», и единственная, которую можно
# закрыть со стороны скрипта.
#
# Всё остальное закрывается сверкой контрольной суммы: скачанный файл
# проверяется по опубликованному .sha256 до того, как попадёт в PATH.
# Несовпадение — отказ, а не предупреждение.

set -eu

gitlab_upgrade_setup() {
  REPO="artemavrin/gitlab-updater"
  BIN="gitlab-upgrade"
  ASSET="gitlab-upgrade.mjs"
  VERSION="latest"
  DIR=""
  PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
  BASE_URL=""
  DRY=0
  UNINSTALL=0
  MIN_NODE=20

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) VERSION="${2:?--version требует значение, например v0.1.0}"; shift 2 ;;
      --dir)     DIR="${2:?--dir требует путь}"; shift 2 ;;
      --proxy)   PROXY="${2:?--proxy требует URL}"; shift 2 ;;
      --base-url) BASE_URL="${2:?--base-url требует URL}"; shift 2 ;;
      --dry-run) DRY=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) err "неизвестный аргумент: $1"; usage; return 2 ;;
    esac
  done

  [ -z "$DIR" ] && DIR="$(default_dir)"

  [ "$UNINSTALL" = 1 ] && { uninstall; return $?; }

  need curl
  need node
  check_node

  url_base="$BASE_URL"
  if [ -z "$url_base" ]; then
    if [ "$VERSION" = latest ]; then
      url_base="https://github.com/$REPO/releases/latest/download"
    else
      url_base="https://github.com/$REPO/releases/download/$VERSION"
    fi
  fi

  tmp="$(mktemp -d)"
  # Каталог убирается в любом случае: половина скачанного пакета в /tmp
  # переживёт перезагрузку и однажды будет установлена руками.
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "загружаю $ASSET ($VERSION)"
  fetch "$url_base/$ASSET"        "$tmp/$ASSET"
  fetch "$url_base/$ASSET.sha256" "$tmp/$ASSET.sha256"

  say "сверяю контрольную сумму"
  verify "$tmp" "$ASSET" || return 1

  target="$DIR/$BIN"
  if [ "$DRY" = 1 ]; then
    say "проверка пройдена; установил бы в $target"
    "$tmp/$ASSET" --version 2>/dev/null || node "$tmp/$ASSET" --version
    return 0
  fi

  install_file "$tmp/$ASSET" "$target"
  say "установлено: $target"
  "$target" --version || true
  hint_path "$DIR"
}

usage() {
  cat <<'TXT'
Установка gitlab-upgrade.

  --version <тег>   конкретный релиз вместо последнего (например v0.1.0)
  --dir <путь>      куда ставить (по умолчанию /usr/local/bin, иначе ~/.local/bin)
  --proxy <url>     прокси для загрузки; по умолчанию берётся из HTTPS_PROXY
  --dry-run         скачать и проверить, но не устанавливать
  --uninstall       удалить установленное
  -h, --help        эта справка
TXT
}

say() { printf '  %s\n' "$*"; }
err() { printf 'ошибка: %s\n' "$*" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  err "нужен $1, но его нет в PATH"
  exit 1
}

# Node < 20 не запустит бандл, и падение будет невнятным: лучше сказать
# сразу и назвать версию, которая есть.
check_node() {
  have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$have" -lt "$MIN_NODE" ]; then
    err "нужен Node >= $MIN_NODE, а установлен $(node --version 2>/dev/null || echo 'неизвестно')"
    err "поставьте новый Node и повторите: https://nodejs.org/en/download"
    exit 1
  fi
}

# Без root ставим в домашний каталог, а не падаем: инструмент часто сначала
# пробуют, и только потом получают sudo.
default_dir() {
  if [ "$(id -u)" = 0 ] || [ -w /usr/local/bin ]; then
    printf '/usr/local/bin'
  else
    printf '%s/.local/bin' "$HOME"
  fi
}

fetch() {
  # --fail: без него curl молча сохранит HTML-страницу ошибки как «пакет».
  set -- --fail --silent --show-error --location --retry 3 --retry-delay 2 -o "$2" "$1"
  if [ -n "$PROXY" ]; then
    curl --proxy "$PROXY" "$@"
  else
    curl "$@"
  fi
}

verify() {
  dir="$1"; name="$2"
  want="$(awk '{print $1; exit}' "$dir/$name.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$dir/$name" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$dir/$name" | awk '{print $1}')"
  else
    err "нет ни sha256sum, ни shasum — проверить нечем, установка отменена"
    return 1
  fi
  if [ "$want" != "$got" ]; then
    err "контрольная сумма не совпала"
    err "  ожидалась $want"
    err "  получена  $got"
    err "файл не установлен"
    return 1
  fi
  return 0
}

install_file() {
  src="$1"; dst="$2"
  dir="$(dirname "$dst")"
  if [ -w "$dir" ] || { [ ! -d "$dir" ] && [ -w "$(dirname "$dir")" ]; }; then
    mkdir -p "$dir"
    install -m 0755 "$src" "$dst"
  elif command -v sudo >/dev/null 2>&1; then
    say "нужен sudo, чтобы писать в $dir"
    sudo mkdir -p "$dir"
    sudo install -m 0755 "$src" "$dst"
  else
    err "нет прав на запись в $dir и нет sudo; укажите --dir"
    exit 1
  fi
}

uninstall() {
  target="$DIR/$BIN"
  [ -e "$target" ] || { say "не установлено: $target"; return 0; }
  if [ -w "$(dirname "$target")" ]; then rm -f "$target"; else sudo rm -f "$target"; fi
  say "удалено: $target"
  # Конфиг, состояние и журналы не трогаем: их удаление — отдельное решение,
  # а журнал прерванного апгрейда бывает единственным следом того, что было.
  say "остались нетронутыми /etc/gitlab-upgrade, /var/lib/gitlab-upgrade и /var/log/gitlab-upgrade"
}

hint_path() {
  case ":$PATH:" in
    *":$1:"*) : ;;
    *) say "каталог $1 не в PATH — добавьте: export PATH=\"$1:\$PATH\"" ;;
  esac
}

gitlab_upgrade_setup "$@"
