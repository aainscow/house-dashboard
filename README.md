# 32 Demo Drive — house automation

**[Live demo](https://aainscow.github.io/house-dashboard/)**: the dashboard with every device simulated, running in your browser (Pyodide runs the server's own Python in the page). The address, names and location here are made up.

A dashboard for the whole house, laid out from the architect's plans: ground floor, first floor and the new loft conversion. It covers:

- **Lights**: every room and both flights of stairs, through the Hubitat C-8
- **Heating**: Drayton Wiser zones and hot water
- **Energy**: Fox ESS solar, battery and grid flow, plus today's history
- **Loft climate**: Panasonic RAC Solo 2.5 kW
- **Blinds**: Velux solar blinds on the dormer and rooflights
- **Scenes**: Morning, Movie, Bedtime, Leaving, Heat loft, Block sun

Live at **http://raspberrypi.local:8080**, served by a Raspberry Pi.

## How it works

```
web/            static UI (vanilla JS + SVG; no build step)
server/
  house.py      stdlib HTTP server: /api/state, /api/events (SSE), POST commands
  adapters.py   one adapter per system; "live" when configured, "demo" otherwise
  model.py      in-memory house model
  layout.json   rooms traced from the plans, mapped to existing Hubitat devices
deploy/         systemd user unit + deploy.sh
docs/OPTIMISATION.md  the cost optimiser: aircon vs gas, immersion vs gas
pages/          the demo site: the server's Python run in the browser
```

Every integration without credentials runs a **simulator** (realistic solar curve for southern England, battery logic, room temperatures), so the UI is fully usable before the hardware arrives. The status badges show `demo` or `live` for each system.

## Running

```bash
python3 server/house.py            # http://localhost:8080 (PORT=… to change)
```

```bash
./deploy/deploy.sh                 # rsync to the Pi + restart the user service
```

## Going live, one system at a time

Copy `config.example.json` to `config.json`. It is git-ignored and deployed with mode 600. Fill in sections as each system arrives:

| Section | Needs |
|---|---|
| `hubitat` | Maker API app ID and access token (Apps ▸ Add built-in app ▸ Maker API) |
| `wiser` | Hub IP and secret (setup mode → `http://192.168.8.1/secret`) |
| `fox` | Open API key (foxesscloud.com ▸ Profile ▸ API management) and inverter serial |
| `aircon` | Local bridge host for the RAC Solo (see FINDINGS §4) |
| `blinds` | Hubitat device ID for each blind |

Room-to-device mappings live in `server/layout.json`. Entries marked `"assumed": true` (the Bedroom 4 LED strip on Hubitat 80, ensuite second channel) are guesses to confirm.

## Nest Hub (sitting room) and voice

- **Screen:** the Pi renders `/hub.png` (clock, price now/next, live power, lights, hot water, loft, solar, room temps, today's prices) and casts it to the Hub's built-in media player every minute — silently. It only takes over when the Hub is idle (photo frame) or already showing it; tap 📺 on the dashboard's scene bar to switch it on/off. (A live web page isn't possible: the Hub's web receiver won't load plain-HTTP pages.) Renderer needs Pillow + Inter font in `~/.local/share/house/` on the Pi — `deploy.sh` installs Pillow.
- **Voice:** six Hubitat virtual switches (devices 95–100) — *Movie scene, Good morning scene, Bedtime scene, Leaving scene, Heat loft scene, Block sun scene* — are shared with Google Home. "Hey Google, turn on Movie scene" flips the switch; the dashboard runs the scene (`server/scenes.py`) and flips it back off. If Google doesn't see them yet, say "Hey Google, sync my devices".
- **Speech:** `server/cast.py` can speak (`say`), but nothing calls it — announcements are off by request.
