# ExpressVPN CLI container — arm64 (Jetson Orin Nano)
#
# Runs `expressvpnd` as PID 1 (via tini) so a single container provides
# a `tun0` interface that other containers share via
# `--network=container:expressvpn`. This keeps the host's default route
# untouched so Tailscale and SSH keep working normally.
#
# The ExpressVPN .deb is behind auth on their site and cannot be fetched
# without an account, so you must drop it next to this Dockerfile before
# building. See docker/expressvpn/README.md for the download URL.

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Packages used by expressvpnd and the entrypoint wrapper
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      expect \
      iproute2 \
      iptables \
      iputils-ping \
      net-tools \
      procps \
      tini \
 && rm -rf /var/lib/apt/lists/*

# The .deb has to be copied in because ExpressVPN gates downloads behind
# their dashboard. Put expressvpn_*_arm64.deb next to this Dockerfile
# (renamed to expressvpn.deb) before `docker build`.
COPY expressvpn.deb /tmp/expressvpn.deb
RUN apt-get update \
 && apt-get install -y --no-install-recommends /tmp/expressvpn.deb \
 && rm /tmp/expressvpn.deb \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Activation and daemon state live here — mount a volume at these paths
# if you want activation to survive container rebuilds.
VOLUME ["/etc/expressvpn", "/var/lib/expressvpn"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD expressvpn status 2>/dev/null | grep -qi 'Connected' || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
