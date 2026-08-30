#!/bin/sh
# Omnibus ждёт, что его runit-супервизор уже работает: без него postinst
# пакета виснет на `gitlab-ctl reconfigure`.
if [ -x /opt/gitlab/embedded/bin/runsvdir-start ]; then
  /opt/gitlab/embedded/bin/runsvdir-start >/var/log/runsvdir.log 2>&1 &
fi
exec "$@"
