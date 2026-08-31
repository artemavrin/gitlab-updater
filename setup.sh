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
  NODE=""
  DRY=0
  UNINSTALL=0
  MIN_NODE=20

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) VERSION="${2:?--version требует значение, например v0.1.0}"; shift 2 ;;
      --dir)     DIR="${2:?--dir требует путь}"; shift 2 ;;
      --proxy)   PROXY="${2:?--proxy требует URL}"; shift 2 ;;
      --base-url) BASE_URL="${2:?--base-url требует URL}"; shift 2 ;;
      --node)    NODE="${2:?--node требует путь к интерпретатору}"; shift 2 ;;
      --dry-run) DRY=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) err "неизвестный аргумент: $1"; usage; return 2 ;;
    esac
  done

  [ -z "$DIR" ] && DIR="$(default_dir)"

  [ "$UNINSTALL" = 1 ] && { uninstall; return $?; }

  need curl
  choose_node

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
    "$NODE" "$tmp/$ASSET" --version
    return 0
  fi

  if [ "$PIN" = 1 ]; then
    # Шебанг в бандле — `#!/usr/bin/env node`, и он разрешается при каждом
    # запуске. Если под sudo PATH приводит к старому Node, установленный файл
    # не запустится, где бы он ни лежал. Поэтому рядом кладём бандл как есть,
    # а в PATH — обёртку с абсолютным путём к рабочему интерпретатору.
    install_file "$tmp/$ASSET" "$DIR/$ASSET"
    wrapper="$tmp/wrapper"
    cat > "$wrapper" <<EOF
#!/bin/sh
# Создано установщиком gitlab-upgrade.
# \`env node\` в этой системе находит Node ниже $MIN_NODE (под sudo свой PATH),
# поэтому интерпретатор зафиксирован. Переустановка обновит и эту строку.
exec "$NODE" "$DIR/$ASSET" "\$@"
EOF
    install_file "$wrapper" "$target"
    say "установлено: $target"
    say "интерпретатор зафиксирован: $NODE ($("$NODE" --version))"
  else
    install_file "$tmp/$ASSET" "$target"
    say "установлено: $target"
  fi

  "$target" --version || true
  hint_path "$DIR"
}

usage() {
  cat <<'TXT'
Установка gitlab-upgrade.

  --version <тег>   конкретный релиз вместо последнего (например v0.1.0)
  --dir <путь>      куда ставить (по умолчанию /usr/local/bin, иначе ~/.local/bin)
  --proxy <url>     прокси для загрузки; по умолчанию берётся из HTTPS_PROXY
  --node <путь>     каким Node запускать (по умолчанию ищется сам)
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

# Мажорная версия по абсолютному пути; 0, если это не рабочий Node.
node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# Домашний каталог того, кто вызвал sudo: свежий Node чаще всего стоит у него,
# а не у root.
sudo_user_home() {
  [ -n "${SUDO_USER:-}" ] || return 0
  getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6
}

# Где вообще может лежать Node. Под sudo PATH другой, чем у пользователя, и
# типичная машина несёт сразу несколько установок: apt-овую древнюю, ручную в
# /usr/local и свежую в nvm. Перебираем все и берём самую новую.
node_candidates() {
  command -v node 2>/dev/null || true
  printf '%s\n' /usr/local/bin/node /usr/bin/node /opt/node/bin/node
  for home in "${HOME:-}" "$(sudo_user_home)"; do
    [ -n "$home" ] || continue
    for n in "$home"/.nvm/versions/node/*/bin/node "$home"/n/bin/node "$home"/.local/bin/node; do
      [ -x "$n" ] && printf '%s\n' "$n"
    done
  done
  # Явный ноль: иначе статусом функции станет последняя проверка `[ -x ]`,
  # а её кандидата обычно нет — и `set -e` снял бы установку без сообщения.
  return 0
}

# Выбор интерпретатора и решение, нужна ли обёртка.
#
# PIN=1 означает: `env node` приводит к слишком старому Node, но рабочий на
# машине есть. Тогда в PATH уходит обёртка с абсолютным путём — иначе файл
# установится и не запустится, что хуже честного отказа.
choose_node() {
  PIN=0
  if [ -n "$NODE" ]; then
    [ -x "$NODE" ] || { err "не найден интерпретатор: $NODE"; exit 1; }
    [ "$(node_major "$NODE")" -ge "$MIN_NODE" ] || {
      err "$NODE — это $("$NODE" --version 2>/dev/null), а нужен Node >= $MIN_NODE"; exit 1; }
    PIN=1
    return 0
  fi

  env_node="$(command -v node 2>/dev/null || true)"
  env_major=0
  [ -n "$env_node" ] && env_major="$(node_major "$env_node")"
  if [ "$env_major" -ge "$MIN_NODE" ]; then
    NODE="$env_node"
    return 0
  fi

  best=""; best_major=0
  list="$(mktemp)"
  node_candidates > "$list" 2>/dev/null
  while IFS= read -r c; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    m="$(node_major "$c")"
    case "$m" in ''|*[!0-9]*) continue ;; esac
    if [ "$m" -gt "$best_major" ]; then best_major="$m"; best="$c"; fi
  done < "$list"
  rm -f "$list"

  if [ "$best_major" -ge "$MIN_NODE" ]; then
    NODE="$best"; PIN=1
    say "в PATH ${env_node:-нет Node}${env_node:+ — $("$env_node" --version 2>/dev/null)}; беру $best"
    return 0
  fi

  err "нужен Node >= $MIN_NODE, а самый новый из найденных — $(
        [ -n "$best" ] && "$best" --version 2>/dev/null || echo 'ни одного')"
  [ -n "$env_node" ] && err "в PATH: $env_node ($("$env_node" --version 2>/dev/null))"
  err "поставьте Node и повторите; можно без apt:"
  err "  curl -fsSLO https://nodejs.org/dist/v20.19.5/node-v20.19.5-linux-x64.tar.xz"
  err "  sudo tar -xJf node-v20.19.5-linux-x64.tar.xz -C /usr/local --strip-components=1"
  err "или укажите готовый: setup.sh --node /путь/к/node"
  exit 1
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
  # Рядом может лежать бандл, если ставили с обёрткой.
  for f in "$target" "$DIR/$ASSET"; do
    [ -e "$f" ] || continue
    if [ -w "$DIR" ]; then rm -f "$f"; else sudo rm -f "$f"; fi
    say "удалено: $f"
  done
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
