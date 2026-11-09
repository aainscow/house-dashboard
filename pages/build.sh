#!/usr/bin/env bash
# Build the static demo site (for GitHub Pages, or any static host) into _site/ (or the folder given):
# the dashboard as it is, plus the server's own Python, which pages/sim.js runs in the browser with Pyodide.
#   pages/build.sh && python3 -m http.server -d _site 8000     → http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-_site}
rm -rf "$OUT"; mkdir -p "$OUT/sim"
rsync -a --exclude downloads --exclude hub.html --exclude .DS_Store web/ "$OUT/"
cp server/house.py server/model.py server/adapters.py server/optimiser.py server/scenes.py server/layout.json \
   pages/webhub.py pages/sim.js "$OUT/sim/"
python3 - "$OUT/index.html" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
tag = '<script src="house3d.js"></script>'
assert s.count(tag) == 1, "index.html: can't find where the scripts start"
s = s.replace(tag, '<script src="sim/sim.js"></script>\n  ' + tag)   # the simulator goes in first
open(p, "w").write(s)
PY
touch "$OUT/.nojekyll"   # serve the files as they are
echo "→ $OUT ($(du -sh "$OUT" | cut -f1))"
