"""Integrations. Each adapter is 'live' when config.json has what it needs,
otherwise 'demo' (simulated) so the dashboard is always usable.

  hubitat  – Hubitat C-8 Maker API (lights, sensors, plugs, Zigbee/Z-Wave)
  wiser    – Drayton Wiser HubR local API  (/data/v2/domain/, SECRET header)
  fox      – Fox ESS Open API (cloud, rate-limited ~1440 calls/day)
  aircon   – Panasonic RAC via ESPHome web_server REST (local) — see docs
  blinds   – Velux solar blinds; live via Hubitat windowShade devices
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import random
import ssl
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

log = logging.getLogger("adapters")

LAT, LON = 51.40, -1.00  # southern England: close enough for the sun


def http_json(url, method="GET", body=None, headers=None, timeout=8):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def ha_get_state(ha_cfg: dict, entity_id: str):
    """Read one entity from Home Assistant (config.json → homeassistant.{url, token})."""
    url = ha_cfg.get("url", "http://127.0.0.1:8123").rstrip("/") + "/api/states/" + entity_id
    return http_json(url, headers={"Authorization": "Bearer " + ha_cfg["token"]}, timeout=6)


def ha_find_entity(ha_cfg: dict, pattern: str):
    r"""First entity_id matching a regex, e.g. r'sensor\.octopus_energy_electricity_.*_current_demand'."""
    import re
    url = ha_cfg.get("url", "http://127.0.0.1:8123").rstrip("/") + "/api/states"
    for st in http_json(url, headers={"Authorization": "Bearer " + ha_cfg["token"]}, timeout=10):
        if re.fullmatch(pattern, st["entity_id"]):
            return st["entity_id"]
    return None


def ha_call(ha_cfg: dict, domain: str, service: str, data: dict):
    url = ha_cfg.get("url", "http://127.0.0.1:8123").rstrip("/") + f"/api/services/{domain}/{service}"
    return http_json(url, "POST", data, {"Authorization": "Bearer " + ha_cfg["token"]}, timeout=10)


class Adapter:
    name = "base"
    interval = 5.0

    def __init__(self, cfg: dict, hub):
        self.cfg = cfg or {}
        self.hub = hub
        self.house = hub.house
        self.live = self.configured()
        self.last_ok: float | None = None
        self.last_error: str | None = None
        self._wake = threading.Event()

    def configured(self) -> bool:
        return False

    def status(self) -> dict:
        return {"mode": "live" if self.live else "demo", "lastOk": self.last_ok,
                "error": self.last_error, "label": self.label}

    label = ""

    def run_forever(self):
        while True:
            try:
                self.poll() if self.live else self.simulate()
                self.last_ok, self.last_error = time.time(), None
                self.hub.changed()
            except Exception as e:  # keep going; show error in UI
                self.last_error = str(e)
                log.warning("%s: %s", self.name, e)
            self._wake.wait(self.interval)
            self._wake.clear()

    def poll(self): ...
    def simulate(self): ...
    def command(self, kind: str, body: dict): raise NotImplementedError


# --------------------------------------------------------------------------
class HubitatAdapter(Adapter):
    """Maker API: Apps ▸ Add built-in app ▸ Maker API. Allow the devices, then
    put the app id + access token in config.json → hubitat.{host,appId,token}."""
    name, label, interval = "hubitat", "Hubitat C-8", 5.0

    def configured(self):
        return all(self.cfg.get(k) for k in ("host", "appId", "token"))

    def _url(self, path):
        q = urllib.parse.urlencode({"access_token": self.cfg["token"]})
        return f"http://{self.cfg['host']}/apps/api/{self.cfg['appId']}/{path}?{q}"

    def poll(self):
        devs = http_json(self._url("devices/all"))
        by_id = {int(d["id"]): d for d in devs}
        h = self.house
        with self.hub.lock:
            for l in h.lights.values():
                d = by_id.get(l.hubitat or -1)
                if not d:
                    continue
                a = d.get("attributes", {})
                l.live = True
                l.on = a.get("switch") == "on"
                if a.get("level") is not None:
                    l.level = int(float(a["level"]))
            for room, s in h.sensors.items():
                spec = _room(h.layout, room).get("sensors", {})
                for attr, ref in spec.items():
                    d = by_id.get(ref.get("hubitat") or -1)
                    if d and d.get("attributes", {}).get(attr) is not None:
                        v = d["attributes"][attr]
                        s[attr] = v if attr == "motion" else float(v)
                        s["live"] = True
            for dev in h.devices.values():
                d = by_id.get(dev.get("hubitat") or -1)
                if d:
                    dev["on"] = d.get("attributes", {}).get("switch") == "on"
                    dev["live"] = True
            hw = h.layout.get("hotwater", {})
            if (d := by_id.get(hw.get("sensor", -1))) and d["attributes"].get("temperature") is not None:
                h.hotwater["temperature"] = float(d["attributes"]["temperature"])
                h.hotwater["live"] = True
            if (d := by_id.get(hw.get("boostSwitch", -1))):
                h.hotwater["boost"] = d["attributes"].get("switch") == "on"
        # "Hey Google, turn on Movie" flips a virtual switch on the hub → run the scene,
        # then flip the switch back off so it works next time too.
        for dev_id, scene_id in (self.cfg.get("sceneSwitches") or {}).items():
            d = by_id.get(int(dev_id))
            if d and d.get("attributes", {}).get("switch") == "on":
                log.info("voice scene: %s", scene_id)
                self.send(int(dev_id), "off")
                threading.Thread(target=self._run_scene, args=(scene_id,), daemon=True).start()

    def _run_scene(self, scene_id):
        import scenes
        try:
            scenes.run(self.hub, scene_id)
        except Exception as e:
            log.warning("scene %s failed: %s", scene_id, e)

    def send(self, device_id: int, *cmd):
        path = "devices/" + "/".join(str(x) for x in (device_id, *cmd))
        http_json(self._url(path))
        self._wake.set()

    def simulate(self):
        # demo: lights only change when tapped; sensors wander gently
        with self.hub.lock:
            for room, s in self.house.sensors.items():
                s.setdefault("temperature", round(random.uniform(18, 21), 1))
                s.setdefault("humidity", round(random.uniform(48, 62)))
                s["temperature"] = round(s["temperature"] + random.uniform(-.05, .05), 2)
                s["humidity"] = max(35, min(95, round(s["humidity"] + random.uniform(-.4, .4), 1)))
                if room == "ensuite1":
                    s["motion"] = "active" if random.random() < .05 else "inactive"

    def command(self, kind, body):
        h = self.house
        if kind == "light":
            l = h.lights[body["id"]]
            if self.live and l.hubitat:
                if "level" in body and l.dimmable:
                    self.send(l.hubitat, "setLevel", int(body["level"]))
                else:
                    self.send(l.hubitat, "on" if body.get("on") else "off")
            with self.hub.lock:
                if "on" in body:
                    l.on = bool(body["on"])
                if "level" in body:
                    l.level, l.on = int(body["level"]), int(body["level"]) > 0
            return {"ok": True}
        if kind == "device":
            d = h.devices[body["id"]]
            if self.live and d.get("hubitat"):
                self.send(d["hubitat"], "on" if body.get("on") else "off")
            d["on"] = bool(body.get("on"))
            return {"ok": True}
        if kind == "hubitat-event":  # Maker API "POST events to URL"
            self._wake.set()
            return {"ok": True}
        raise KeyError(kind)


# --------------------------------------------------------------------------
class WiserAdapter(Adapter):
    """Drayton Wiser HubR. Secret: put hub in setup mode, join its WiFi,
    GET http://192.168.8.1/secret . config.json → wiser.{host,secret}."""
    name, label, interval = "wiser", "Drayton Wiser", 20.0

    def configured(self):
        return bool(self.cfg.get("host") and self.cfg.get("secret"))

    def _req(self, path, method="GET", body=None):
        return http_json(f"http://{self.cfg['host']}/data/v2/{path}", method, body,
                         {"SECRET": self.cfg["secret"]})

    def poll(self):
        dom = self._req("domain/")
        rooms = {r["Name"].lower(): r for r in dom.get("Room", [])}
        with self.hub.lock:
            for z in self.house.zones.values():
                r = rooms.get(z.name.lower())
                if not r:
                    continue
                z.live = True
                z.temperature = r.get("CalculatedTemperature", 0) / 10
                z.setpoint = r.get("CurrentSetPoint", 0) / 10
                z.demand = r.get("PercentageDemand", 0)
                z.mode = "boost" if r.get("OverrideType") == "Manual" and r.get("OverrideTimeoutUnixTime") else \
                         ("auto" if r.get("Mode") == "Auto" else "manual")
                z.wiser_id = r["id"]
            hw = (dom.get("HotWater") or [{}])[0]
            self.house.hotwater["heating"] = hw.get("WaterHeatingState") == "On"

    def simulate(self):
        hour = datetime.now().hour + datetime.now().minute / 60
        with self.hub.lock:
            for z in self.house.zones.values():
                if z.mode == "auto" and z.room not in getattr(self.hub, "optimiser_owned_zones", ()):
                    z.setpoint = 20.0 if (6.5 <= hour < 9 or 16.5 <= hour < 22.5) else 16.0
                    if z.room.startswith("bed"):
                        z.setpoint -= 1.5
                real = self.house.sensors.get(z.room, {})
                if z.room == "bed1":  # the loft has one air temperature, shared with the aircon
                    z.temperature = self.house.aircon.indoor_c
                    if z.demand > 0:  # the radiator is warming the loft
                        self.house.aircon.indoor_c = round(self.house.aircon.indoor_c + 0.05, 2)
                if real.get("live") and real.get("temperature") is not None:
                    z.temperature = real["temperature"]  # real Hubitat sensor wins
                err = z.setpoint - z.temperature
                z.demand = max(0, min(100, int(err * 60))) if z.mode != "off" else 0
                if not real.get("live") and z.room != "bed1":
                    z.temperature = round(z.temperature + (0.08 if z.demand else -0.03) +
                                          random.uniform(-.02, .02), 2)
            if self.house.hotwater.get("live"):
                return  # tank temperature comes from the real Hubitat sensor
            self.house.hotwater["heating"] = self.house.hotwater["temperature"] < 45
            t = self.house.hotwater["temperature"]
            self.house.hotwater["temperature"] = round(
                t + (0.6 if self.house.hotwater["heating"] or self.house.hotwater["boost"] else -0.05), 1)

    def command(self, kind, body):
        h = self.house
        if "hotwater" in body:
            on = bool(body["hotwater"])
            boost = h.layout.get("hotwater", {}).get("boostSwitch")
            hub = self.hub.adapters["hubitat"]
            if hub.live and boost:
                hub.send(boost, "on" if on else "off")
            elif self.live:
                self._req("domain/HotWater/2/RequestOverride", "PATCH",
                          {"RequestOverride": {"Type": "Manual", "SetPoint": 1100 if on else -200,
                                               "DurationMinutes": 30}})
            h.hotwater["boost"] = on
            return {"ok": True}
        z = h.zones[body["room"]]
        sp = round(float(body["setpoint"]) * 2) / 2
        if self.live and getattr(z, "wiser_id", None):
            self._req(f"domain/Room/{z.wiser_id}", "PATCH",
                      {"RequestOverride": {"Type": "Manual", "SetPoint": int(sp * 10)}})
        with self.hub.lock:
            z.setpoint, z.mode = sp, body.get("mode", "manual")
        self._wake.set()
        return {"ok": True}


