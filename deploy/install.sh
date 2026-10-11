#!/usr/bin/env sh
# One-time setup on a fresh Linux server (Ubuntu/Debian). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/diabragab/tanks/main/deploy/install.sh | DOMAIN=tanks.example.com sh
set -eu
: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=tanks.example.com}"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if [ -d /opt/tanks/.git ]; then
  git -C /opt/tanks pull --ff-only
else
  command -v git >/dev/null 2>&1 || (apt-get update && apt-get install -y git)
  git clone https://github.com/diabragab/tanks /opt/tanks
fi
cd /opt/tanks/deploy
echo "DOMAIN=$DOMAIN" > .env
docker compose up -d --build
echo "WARCORE is starting at https://$DOMAIN (the HTTPS certificate can take a minute)."
