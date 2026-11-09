"""Scenes run on the server, so the dashboard, voice (via Hubitat → Google
Home virtual switches) and automations all trigger exactly the same thing."""
from __future__ import annotations

SCENES = {
    "morning": {"name": "Good morning", "icon": "☀︎", "actions": [
        ("light", {"id": "kitchen-main", "on": True, "level": 80}),
        ("light", {"id": "hall-main", "on": True, "level": 80}),
        ("light", {"id": "landing-main", "on": True, "level": 80}),
        ("blinds", {"id": "all", "position": 0}),
    ]},
    "movie": {"name": "Movie", "icon": "🎬", "actions": [
        ("light", {"id": "lounge-main", "level": 15}),
        ("light", {"id": "lounge-dining", "on": False}),
        ("light", {"id": "kitchen-main", "on": False}),
        ("light", {"id": "kitchen-under", "on": False}),
        ("light", {"id": "lounge-corner", "on": True}),
    ]},
    "bedtime": {"name": "Bedtime", "icon": "🌙", "actions": [
        ("all-lights-off", {"except": ["bed1-left", "bed1-right"]}),
        ("light", {"id": "stairs-ground", "level": 10}),
        ("blinds", {"id": "all", "position": 100}),
    ]},
    "leaving": {"name": "Leaving", "icon": "🔒", "actions": [
        ("all-lights-off", {}),
        ("aircon", {"power": False}),
    ]},
    "heat-loft": {"name": "Heat loft", "icon": "🔥", "actions": [
        ("aircon", {"power": True, "mode": "heat", "setpoint": 21}),
    ]},
    "block-sun": {"name": "Block sun", "icon": "🕶", "actions": [
        ("blinds", {"id": "all", "position": 100}),
    ]},
}


def run(hub, scene_id: str) -> dict:
    scene = SCENES[scene_id]
    errors = []
    for kind, body in scene["actions"]:
        try:
            if kind == "all-lights-off":
                keep = set(body.get("except", []))
                for lid, l in list(hub.house.lights.items()):
                    if l.on and lid not in keep:
                        hub.adapters["hubitat"].command("light", {"id": lid, "on": False})
            else:
                hub.command(kind, body, notify=False)
        except Exception as e:  # one missing device shouldn't stop the rest
            errors.append(f"{kind}: {e}")
    hub.changed()
    return {"ok": not errors, "scene": scene["name"], "errors": errors}


def catalogue() -> list:
    return [{"id": k, "name": v["name"], "icon": v["icon"]} for k, v in SCENES.items()]