# --------------------------------------------------------------------------
def sun_elevation(ts: float) -> float:
    d = datetime.fromtimestamp(ts)
    n = d.timetuple().tm_yday
    decl = 23.44 * math.sin(math.radians(360 / 365 * (n - 81)))
    u = datetime.fromtimestamp(ts, timezone.utc)
    utc_h = u.hour + u.minute / 60
    ha = 15 * (utc_h + LON / 15 - 12)
    la, de, h = map(math.radians, (LAT, decl, ha))
    return math.degrees(math.asin(math.sin(la) * math.sin(de) + math.cos(la) * math.cos(de) * math.cos(h)))


def demo_solar(ts, kwp=4.2):
    el = sun_elevation(ts)
    if el <= 0:
        return 0.0
    clouds = 0.55 + 0.45 * math.sin(ts / 1700) * math.sin(ts / 530)
    return max(0, kwp * 1000 * math.sin(math.radians(el)) ** 1.2 * (0.35 + 0.65 * abs(clouds)))


def demo_load(ts):
    h = datetime.fromtimestamp(ts).hour + datetime.fromtimestamp(ts).minute / 60
    base = 260
    base += 900 * math.exp(-((h - 7.5) ** 2) / 0.6) + 1600 * math.exp(-((h - 18.5) ** 2) / 1.2)
    base += 250 * math.exp(-((h - 13) ** 2) / 2)
    return base + 120 * math.sin(ts / 97) ** 2


