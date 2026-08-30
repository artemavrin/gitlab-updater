#!/bin/sh
# Репетиция: поставить исходную версию и обновиться настоящим инструментом.
# Всё, что инструмент напечатал, остаётся в out/.
set -e
FROM="${1:?укажите исходную версию, например 17.11.4-ee.0}"
TO="${2:?укажите целевую версию, например 17.11.7-ee.0}"
NAME="${NAME:-gitlab-rehearsal}"
OUT="$(cd "$(dirname "$0")" && pwd)/out"
BUNDLE="$(cd "$(dirname "$0")/.." && pwd)/dist/gitlab-upgrade.mjs"

test -f "$BUNDLE" || { echo "нет $BUNDLE — соберите: npm run build"; exit 1; }
mkdir -p "$OUT"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --shm-size 256m gitlab-rehearsal:base sleep infinity >/dev/null
docker cp "$BUNDLE" "$NAME:/usr/local/bin/gitlab-upgrade.mjs"

echo "==> ставлю $FROM (это долго)"
docker exec "$NAME" sh -lc "export DEBIAN_FRONTEND=noninteractive EXTERNAL_URL=http://localhost; \
  apt-get install -y -o Dpkg::Options::=--force-confold gitlab-ee=$FROM" 2>&1 | tail -5

echo "==> жду готовности инстанса"
docker exec "$NAME" sh -lc 'for i in $(seq 1 60); do gitlab-ctl status >/dev/null 2>&1 && exit 0; sleep 10; done; exit 1'

run() {
  echo "==> gitlab-upgrade $*"
  docker exec -e GITLAB_UPGRADE_ALLOW_CONTAINER=1 "$NAME" \
    node /usr/local/bin/gitlab-upgrade.mjs "$@" 2>&1 | tee "$OUT/$(echo "$1" | tr -d -- '-').log" || true
}

run check --lang ru
run plan --to "$TO" --lang ru
run doctor --lang ru
# --force: «это контейнер» — законное предупреждение стенда, и снимать
# его надо явно, а не молчанием.
run run --yes --force --to "$TO" --lang ru
run check --lang ru

echo "==> журналы прогона"
docker exec "$NAME" sh -lc 'ls -la /var/log/gitlab-upgrade/ 2>/dev/null || echo "журналов нет"'
echo "вывод сложен в $OUT"
