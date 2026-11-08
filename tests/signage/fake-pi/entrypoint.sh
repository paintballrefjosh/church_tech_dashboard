#!/bin/sh
# FAKE_PI_USER / FAKE_PI_PASSWORD: the Imager's first user. FAKE_PI_SUDO=nopasswd (stock Pi OS), password (the user's own)
# or rootpw (sudo asks for root's password, FAKE_PI_ROOT_PASSWORD: a sudo password that is not the login's).
set -eu
user="${FAKE_PI_USER:-pi}"
if ! id "$user" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G sudo "$user"
  printf '%s:%s\n' "$user" "${FAKE_PI_PASSWORD:-raspberry}" | chpasswd
  if [ "${FAKE_PI_SUDO:-nopasswd}" = nopasswd ]; then
    printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$user" > /etc/sudoers.d/010_pi-nopasswd
    chmod 440 /etc/sudoers.d/010_pi-nopasswd
  elif [ "${FAKE_PI_SUDO}" = rootpw ]; then
    printf 'root:%s\n' "${FAKE_PI_ROOT_PASSWORD:?}" | chpasswd
    printf 'Defaults:%s rootpw\n' "$user" > /etc/sudoers.d/010_pi-rootpw
    chmod 440 /etc/sudoers.d/010_pi-rootpw
  fi
fi
ssh-keygen -A >/dev/null
# Stock Pi OS: password logins allowed, PAM on.
exec /usr/sbin/sshd -D -e