class FoxAdapter(Adapter):
    """Fox ESS Open API. API key: foxesscloud.com ▸ User profile ▸ API management.
    config.json → fox.{apiKey, sn}. Limit is 1440 calls/day/key, so poll at 120 s."""
    name, label, interval = "fox", "Fox ESS solar + battery", 120.0
    BASE = "https://www.foxesscloud.com"

    def configured(self):
        return bool(self.cfg.get("apiKey") and self.cfg.get("sn"))

    def _post(self, path, body):
        ts = str(round(time.time() * 1000))
        # Fox's signature uses the *literal* characters \r\n, not CR LF.
        sig = hashlib.md5(fr"{path}\r\n{self.cfg['apiKey']}\r\n{ts}".encode()).hexdigest()
        hdr = {"token": self.cfg["apiKey"], "timestamp": ts, "signature": sig, "lang": "en",
               "User-Agent": "demo-drive-house/1.0"}
        res = http_json(self.BASE + path, "POST", body, hdr, timeout=15)
        if res.get("errno"):
            raise RuntimeError(f"Fox errno {res['errno']}: {res.get('msg')}")
        return res["result"]

    def poll(self):
        vars_ = ["pvPower", "loadsPower", "batChargePower", "batDischargePower",
                 "gridConsumptionPower", "feedinPower", "SoC"]
        res = self._post("/op/v0/device/real/query", {"sns": [self.cfg["sn"]], "variables": vars_})
        v = {d["variable"]: d.get("value", 0) for d in res[0]["datas"]}
        e = self.house.energy
        with self.hub.lock:
            e.live = True
            e.solar_w = v.get("pvPower", 0) * 1000
            e.load_w = v.get("loadsPower", 0) * 1000
            e.battery_w = (v.get("batChargePower", 0) - v.get("batDischargePower", 0)) * 1000
            e.grid_w = (v.get("gridConsumptionPower", 0) - v.get("feedinPower", 0)) * 1000
            e.soc = v.get("SoC", e.soc)
            self._record(time.time())

    def _record(self, ts):
        e = self.house.energy
        if not e.history or ts - e.history[-1][0] >= 290:
            e.history.append([int(ts), round(e.solar_w), round(e.load_w), round(e.soc, 1)])
            cutoff = ts - 86400
            e.history[:] = [x for x in e.history if x[0] >= cutoff]

    def _step(self, ts, dt):
        e = self.house.energy
        ac = self.house.aircon
        e.solar_w = demo_solar(ts)
        e.load_w = demo_load(ts) + (ac.power_w if ac.power else 0)
        surplus = e.solar_w - e.load_w
        cap_wh = e.battery_kwh * 1000
        hour = datetime.fromtimestamp(ts).hour
        if 2 <= hour < 5:  # off-peak force charge (e.g. Octopus Go/Intelligent)
            e.work_mode, bat = "Force Charge", 3000 if e.soc < 95 else 0
        else:
            e.work_mode = "Self Use"
            bat = max(-3600, min(3600, surplus))
            if bat > 0 and e.soc >= 100: bat = 0
            if bat < 0 and e.soc <= 10: bat = 0
        e.battery_w = bat
        e.soc = max(0, min(100, e.soc + bat * dt / 3600 / cap_wh * 100))
        e.grid_w = e.load_w + bat - e.solar_w
        e.today_solar_kwh += e.solar_w * dt / 3.6e6
        e.today_import_kwh += max(0, e.grid_w) * dt / 3.6e6
        e.today_export_kwh += max(0, -e.grid_w) * dt / 3.6e6

    def simulate(self):
        now = time.time()
        with self.hub.lock:
            e = self.house.energy
            if not e.history:  # back-fill today so the chart isn't empty
                midnight = datetime.now().replace(hour=0, minute=0, second=0).timestamp()
                e.soc, t = 38.0, midnight
                while t < now:
                    self._step(t, 300); self._record(t); t += 300
            self._step(now, self.interval)
            self._record(now)

    def command(self, kind, body):
        # Work-mode changes via /op/v0/device/scheduler/enable — wired when live.
        with self.hub.lock:
            self.house.energy.work_mode = body.get("workMode", self.house.energy.work_mode)
        return {"ok": True, "note": "demo" if not self.live else "sent"}

    interval = 10.0  # demo cadence; live cadence set in __init__

    def __init__(self, cfg, hub):
        super().__init__(cfg, hub)
        self.interval = 120.0 if self.live else 10.0


