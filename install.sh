#!/usr/bin/env bash
# NahuenTV installer for a fresh Ubuntu 22.04 / 24.04 server.
#
#   With your own web address (recommended, enables https + offline mode on the TVs):
#     sudo bash install.sh signage.yourstore.com
#
#   Without a web address (uses the server's IP, http only):
#     sudo bash install.sh
#
# Run it again any time to update the software. Your media and settings are kept.
set -euo pipefail

DOMAIN="${1:-}"
# Remember the web address so updates can just run "sudo bash install.sh".
if [ -z "$DOMAIN" ] && [ -f /etc/nahuentv-domain ]; then DOMAIN="$(cat /etc/nahuentv-domain)"; fi
APP_DIR=/opt/nahuentv
DATA_DIR=/var/lib/nahuentv
SRC="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "Please run with sudo:  sudo bash install.sh $DOMAIN"; exit 1; fi

# Small servers (1 GB RAM): add 1 GB of swap so installs/updates never run out of memory.
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
if [ "$MEM_MB" -lt 1900 ] && ! swapon --show | grep -q .; then
  echo "==> Adding 1 GB swap (small server)"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync debian-keyring debian-archive-keyring apt-transport-https

NODE_MAJOR=0
if command -v node >/dev/null; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy (web server with automatic https)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Installing the NahuenTV app"
id nahuentv >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin nahuentv
mkdir -p "$APP_DIR" "$DATA_DIR"
if [ "$SRC" != "$APP_DIR" ]; then
  rsync -a --delete --exclude node_modules --exclude data --exclude '*.zip' --exclude .git "$SRC/" "$APP_DIR/"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R nahuentv:nahuentv "$DATA_DIR"

cat > /etc/systemd/system/nahuentv.service <<EOF
[Unit]
Description=NahuenTV
After=network.target

[Service]
User=nahuentv
WorkingDirectory=$APP_DIR
Environment=PORT=3000
Environment=DATA_DIR=$DATA_DIR
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> Configuring the web server"
if [ -n "$DOMAIN" ]; then
  SITE="$DOMAIN"
  echo "$DOMAIN" > /etc/nahuentv-domain
else
  SITE=":80"
fi
cat > /etc/caddy/Caddyfile <<EOF
$SITE {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

systemctl daemon-reload
systemctl enable --now nahuentv
systemctl restart nahuentv
systemctl enable caddy
systemctl restart caddy

if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

sleep 2
if systemctl is-active --quiet nahuentv; then
  IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
  echo
  echo "============================================================"
  echo " NahuenTV is running!"
  if [ -n "$DOMAIN" ]; then
    echo " Open:  https://$DOMAIN"
    echo " (The first visit can take up to a minute while the https"
    echo "  certificate is created.)"
  else
    echo " Open:  http://$IP"
    echo " Tip: set up a web address later for https + offline mode."
  fi
  echo " The first time, you will be asked to create a password."
  echo "============================================================"
else
  echo "Something went wrong. Showing the app log:"
  journalctl -u nahuentv -n 40 --no-pager
  exit 1
fi
