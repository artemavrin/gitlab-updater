#!/bin/sh
# Подключение официального репозитория GitLab и вывод того, что apt на самом
# деле знает про gitlab-ee. Сверяем фикстуры с реальностью.
#
# Всё через https: прокси этого окружения принимает только CONNECT, плоский
# HTTP получает 405. На закрытом контуре у заказчика обычно наоборот, поэтому
# это особенность стенда, а не инструмента.
set -e
export DEBIAN_FRONTEND=noninteractive
: "${PROXY:?PROXY не задан}"

mkdir -p /usr/local/share/ca-certificates
cp /ca/ca-bundle.crt /usr/local/share/ca-certificates/agent-proxy.crt
sed -i -e 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g' \
       -e 's|http://security.ubuntu.com|https://security.ubuntu.com|g' \
       /etc/apt/sources.list
cat > /etc/apt/apt.conf.d/00proxy <<CONF
Acquire::https::Proxy "$PROXY";
Acquire::https::CAInfo "/ca/ca-bundle.crt";
CONF

apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg tzdata >/dev/null
update-ca-certificates >/dev/null 2>&1

curl -fsSL --proxy "$PROXY" --cacert /ca/ca-bundle.crt \
  https://packages.gitlab.com/gitlab/gitlab-ee/gpgkey | gpg --dearmor > /usr/share/keyrings/gitlab.gpg
. /etc/os-release
echo "deb [signed-by=/usr/share/keyrings/gitlab.gpg] https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu/ ${VERSION_CODENAME} main" \
  > /etc/apt/sources.list.d/gitlab_gitlab-ee.list

apt-get update -qq
apt-cache madison gitlab-ee > /out/madison.txt
apt-cache madison gitlab-ce >> /out/madison-ce.txt 2>/dev/null || true
echo "записано: $(wc -l < /out/madison.txt) строк"