# --------------------------------------------------------------------------
class AirconAdapter(Adapter):
    """Panasonic RAC Solo 2.5 kW (P-MOZ25IC5-UK) — through-wall monoblock in the
    loft. It ships with Wi-Fi for Panasonic's app (cloud) and has an optional
    Modbus wall controller. Live path today: any local bridge that speaks the
    ESPHome-style climate REST shape (GET /climate/<entity>, POST .../set) —
    e.g. an ESP32 Modbus bridge, or a Home Assistant shim. Swap in a Modbus
    client here once the unit and its register map are in hand.
    config.json → aircon.{host, entity}"""
    name, label, interval = "aircon", "Panasonic RAC Solo", 10.0

    def configured(self):
        return bool(self.cfg.get("host"))

    def poll(self):
        ent = self.cfg.get("entity", "panasonic_ac")
        d = http_json(f"http://{self.cfg['host']}/climate/{ent}")
        a = self.house.aircon
        with self.hub.lock:
            a.live = True
            a.mode = d.get("mode", "OFF").lower().replace("heat_cool", "auto").replace("fan_only", "fan")
            a.power = a.mode != "off"
            if not a.power: a.mode = "heat"
            a.setpoint = float(d.get("target_temperature", a.setpoint))
            a.indoor_c = float(d.get("current_temperature", a.indoor_c))
            a.fan = (d.get("fan_mode") or "auto").lower()

    def simulate(self):
        a = self.house.aircon
        with self.hub.lock:
            if a.power and a.mode in ("heat", "cool", "auto"):
                err = a.setpoint - a.indoor_c
                a.power_w = min(900, 120 + abs(err) * 300)
                a.indoor_c += max(-.15, min(.15, err * .08))
            else:
                a.power_w = 0
                a.indoor_c += (17.5 - a.indoor_c) * 0.01
            a.indoor_c = round(a.indoor_c + random.uniform(-.02, .02), 2)
            wx = getattr(self.house, "weather", None)
            a.outdoor_c = wx["outdoor_c"] if wx else round(7 + 4 * math.sin((time.time() / 3600 - 9) / 24 * 2 * math.pi), 1)

    def command(self, kind, body):
        a = self.house.aircon
        with self.hub.lock:
            for k in ("power", "mode", "setpoint", "fan", "eco", "swing"):
                if k in body:
                    setattr(a, k, body[k])
            a.setpoint = max(16, min(30, round(float(a.setpoint) * 2) / 2))
        if self.live:
            ent = self.cfg.get("entity", "panasonic_ac")
            esp_mode = {"auto": "heat_cool", "fan": "fan_only"}.get(a.mode, a.mode) if a.power else "off"
            q = urllib.parse.urlencode({"mode": esp_mode, "target_temperature": a.setpoint,
                                        "fan_mode": a.fan})
            urllib.request.urlopen(urllib.request.Request(
                f"http://{self.cfg['host']}/climate/{ent}/set?{q}", method="POST"), timeout=5)
        self._wake.set()
        return {"ok": True}


# --------------------------------------------------------------------------
class BlindsAdapter(Adapter):
    """Velux solar blinds. Live when each blind maps to a Hubitat windowShade
    device (via Velux KLF 200 or a Matter/HomeKit bridge) in config.json →
    blinds.hubitat: {"blind-dormer": 123, ...}."""
    name, label, interval = "blinds", "Velux solar blinds", 3.0

    def configured(self):
        return any((self.cfg.get("hubitat") or {}).values())

    def simulate(self):
        with self.hub.lock:
            for b in self.house.blinds.values():
                tgt = getattr(b, "_target", b.position)
                if b.position != tgt:
                    step = 10 if tgt > b.position else -10
                    b.position = tgt if abs(tgt - b.position) <= 10 else b.position + step

    poll = simulate  # positions also refresh via Hubitat poll when live

    def command(self, kind, body):
        ids = list(self.house.blinds) if body.get("id") == "all" else [body["id"]]
        pos = max(0, min(100, int(body["position"])))
        hub = self.hub.adapters["hubitat"]
        for i in ids:
            b = self.house.blinds[i]
            dev = self.cfg.get("hubitat", {}).get(i)
            if dev and hub.live:
                hub.send(dev, "setPosition", 100 - pos)  # Hubitat: 100 = open
            b._target = pos
        self._wake.set()
        return {"ok": True}



# --------------------------------------------------------------------------
class DisplayAdapter(Adapter):
    """Shows the house screen on a Google Nest Hub via Cast — silently.
    The Hub's web-page receiver can't load plain-HTTP pages, so we cast a
    rendered PNG (/hub.png) to the built-in media player and refresh it every
    minute. Only takes over when the Hub is idle (photo frame) or already
    showing our picture — never interrupts music, video or a call.
    config.json → display.{host, imageUrl, enabled}"""
    name, label, interval = "display", "Nest Hub display", 60.0
    IDLE_APPS = {"Backdrop", None}
    OURS = "Default Media Receiver"

    def configured(self):
        return bool(self.cfg.get("host") and (self.cfg.get("imageUrl") or self.cfg.get("url")))

    def __init__(self, cfg, hub):
        super().__init__(cfg, hub)
        self.enabled = bool(self.cfg.get("enabled", True))
        self.hub_status = {}
        self._ours = False

    def status(self):
        st = super().status()
        st.update(enabled=self.enabled, showing=self.hub_status.get("app"))
        return st

    def _url(self):
        base = self.cfg.get("imageUrl") or "http://192.168.1.10:8080/hub.png"
        return f"{base}?t={int(time.time())}"

    def _cast(self, c):
        c.play(self._url(), mime="image/png", title="House")
        self._ours = True

    def poll(self):
        from cast import Cast
        with Cast(self.cfg["host"]) as c:
            self.hub_status = c.status()
            app = self.hub_status.get("app")
            if not self.enabled:
                return
            if app in self.IDLE_APPS or (app == self.OURS and self._ours):
                self._cast(c)
                self.hub_status["app"] = self.OURS
            else:
                self._ours = False  # someone else is using the Hub; leave it alone

    def simulate(self):
        self.hub_status = {"app": "demo"}

    def command(self, kind, body):
        self.enabled = bool(body.get("on"))
        if not self.live:
            return {"ok": True, "note": "demo"}
        from cast import Cast
        with Cast(self.cfg["host"]) as c:
            if self.enabled:
                self._cast(c)
            else:
                c.stop()  # back to the photo frame
                self._ours = False
            self.hub_status = c.status()
        return {"ok": True}

