# Стенд для репетиции: Ubuntu без systemd, GitLab Omnibus ставится из apt —
# то же, что на сервере заказчика. Официальный образ gitlab/gitlab-ee не
# годится: там апгрейд делается сменой образа, а не apt, и инструмент такой
# инстанс справедливо отвергает.
FROM ubuntu:22.04

ARG PROXY
ARG NODE_VERSION=20.18.1
ENV DEBIAN_FRONTEND=noninteractive LC_ALL=C

# Всё через https: прокси стенда принимает только CONNECT.
COPY ca-bundle.crt /ca/ca-bundle.crt
RUN mkdir -p /usr/local/share/ca-certificates \
 && cp /ca/ca-bundle.crt /usr/local/share/ca-certificates/agent-proxy.crt \
 && sed -i -e 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g' \
           -e 's|http://security.ubuntu.com|https://security.ubuntu.com|g' /etc/apt/sources.list \
 && printf 'Acquire::https::Proxy "%s";\nAcquire::https::CAInfo "/ca/ca-bundle.crt";\n' "$PROXY" \
      > /etc/apt/apt.conf.d/00proxy \
 && apt-get update -qq \
 && apt-get install -y -qq curl ca-certificates gnupg tzdata openssh-server perl xz-utils \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Node на изолированной машине ставится так же: один архив, без npm-реестра.
RUN curl -fsSL --proxy "$PROXY" --cacert /ca/ca-bundle.crt \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /opt \
 && ln -s "/opt/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/local/bin/node

RUN curl -fsSL --proxy "$PROXY" --cacert /ca/ca-bundle.crt \
      https://packages.gitlab.com/gitlab/gitlab-ee/gpgkey | gpg --dearmor > /usr/share/keyrings/gitlab.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/gitlab.gpg] https://packages.gitlab.com/gitlab/gitlab-ee/ubuntu/ jammy main" \
      > /etc/apt/sources.list.d/gitlab_gitlab-ee.list \
 && apt-get update -qq

# Omnibus супервизирует себя runit'ом; systemd в контейнере не нужен, нужен
# только запущенный runsvdir — его поднимает entrypoint.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]
