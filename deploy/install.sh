#!/usr/bin/env sh
# Installs or updates WARCORE on a Linux server (Ubuntu/Debian). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/diabragab/tanks/main/deploy/install.sh | DOMAIN=warcore.example.com sh
#
# Server with nothing else on ports 80/443: WARCORE runs behind its own Caddy with automatic HTTPS.
# Server that already hosts websites (nginx or Apache on 80/443): WARCORE listens on 127.0.0.1:8787 and this
# script adds a site for DOMAIN to your existing web server, plus a free certificate with certbot.
# Your other sites and games are left alone.
#
# Options (put them before `sh`):
#   DOMAIN=...          the game's domain (its DNS A record must point at this server)
#   WARCORE_PORT=8787   local port for the game when sharing the server (change it if 8787 is taken)
#   PROXY=caddy|nginx|apache|none   force a mode instead of detecting it
set -eu
DOMAIN="${DOMAIN:-}"
WARCORE_PORT="${WARCORE_PORT:-8787}"
PROXY="${PROXY:-}"

listening() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

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

# Pick the mode: our own Caddy if 80/443 are free (or already ours), otherwise share the existing web server.
if [ -z "$PROXY" ]; then
  if docker ps --format '{{.Image}} {{.Names}}' | grep -q '^caddy.*deploy'; then
    PROXY=caddy
  elif listening 80 || listening 443; then
    if systemctl is-active --quiet nginx 2>/dev/null; then PROXY=nginx
    elif systemctl is-active --quiet apache2 2>/dev/null; then PROXY=apache
    else PROXY=none
    fi
  else
    PROXY=caddy
  fi
fi

if [ "$PROXY" != caddy ] && listening "$WARCORE_PORT" && ! docker ps --format '{{.Names}}' | grep -q 'deploy-tanks'; then
  echo "Port $WARCORE_PORT is already used by another program. Run again with WARCORE_PORT=<free port>." >&2
  exit 1
fi

printf 'DOMAIN=%s\nWARCORE_PORT=%s\n' "$DOMAIN" "$WARCORE_PORT" > .env
if [ "$PROXY" = caddy ]; then
  docker compose --profile caddy up -d --build
  if [ -n "$DOMAIN" ]; then
    echo "WARCORE is starting at https://$DOMAIN (the HTTPS certificate can take a minute)."
  else
    echo "WARCORE is starting at http://$(hostname -I | cut -d' ' -f1) (plain HTTP until you add a domain)."
  fi
  exit 0
fi

docker compose up -d --build --remove-orphans
echo "WARCORE is running on 127.0.0.1:$WARCORE_PORT. Your existing sites keep ports 80/443."
if [ -z "$DOMAIN" ]; then
  echo "Run this again with DOMAIN=your.domain to add the game's website to your web server." >&2
  exit 0
fi

certify() {
  command -v certbot >/dev/null 2>&1 || (apt-get update && apt-get install -y certbot "python3-certbot-$1")
  certbot --"$1" -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    || echo "Couldn't get a certificate yet. Check the DNS A record for $DOMAIN, then run: certbot --$1 -d $DOMAIN" >&2
}

case "$PROXY" in
nginx)
  if [ -d /etc/nginx/sites-available ]; then
    conf=/etc/nginx/sites-available/warcore.conf
  else
    conf=/etc/nginx/conf.d/warcore.conf
  fi
  if [ ! -f "$conf" ]; then
    cat > "$conf" <<NGINX
# WARCORE (added by deploy/install.sh)
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$WARCORE_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
    }
}
NGINX
    [ -d /etc/nginx/sites-enabled ] && ln -sf "$conf" /etc/nginx/sites-enabled/warcore.conf
    nginx -t && systemctl reload nginx
    certify nginx
  else
    echo "$conf already exists, so it was left as is."
  fi
  ;;
apache)
  conf=/etc/apache2/sites-available/warcore.conf
  if [ ! -f "$conf" ]; then
    a2enmod proxy proxy_http proxy_wstunnel rewrite >/dev/null
    cat > "$conf" <<APACHE
# WARCORE (added by deploy/install.sh)
<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:$WARCORE_PORT/\$1 [P,L]
    ProxyPass / http://127.0.0.1:$WARCORE_PORT/
    ProxyPassReverse / http://127.0.0.1:$WARCORE_PORT/
    ProxyTimeout 3600
</VirtualHost>
APACHE
    a2ensite warcore >/dev/null
    apache2ctl configtest && systemctl reload apache2
    certify apache
  else
    echo "$conf already exists, so it was left as is."
  fi
  ;;
*)
  echo "Something else is using ports 80/443 (not nginx or Apache)."
  echo "Point $DOMAIN at http://127.0.0.1:$WARCORE_PORT in that program, with WebSocket support turned on."
  ;;
esac
echo "WARCORE should now be at https://$DOMAIN"