# --------------------------------------------------------------------------
class OctopusAdapter(Adapter):
    """Octopus Energy. API key + account number from
    octopus.energy/dashboard/new/accounts/personal-details/api-access .
    config.json → octopus.{apiKey, account}.

    - Smart-meter half-hourly electricity + gas consumption (REST; Octopus
      usually publishes yesterday's data, sometimes same-day).
    - Tariff unit rates (works for fixed, Go, Intelligent, Agile, Tracker).
    - Live demand every ~10 s via GraphQL smartMeterTelemetry *if* an
      Octopus Home Mini is paired (it's free on request from Octopus).
    """
    name, label = "octopus", "Octopus Energy"
    REST = "https://api.octopus.energy/v1"
    GQL = "https://api.octopus.energy/v1/graphql/"
    GAS_M3_TO_KWH = 1.02264 * 39.5 / 3.6  # volume correction × calorific value ÷ 3.6

    def configured(self):
        return bool(self.cfg.get("apiKey") and self.cfg.get("account"))

    def __init__(self, cfg, hub):
        super().__init__(cfg, hub)
        self.interval = 10.0
        self._meta = None
        self._token = None
        self._token_at = 0
        self._last_slow = 0

    # ---- helpers -------------------------------------------------------
    def _get(self, path, **q):
        import base64
        url = path if path.startswith("http") else self.REST + path
        if q:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(q)
        auth = base64.b64encode(f"{self.cfg['apiKey']}:".encode()).decode()
        return http_json(url, headers={"Authorization": f"Basic {auth}",
                                       "User-Agent": "demo-drive-house/1.0"}, timeout=15)

    def _gql(self, query, variables=None, auth=True):
        hdr = {"User-Agent": "demo-drive-house/1.0"}
        if auth:
            if not self._token or time.time() - self._token_at > 50 * 60:
                r = self._gql("mutation($k:String!){obtainKrakenToken(input:{APIKey:$k}){token}}",
                              {"k": self.cfg["apiKey"]}, auth=False)
                self._token, self._token_at = r["obtainKrakenToken"]["token"], time.time()
            hdr["Authorization"] = self._token
        res = http_json(self.GQL, "POST", {"query": query, "variables": variables or {}}, hdr, timeout=15)
        if res.get("errors"):
            raise RuntimeError("Octopus GraphQL: " + res["errors"][0].get("message", "error"))
        return res["data"]

    @staticmethod
    def _product(tariff_code):  # E-1R-AGILE-24-10-01-H -> AGILE-24-10-01
        return "-".join(tariff_code.split("-")[2:-1])

    @staticmethod
    def _active(agreements):
        now = datetime.now(timezone.utc).isoformat()
        for a in agreements:
            if a["valid_from"] <= now and (a.get("valid_to") is None or a["valid_to"] > now):
                return a["tariff_code"]
        return agreements[-1]["tariff_code"] if agreements else None

    def _reporting_meter(self, base, meters):
        """Meter points often list old, replaced meters too — pick the one with recent data."""
        best, best_ts = meters[-1]["serial_number"], ""
        for mt in meters:
            r = self._get(f"{base}/meters/{mt['serial_number']}/consumption/", page_size=1)["results"]
            if r and r[0]["interval_start"] > best_ts:
                best, best_ts = mt["serial_number"], r[0]["interval_start"]
        return best

    def _discover(self):
        acct = self._get(f"/accounts/{self.cfg['account']}/")
        prop = acct["properties"][0]
        m = {"elec": None, "gas": None}
        for mp in prop.get("electricity_meter_points", []):
            if mp.get("is_export"):
                continue
            m["elec"] = {"mpan": mp["mpan"], "tariff": self._active(mp["agreements"]),
                         "serial": self._reporting_meter(f"/electricity-meter-points/{mp['mpan']}", mp["meters"])}
        for mp in prop.get("gas_meter_points", []):
            m["gas"] = {"mprn": mp["mprn"], "tariff": self._active(mp["agreements"]),
                        "serial": self._reporting_meter(f"/gas-meter-points/{mp['mprn']}", mp["meters"])}
        try:
            d = self._gql("query($a:String!){account(accountNumber:$a){electricityAgreements(active:true)"
                          "{meterPoint{meters(includeInactive:false){smartDevices{deviceId}}}}}}",
                          {"a": self.cfg["account"]})
            devs = [sd["deviceId"] for ag in d["account"]["electricityAgreements"]
                    for mt in ag["meterPoint"]["meters"] for sd in mt["smartDevices"]]
            m["deviceId"] = devs[0] if devs else None
        except Exception as e:
            log.info("octopus: no Home Mini telemetry (%s)", e)
            m["deviceId"] = None
        self._meta = m

    def _rates(self, kind, tariff, since, until):
        prod = self._product(tariff)
        res = self._get(f"/products/{prod}/{kind}-tariffs/{tariff}/standard-unit-rates/",
                        period_from=since, period_to=until, page_size=200)
        return sorted(((datetime.fromisoformat(r["valid_from"].replace("Z", "+00:00")).timestamp(),
                        (datetime.fromisoformat(r["valid_to"].replace("Z", "+00:00")).timestamp()
                         if r.get("valid_to") else 4e9), r["value_inc_vat"])
                       for r in res["results"]), key=lambda x: x[0])

    @staticmethod
    def _rate_at(rates, ts):
        for f, t, v in rates:
            if f <= ts < t:
                return v
        return rates[-1][2] if rates else None

    # ---- polling -------------------------------------------------------
    def poll(self):
        if self._meta is None:
            self._discover()
        o, m, now = self.house.octopus, self._meta, time.time()
        live_err = None
        ha = self.hub.cfg.get("homeassistant") or {}
        if ha.get("token"):
            # Home Assistant's Octopus integration already polls the Home Mini; asking Octopus
            # twice trips their rate limit, so read HA's sensor instead.
            try:
                if not getattr(self, "_ha_demand", None):
                    self._ha_demand = ha_find_entity(ha, r"sensor\.octopus_energy_electricity_.*_current_demand")
                if self._ha_demand:
                    st = ha_get_state(ha, self._ha_demand)
                    if st["state"] not in ("unknown", "unavailable"):
                        with self.hub.lock:
                            o["demand_w"] = float(st["state"])
                            o["last_reading_at"] = st.get("last_updated")
                            o["homeMini"] = True
                            o["via"] = "Home Assistant"
            except Exception as e:
                live_err = e
        elif m.get("deviceId"):  # live demand every 10 s (Home Mini)
            try:
                start = datetime.fromtimestamp(now - 300, timezone.utc).isoformat()
                end = datetime.fromtimestamp(now + 60, timezone.utc).isoformat()
                d = self._gql("query($d:String!,$s:DateTime!,$e:DateTime!){smartMeterTelemetry("
                              "deviceId:$d,grouping:TEN_SECONDS,start:$s,end:$e){readAt demand consumptionDelta}}",
                              {"d": m["deviceId"], "s": start, "e": end})
                rows = [r for r in (d["smartMeterTelemetry"] or []) if r.get("demand") is not None]
                if rows:
                    with self.hub.lock:
                        o["demand_w"] = float(rows[-1]["demand"])
                        o["last_reading_at"] = rows[-1]["readAt"]
                        o["homeMini"] = True
            except Exception as e:  # don't let live telemetry block tariff/usage data
                live_err = e
        if now - self._last_slow >= 900:  # consumption + rates every 15 min
            self._last_slow = now
            self._slow_poll(m, o, now)
        if live_err:
            raise live_err

    def _slow_poll(self, m, o, now):
        midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        since, until = midnight.isoformat(), (midnight.timestamp() + 2 * 86400)
        until = datetime.fromtimestamp(until, timezone.utc).isoformat()
        rates_since = datetime.fromtimestamp(midnight.timestamp() - 3 * 86400, timezone.utc).isoformat()
        e, g = m["elec"], m["gas"]
        with self.hub.lock:
            o["live"] = True
        if e and e["tariff"]:
            rates = self._rates("electricity", e["tariff"], rates_since, until) or self._account_rates(midnight)
            hh, day = self._consumption(f"/electricity-meter-points/{e['mpan']}/meters/{e['serial']}/consumption/", since)
            hh = [[ts, kwh, self._rate_at(rates, ts)] for ts, kwh in hh]
            nxt = next(((f, v) for f, t, v in rates if f > now and v != self._rate_at(rates, now)), (None, None))
            with self.hub.lock:
                o.update(tariff=e["tariff"], rate_p=self._rate_at(rates, now),
                         next_rate_at=nxt[0], next_rate_p=nxt[1],
                         rates=[[int(f), v] for f, t, v in rates if t > midnight.timestamp()],
                         elec_halfhours=hh, usage_day=day,
                         elec_today_kwh=round(sum(x[1] for x in hh), 2),
                         elec_today_cost_p=round(sum(x[1] * (x[2] or 0) for x in hh), 1))
        if g and g["tariff"]:
            grates = self._rates("gas", g["tariff"], rates_since, until)
            gr = self._rate_at(grates, now) if grates else self._account_gas_rate()
            hh, gday = self._consumption(f"/gas-meter-points/{g['mprn']}/meters/{g['serial']}/consumption/", since)
            factor = self.GAS_M3_TO_KWH if self.cfg.get("gasUnits", "m3") == "m3" else 1  # SMETS2 reports m³
            hh = [[ts, round(v * factor, 3)] for ts, v in hh]
            with self.hub.lock:
                o.update(gas_tariff=g["tariff"], gas_rate_p=gr, gas_halfhours=hh, gas_usage_day=gday,
                         gas_today_kwh=round(sum(x[1] for x in hh), 2),
                         gas_today_cost_p=round(sum(x[1] for x in hh) * (gr or 0), 1))

    def _consumption(self, path, since):
        """Today's half-hours; if Octopus hasn't published any yet, the latest full day it has."""
        res = self._get(path, period_from=since, page_size=100, order_by="period")["results"]
        day = "today"
        if not res:
            res = self._get(path, page_size=48, order_by="-period")["results"]
            if res:
                last = datetime.fromisoformat(res[0]["interval_start"].replace("Z", "+00:00")).astimezone()
                res = [r for r in res if datetime.fromisoformat(r["interval_start"].replace("Z", "+00:00")).astimezone().date() == last.date()]
                day = last.strftime("%a %-d %b")
        rows = sorted((int(datetime.fromisoformat(r["interval_start"].replace("Z", "+00:00")).timestamp()), r["consumption"]) for r in res)
        return [list(r) for r in rows], day

    def _account_tariff(self, kind="electricity"):
        q = ("query($a:String!){account(accountNumber:$a){%sAgreements(active:true){tariff{__typename"
             " ... on StandardTariff{unitRate} ... on DayNightTariff{dayRate nightRate}"
             " ... on ThreeRateTariff{dayRate nightRate offPeakRate}"
             " ... on HalfHourlyTariff{unitRates{value}} ... on PrepayTariff{unitRate}}}}}" % kind)
        ags = self._gql(q, {"a": self.cfg["account"]})["account"][f"{kind}Agreements"]
        return ags[0]["tariff"] if ags else {}

    def _account_gas_rate(self):
        t = self._account_tariff("gas")
        return t.get("unitRate")

    def _account_rates(self, midnight):
        """Tariffs whose prices aren't public (e.g. Intelligent Octopus Go): read the
        account's own rates via GraphQL and lay them on the off-peak window
        (config octopus.offPeak, default 23:30-05:30) plus any planned smart-charge slots."""
        t = self._account_tariff()
        vals = [r["value"] for r in t.get("unitRates", [])] or \
               [v for k, v in t.items() if k.endswith("ate") and isinstance(v, (int, float))]
        if not vals:
            return []
        lo, hi = min(vals), max(vals)
        a, b = self.cfg.get("offPeak", "23:30-05:30").split("-")
        ah, am = map(int, a.split(":")); bh, bm = map(int, b.split(":"))
        cheap = []
        for d in range(-4, 2):
            base = midnight.timestamp() + d * 86400
            s0 = base + ah * 3600 + am * 60
            s1 = base + bh * 3600 + bm * 60 + (86400 if (bh, bm) <= (ah, am) else 0)
            cheap.append((s0, s1))
        try:  # Intelligent Octopus extra cheap slots when it smart-charges a car/battery
            pd = self._gql("query($a:String!){plannedDispatches(accountNumber:$a){start end}}", {"a": self.cfg["account"]})
            for x in pd.get("plannedDispatches") or []:
                cheap.append((datetime.fromisoformat(x["start"]).timestamp(), datetime.fromisoformat(x["end"]).timestamp()))
        except Exception:
            pass
        out = []
        for i in range(-3 * 48, 96):  # 3 days back (usage lag) to end of tomorrow
            f = midnight.timestamp() + i * 1800
            v = lo if any(s <= f < e for s, e in cheap) else hi
            out.append((f, f + 1800, v))
        return out

    # ---- demo ----------------------------------------------------------
    def simulate(self):
        o, e, now = self.house.octopus, self.house.energy, time.time()
        midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        with self.hub.lock:
            if o["rates"] and o["rates"][0][0] < midnight:  # new day
                o["rates"], o["elec_halfhours"], o["gas_halfhours"] = [], [], []
            if not o["rates"]:  # Agile-style day: cheap overnight, 4–7pm peak
                o["tariff"], o["gas_tariff"], o["gas_rate_p"] = "E-1R-AGILE-24-10-01-H (demo)", "G-1R-VAR-22-11-01-H (demo)", 6.3
                for i in range(96):
                    ts = midnight + i * 1800
                    h = (i % 48) / 2
                    p = 14 + 8 * math.sin((h - 9) / 24 * 2 * math.pi) + random.uniform(-2, 2)
                    if 16 <= h < 19: p += 14
                    if 1 <= h < 5: p -= 9
                    o["rates"].append([int(ts), round(max(-2, p), 2)])
            o["demand_w"] = e.grid_w  # follow the solar/battery simulator
            o["homeMini"] = True
            o["rate_p"] = next((v for f, v in reversed(o["rates"]) if f <= now), None)
            nxt = next(((f, v) for f, v in o["rates"] if f > now), (None, None))
            o["next_rate_at"], o["next_rate_p"] = nxt
            # half-hourly buckets for today
            slot = int((now - midnight) // 1800)
            while len(o["elec_halfhours"]) <= slot:
                i = len(o["elec_halfhours"])
                ts = midnight + i * 1800
                h = i / 2
                past = i < slot  # back-fill earlier slots so the demo day isn't empty
                kwh = round(random.uniform(.12, .35) + (.5 if 17 <= h < 20 else 0) - (.1 if 10 <= h < 15 else 0), 3) if past else 0.0
                o["elec_halfhours"].append([int(ts), max(0, kwh), o["rates"][i][1]])
                heat = 1.2 if (6 <= h < 9 or 16.5 <= h < 22) else 0.15
                o["gas_halfhours"].append([int(ts), round(heat * random.uniform(.7, 1.3), 3)])
            o["elec_halfhours"][slot][1] = round(o["elec_halfhours"][slot][1] + max(0, e.grid_w) * self.interval / 3.6e6, 4)
            o["elec_today_kwh"] = round(sum(x[1] for x in o["elec_halfhours"]), 2)
            o["elec_today_cost_p"] = round(sum(x[1] * x[2] for x in o["elec_halfhours"]), 1)
            o["gas_today_kwh"] = round(sum(x[1] for x in o["gas_halfhours"]), 2)
            o["gas_today_cost_p"] = round(o["gas_today_kwh"] * o["gas_rate_p"], 1)
            o["last_reading_at"] = datetime.now(timezone.utc).isoformat()

    def command(self, kind, body):
        raise KeyError(kind)


def _room(layout, room_id):
    for f in layout["floors"]:
        for r in f["rooms"]:
            if r["id"] == room_id:
                return r
    return {}


# --------------------------------------------------------------------------
class TeslaAdapter(Adapter):
    """The Tesla, through Intelligent Octopus Go. Octopus already talks to the car to schedule its
    charging, and the Octopus integration in Home Assistant exposes what it knows: state, charge
    level, the charging slots, the charge target and ready-by time, and a bump-charge switch.
    No Tesla login needed. Octopus's states (BottlecapDave's docs):
      SMART_CONTROL_CAPABLE      at home, plugged in, nothing scheduled
      SMART_CONTROL_IN_PROGRESS  a smart charge is scheduled or happening (charging when a slot is on)
      BOOSTING                   bump charge running now
      SMART_CONTROL_OFF          smart charging paused (e.g. holiday mode)
      SMART_CONTROL_NOT_AVAILABLE  unplugged or away
      LOST_CONNECTION            Octopus has lost the car"""
    name, label, interval = "tesla", "Tesla · Octopus", 60.0
    PLUGGED = {"SMART_CONTROL_CAPABLE", "SMART_CONTROL_IN_PROGRESS", "BOOSTING", "SMART_CONTROL_OFF", "SETUP_COMPLETE"}
    KINDS = {"state": r"sensor\.octopus_energy_.*_intelligent_state", "soc": r"sensor\.octopus_energy_.*_intelligent_state_of_charge",
             "dispatching": r"binary_sensor\.octopus_energy_.*_intelligent_dispatching",
             "target": r"number\.octopus_energy_.*_intelligent_charge_target", "ready": r"select\.octopus_energy_.*_intelligent_target_time",
             "smart": r"switch\.octopus_energy_.*_intelligent_smart_charge", "bump": r"switch\.octopus_energy_.*_intelligent_bump_charge"}

    def configured(self):
        return bool((self.hub.cfg.get("homeassistant") or {}).get("token"))

    def _ha(self):
        return self.hub.cfg["homeassistant"]

    def _find(self):
        import re
        url = self._ha().get("url", "http://127.0.0.1:8123").rstrip("/") + "/api/states"
        states = http_json(url, headers={"Authorization": "Bearer " + self._ha()["token"]}, timeout=10)
        ids = {}
        for k, pat in self.KINDS.items():
            ids[k] = next((st["entity_id"] for st in states if re.fullmatch(pat, st["entity_id"])), None)
        return ids

    def poll(self):
        if not getattr(self, "_ids", None) or time.time() - getattr(self, "_ids_at", 0) > 3600:
            self._ids, self._ids_at = self._find(), time.time()
        ids, ha = self._ids, self._ha()
        if not ids.get("state"):
            raise RuntimeError("no Intelligent Octopus device in Home Assistant")
        get = lambda k: ha_get_state(ha, ids[k]) if ids.get(k) else None
        st, soc, disp, tgt, rdy, smart, bump = (get(k) for k in ("state", "soc", "dispatching", "target", "ready", "smart", "bump"))
        state = st["state"]
        now = time.time()

        def ts(x):
            return datetime.fromisoformat(x).timestamp()
        planned = [(ts(d["start"]), ts(d["end"]), abs(d.get("charge_in_kwh") or 0)) for d in (disp or {}).get("attributes", {}).get("planned_dispatches", [])]
        slot = next(((a, b) for a, b, _ in planned if a <= now < b), None)
        nxt = min(((a, b) for a, b, _ in planned if a > now), default=None)
        dispatching = (disp or {}).get("state") == "on"
        boost = state == "BOOSTING" or (bump or {}).get("state") == "on"
        charging = boost or (dispatching and state == "SMART_CONTROL_IN_PROGRESS")
        o = self.house.octopus
        power = 0.0
        if charging:  # what the house is drawing, less a typical 400 W background, when the Home Mini is live
            power = max(0.0, o["demand_w"] - 400) if (o.get("live") and o.get("homeMini") and o["demand_w"] > 2000) else 7000.0
        with self.hub.lock:
            self.house.ev.update(
                live=True, via="Intelligent Octopus", state=state, plugged=state in self.PLUGGED or charging,
                charging=charging, boost=boost, power_w=round(power),
                soc=float(soc["state"]) if soc and soc["state"] not in ("unknown", "unavailable") else None,
                soc_at=(soc or {}).get("attributes", {}).get("last_reported"),
                target=float(tgt["state"]) if tgt and tgt["state"] not in ("unknown", "unavailable") else None,
                ready_by=(rdy or {}).get("state"), smart=(smart or {}).get("state") == "on",
                slot=list(slot) if slot else None, next_slot=list(nxt) if nxt else None,
                slots_kwh=round(sum(k for _, _, k in planned), 1))

    def simulate(self):
        """Demo: plugged in overnight, charging 23:30–05:30 at 7 kW up to the target, out by day."""
        ev, now = self.house.ev, datetime.now()
        mins = now.hour * 60 + now.minute
        home = mins >= 18 * 60 or mins < 8 * 60
        cheap = mins >= 23 * 60 + 30 or mins < 5 * 60 + 30
        if ev["soc"] is None:
            ev.update(soc=58.0, target=90.0, ready_by="06:30", smart=True)
        charging = home and ((cheap and ev["soc"] < ev["target"]) or ev.get("boost")) and ev["soc"] < 100
        if charging:
            ev["soc"] = min(100.0, ev["soc"] + 7.0 * self.interval / 3600 / 75 * 100)  # 7 kW into ~75 kWh
        elif not home and ev["soc"] > 40:
            ev["soc"] -= .02
        if ev.get("boost") and ev["soc"] >= 99.9:
            ev["boost"] = False
        start = now.replace(hour=23, minute=30, second=0, microsecond=0).timestamp()
        if mins < 5 * 60 + 30:
            start -= 86400
        ev.update(live=False, via="demo", plugged=home, charging=charging, power_w=7000.0 if charging else 0.0,
                  state="BOOSTING" if charging and ev.get("boost") else "SMART_CONTROL_IN_PROGRESS" if charging
                  else "SMART_CONTROL_CAPABLE" if home else "SMART_CONTROL_NOT_AVAILABLE",
                  slot=[start, start + 6 * 3600] if charging and cheap else None,
                  next_slot=None if (charging or not home) else [start if start > time.time() else start + 86400, (start if start > time.time() else start + 86400) + 6 * 3600])


    def command(self, kind, body):
        """{"bump": true|false} · {"target": 80} · {"readyBy": "07:00"} · {"smart": true|false}"""
        if not self.live:
            ev = self.house.ev
            if "bump" in body: ev["boost"] = bool(body["bump"])
            if "target" in body: ev["target"] = float(body["target"])
            if "readyBy" in body: ev["ready_by"] = body["readyBy"]
            if "smart" in body: ev["smart"] = bool(body["smart"])
            self._wake.set(); return {"ok": True, "demo": True}
        ids, ha = self._ids, self._ha()
        if "bump" in body:
            ha_call(ha, "switch", "turn_on" if body["bump"] else "turn_off", {"entity_id": ids["bump"]})
        if "smart" in body:
            ha_call(ha, "switch", "turn_on" if body["smart"] else "turn_off", {"entity_id": ids["smart"]})
        if "target" in body:
            ha_call(ha, "number", "set_value", {"entity_id": ids["target"], "value": max(10, min(100, int(body["target"])))})
        if "readyBy" in body:
            ha_call(ha, "select", "select_option", {"entity_id": ids["ready"], "option": str(body["readyBy"])})
        self._wake.set()
        return {"ok": True}


def build_adapters(cfg: dict, hub) -> dict:
    classes = [HubitatAdapter, WiserAdapter, FoxAdapter, AirconAdapter, BlindsAdapter, OctopusAdapter, DisplayAdapter, TeslaAdapter]
    from optimiser import OptimiserAdapter  # imports this module, so import late
    classes.append(OptimiserAdapter)
    out = {}
    for cls in classes:
        out[cls.name] = cls(cfg.get(cls.name, {}), hub)
    return out
