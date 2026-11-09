#!/usr/bin/env bash
# The ONE step that needs sudo. Run on the Pi:  bash ~/house/deploy/ha/install-docker.sh
# Installs Debian's own Docker packages and lets your user run containers.
# Note: membership of the "docker" group is root-equivalent on this Pi.
set -euo pipefail
sudo apt-get update
sudo apt-get install -y docker.io docker-compose
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker
echo "✓ Docker installed. Tell Claude it's done — it will start Home Assistant."
