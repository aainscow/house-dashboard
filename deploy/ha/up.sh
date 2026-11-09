#!/usr/bin/env bash
# Start (or update) Home Assistant from ~/ha. No sudo needed once you're in the docker group.
set -euo pipefail
mkdir -p ~/ha/config ~/ha/predbat
cp ~/house/deploy/ha/compose.yaml ~/ha/compose.yaml
[ -f ~/ha/config/configuration.yaml ] || cp ~/house/deploy/ha/configuration.yaml ~/ha/config/configuration.yaml
cd ~/ha
docker compose pull homeassistant
docker compose up -d homeassistant
echo "✓ Home Assistant starting on http://raspberrypi.local:8123 (first boot takes a few minutes)"
