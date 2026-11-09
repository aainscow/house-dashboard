#!/usr/bin/env bash
# Push the app to the Pi and (re)start it as a systemd *user* service (no sudo needed;
# linger is enabled for the user so it starts at boot).
set -euo pipefail
HOST=${HOST:-raspberrypi.local}
cd "$(dirname "$0")/.."
rsync -az --delete --exclude .git --exclude .claude --exclude config.json --exclude '__pycache__' ./ "$HOST:house/"
[ -f config.json ] && scp -q config.json "$HOST:house/config.json" && ssh "$HOST" chmod 600 house/config.json
# one-off runtime deps outside ~/house (rsync --delete would remove them): Pillow + Inter font
ssh "$HOST" 'D=~/.local/share/house; mkdir -p $D/fonts
  [ -x $D/venv/bin/python ] || python3 -m venv $D/venv
  $D/venv/bin/python -c "import PIL" 2>/dev/null || $D/venv/bin/pip install -q --disable-pip-version-check pillow
  [ -f $D/fonts/Inter-Regular.ttf ] || echo "WARNING: fonts missing in $D/fonts (see README)"'
ssh "$HOST" 'mkdir -p ~/.config/systemd/user && cp ~/house/deploy/house.service ~/house/deploy/house-demo.service ~/.config/systemd/user/ &&
  systemctl --user daemon-reload && systemctl --user enable --now house.service house-demo.service &&
  systemctl --user restart house.service house-demo.service && sleep 2 && systemctl --user --no-pager status house.service | head -5'
echo "→ real: http://raspberrypi.local:8080   demo: http://raspberrypi.local:8081"
