#!/usr/bin/env bash
# HTTPS for the dashboards: a DuckDNS name pointing at the Pi's home address, and a Let's Encrypt certificate for
# it, fetched with a DNS check through DuckDNS (so nothing is opened to the internet) and renewed automatically.
#
#   1. On duckdns.org, add a domain for the house (e.g. demo-house).
#   2. Put it and your DuckDNS token in config.json:  "duckdns": {"domain": "demo-house", "token": "…"}
#   3. Run deploy/deploy.sh (copies config.json to the Pi), then this script.
#
# Afterwards: https://<domain>.duckdns.org:8443 (real) and :8444 (demo). Plain HTTP stays on 8080/8081 for the
# Nest Hub and the Hubitat. Re-running is safe: it re-points the name and only renews when due.
set -euo pipefail
HOST=${HOST:-raspberrypi.local}

ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
CFG=~/house/config.json
read -r DOMAIN TOKEN < <(python3 - "$CFG" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])).get("duckdns") or {}
d, t = (c.get("domain") or "").strip(), (c.get("token") or "").strip()
if not d or not t:
    sys.exit("config.json needs \"duckdns\": {\"domain\": \"…\", \"token\": \"…\"}")
print(d.removesuffix(".duckdns.org"), t)
PY
)
NAME="$DOMAIN.duckdns.org"
IP=$(hostname -I | awk '{print $1}')

# 1. point the name at the Pi's address on the home network (DuckDNS accepts private addresses)
R=$(curl -fsS "https://www.duckdns.org/update?domains=$DOMAIN&token=$TOKEN&ip=$IP")
[ "$R" = OK ] || { echo "DuckDNS refused the update (check the domain and token in config.json)"; exit 1; }
echo "✓ $NAME → $IP"

# 2. acme.sh: a certificate client that runs as this user and renews from this user's crontab
if [ ! -x ~/.acme.sh/acme.sh ]; then
  SRC=$(mktemp -d); git clone -q --depth 1 https://github.com/acmesh-official/acme.sh "$SRC"
  (cd "$SRC" && ./acme.sh --install --noprofile >/dev/null); rm -rf "$SRC"
  echo "✓ acme.sh installed"
fi
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt >/dev/null

# 3. the certificate, proved through a DuckDNS TXT record (exit code 2 means it's valid and not due yet)
set +e
DuckDNS_Token="$TOKEN" ~/.acme.sh/acme.sh --issue --dns dns_duckdns -d "$NAME" --dnssleep 90 >/tmp/acme-issue.log 2>&1
rc=$?
set -e
if [ $rc -ne 0 ] && [ $rc -ne 2 ]; then echo "certificate request failed:"; tail -20 /tmp/acme-issue.log; exit 1; fi
echo "✓ certificate for $NAME"

# 4. hand it to the dashboard, which restarts itself whenever it's renewed
D=~/.local/share/house/tls; mkdir -p "$D"; chmod 700 "$D"
~/.acme.sh/acme.sh --install-cert -d "$NAME" --key-file "$D/key.pem" --fullchain-file "$D/fullchain.pem" \
  --reloadcmd 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart house.service house-demo.service' >/dev/null
chmod 600 "$D/key.pem"
echo "✓ installed; dashboards restarted"
echo "→ https://$NAME:8443   demo: https://$NAME:8444"
REMOTE
