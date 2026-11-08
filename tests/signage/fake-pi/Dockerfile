# A stand-in for a freshly imaged Raspberry Pi OS Lite (trixie): Debian trixie with sshd, a first user with a password and
# sudo, and the packages the agent wants already installed (so `apply` does not spend minutes in apt). The marker file
# /etc/church-signage-simulated makes the agent skip the hardware steps (model check, raspi-config, systemd units) and say so.
# The host keys are removed here and made when a container starts: like a real Pi's first boot, each fake Pi has its own
# (shared keys make the dashboard take a second Pi for the first one at a new address). Never used outside tests/signage/.
FROM debian:trixie-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server sudo python3 nftables iw v4l-utils mpv tini sshpass ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && rm -f /etc/ssh/ssh_host_* \
 && touch /etc/church-signage-simulated
COPY entrypoint.sh /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
