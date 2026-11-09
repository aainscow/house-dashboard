"""The house in a browser tab, for the public demo site (GitHub Pages has no server).

Pyodide runs the dashboard server's own Hub, model and adapters here, every adapter in demo mode, and
pages/sim.js answers the dashboard's /api calls from it. On the Pi each adapter has a thread that runs it
every few seconds; here JavaScript calls tick() once a second instead, and nothing listens on a network.
"""
import json
import os
import sys
import time
import types

os.environ["HOUSE_DEMO"] = "1"   # simulators only, whatever else is around
import urllib.request            # noqa: E402,F401  imported before the ssl stand-in, so it knows there's no real ssl
sys.modules.setdefault("ssl", types.ModuleType("ssl"))  # Pyodide leaves ssl out; only the live adapters use it

import house  # noqa: E402

hub = house.Hub(house.load_config())
due = {name: 0.0 for name in hub.adapters}


def snapshot() -> str:
    return hub.snapshot_json()


def tick():
    """Run each adapter whose turn it is (or that a command has woken), as its thread does on the Pi.
    Returns the new state as JSON if anything ran, otherwise None."""
    now, ran = time.time(), False
    for name, a in hub.adapters.items():
        if now < due[name] and not a._wake.is_set():
            continue
        a._wake.clear()
        try:
            a.poll() if a.live else a.simulate()
            a.last_ok, a.last_error = time.time(), None
        except Exception as e:  # keep going, and show it on the dashboard as the server would
            a.last_error = str(e)
        due[name] = now + a.interval
        ran = True
    return snapshot() if ran else None


def command(kind: str, body: str) -> str:
    """POST /api/<kind>: {"status": 200|404|500, "body": {...}}."""
    try:
        return json.dumps({"status": 200, "body": hub.command(kind, json.loads(body or "{}"), notify=False)})
    except KeyError as e:
        return json.dumps({"status": 404, "body": {"error": f"unknown: {e}"}})
    except Exception as e:
        return json.dumps({"status": 500, "body": {"error": str(e)}})
