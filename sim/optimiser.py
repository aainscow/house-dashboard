"""Cost optimiser: every minute, pick the cheapest way to make heat.

Rules (Predbat will plan the Fox battery separately once it exists):

  loft       The master bedroom (Bedroom 1) needs heat → Panasonic RAC Solo (heat pump) or the gas
             radiator (Wiser zone), whichever gives a kWh of heat for less.
             Pre-heats by +1 °C when cheap power is about to end.
  immersion  Hot water via two 3 kW elements, each on its own Sonoff switch:
             one element when electricity beats gas, both when power is free.

The comparison, in pence per kWh of *heat*:
  gas        = gas unit rate ÷ boiler efficiency          (8.2p ÷ 0.85 ≈ 9.6p)
  aircon     = marginal electricity price ÷ COP           (6.6p ÷ 2.8 ≈ 2.4p)
  immersion  = marginal electricity price ÷ 1.0
where the marginal electricity price is the export rate when we're exporting
solar (that's what the heat really costs us), otherwise the import rate now.

Special periods (they override the price comparison):
  free power   price ≤ 0p, an Octopus free-electricity event in Home Assistant,
               or the dashboard's "Free power now" button → soak it up:
               both immersion elements (if allowed), aircon pre-heats the loft.
  power down   an Octoplus "Power Down" event in Home Assistant → use as little
               electricity as possible: immersions off, aircon off (gas covers).

Power readings (Sonoff POWR320D via SonoffLAN): each element's power sensor
tells us when its own thermostat has switched off, i.e. the tank is full —
a second opinion to the tank probe, which sits on the hot outlet pipe and
reads low whenever no water is flowing. They also give the real kWh and cost
of each heat-up, and catch elements switched on by hand.

Each rule has a mode: "auto" (acts), "advise" (shows the decision only) or
"off". Settings live in config.json → optimiser; see DEFAULTS.
"""
from __future__ import annotations

import copy
import os
import random
import time
from datetime import datetime

from adapters import Adapter, ha_call, ha_find_entity, ha_get_state, log

DEMO = os.environ.get("HOUSE_DEMO", "").lower() in ("1", "true", "yes")

POWER_ON_W = 50          # above this an element is really heating
FULL_AFTER_S = 180       # switched on but drawing nothing for this long → its thermostat is off: tank full
RETRY_S = 3 * 3600       # after "tank full", don't try again for this long (unless power is free)
ELEMENT_W = 3000         # one Telford element, for the demo simulation
TANK_L = 194             # Telford TSMI200H actual capacity
DEMO_SPEED = 4           # the demo world's tank loses ~9 °C/h, so demo elements heat 4× faster to keep up

DEFAULTS = {
    "boilerEfficiency": 0.85,
    "exportRateP": 15.0,          # Octopus Outgoing fixed; set yours
    "gasRateP": 8.2,              # fallback if Octopus hasn't given us one
    "loft": {"mode": "auto", "dayTargetC": 20.0, "nightTargetC": 18.0, "nightFrom": 22, "nightTo": 7,
             "acCop": 2.8, "frostC": 12.0, "preheatC": 1.0, "preheatMinutes": 90},
    "immersion": {
        "mode": "advise", "targetC": 55.0, "minC": 45.0,
        # Each element: a Home Assistant switch entity (e.g. a Sonoff via SonoffLAN) and its power
        # sensor in W. powerEntity None = derive it: switch.X → sensor.X_power (SonoffLAN's naming).
        "elements": [{"name": "Element 1", "entity": None, "powerEntity": None},
                     {"name": "Element 2", "entity": None, "powerEntity": None}],
        # Both elements together draw ~26 A. Only allow it once the electrician confirms
        # the circuit(s) can take it (two separate circuits, or one 32 A circuit).
        "bothAllowed": False,
    },
    # Home Assistant entities for special periods; None = auto-discover from the Octopus integration
    "powerDownEntity": None,
    "freePowerEntity": None,
}


def merged(cfg: dict) -> dict:
    out = copy.deepcopy(DEFAULTS)
    for k, v in (cfg or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    imm = out["immersion"]
    if imm.get("entity") and not any(e.get("entity") for e in imm["elements"]):
        imm["elements"][0]["entity"] = imm["entity"]  # old single-switch config
    return out


class OptimiserAdapter(Adapter):
    name, label, interval = "optimiser", "Cost optimiser", 60.0

    def __init__(self, cfg, hub):
        super().__init__(cfg, hub)
        self.conf = merged(cfg)
        self.live = True  # it's our own logic; "demo-ness" comes from the devices it drives
        self._ac_ours = False
        els = self.conf["immersion"]["elements"]
        # Per element: real switch state, power, and whether we (not a person) switched it on.
        self._st = [{"on": None, "watts": None, "online": None, "ours": False, "cmd": None,
                     "on_since": None, "idle_since": None, "full": False, "blocked_until": 0.0} for _ in els]
        self._pw_ids = [None] * len(els)
        self._pw_at = 0.0
        self._full_at = 0.0          # when an element last said "tank full"
        self._full_name = ""
        self._session = None         # the heat-up in progress
        # No real switches and nothing to reach them through → simulate them (demo mode)
        self.sim = not any(e.get("entity") for e in els) and (DEMO or not (hub.cfg.get("homeassistant") or {}).get("token"))
        if self.sim and "mode" not in ((cfg or {}).get("immersion") or {}):
            self.conf["immersion"]["mode"] = "auto"  # demo: let the simulated elements run
        self._last = time.time()
        self._ha_ids = {}
        self._ha_at = 0.0
        self.free_until = 0.0
        hub.optimiser_owned_zones = {"bed1"} if self.conf["loft"]["mode"] == "auto" else set()
        hub.house.optimiser = {"loft": {}, "immersion": {}, "log": [], "savedTodayP": 0.0,
                               "day": datetime.now().date().isoformat(), "period": {"kind": "normal"},
                               "hw": {"kwhToday": 0.0, "costTodayP": 0.0, "gasEquivTodayP": 0.0,
                                      "sessions": [], "current": None}}

    def status(self):
        st = super().status()
        st["mode"] = "live"
        return st

    # ---- price helpers ----------------------------------------------------
    def prices(self):
        o, e, c = self.house.octopus, self.house.energy, self.conf
        grid = o["demand_w"] if (o.get("live") and o.get("homeMini")) else e.grid_w
        exporting = grid < -300
        imp = o.get("rate_p")
        marginal = c["exportRateP"] if exporting else imp
        gas = o.get("gas_rate_p") or c["gasRateP"]
        return {"import": imp, "marginal": marginal, "exporting": exporting,
                "gasHeat": round(gas / c["boilerEfficiency"], 2), "gas": gas,
                "next": o.get("next_rate_p"), "nextAt": o.get("next_rate_at")}

    def cop(self):
        """Heat-pump COP falls as it gets colder outside."""
        out = self.house.aircon.outdoor_c
        f = max(0.6, min(1.15, 1 - 0.025 * (7 - out)))
        return round(self.conf["loft"]["acCop"] * f, 2)

    # ---- special periods ----------------------------------------------------
    def _ha(self):
        return self.hub.cfg.get("homeassistant") or {}

    def _ha_flag(self, key, pattern):
        """True if the HA entity (configured, or discovered by pattern) is 'on'."""
        ha = self._ha()
        if not ha.get("token"):
            return False
        try:
            if time.time() - self._ha_at > 600:  # re-discover every 10 min
                self._ha_at = time.time()
                for k, pat in (("powerDownEntity", r"calendar\.octopus_energy_.*_power_down"),
                               ("freePowerEntity", r"(calendar|binary_sensor)\.octopus_energy_.*free_electricity.*")):
                    self._ha_ids[k] = self.conf.get(k) or ha_find_entity(ha, pat)
            eid = self._ha_ids.get(key)
            return bool(eid) and ha_get_state(ha, eid)["state"] == "on"
        except Exception as e:
            log.info("optimiser: HA %s check failed: %s", key, e)
            return False

    def period(self, p):
        now = time.time()
        if self._ha_flag("powerDownEntity", None):
            return {"kind": "powerdown", "why": "Octoplus Power Down session: using as little electricity as possible"}
        if self.free_until > now:
            return {"kind": "free", "until": self.free_until,
                    "why": f"Free power (set on the dashboard) until {datetime.fromtimestamp(self.free_until):%H:%M}"}
        if p["import"] is not None and p["import"] <= 0:
            return {"kind": "free", "why": f"Electricity is {p['import']:.1f}p, free or paid to use"}
        if self._ha_flag("freePowerEntity", None):
            return {"kind": "free", "why": "Octopus free-electricity session"}
        return {"kind": "normal"}

    # ---- the loop ---------------------------------------------------------
    def _weather(self):
        """Real outdoor temperature (Open-Meteo, free, no key) every 15 min — the heat-pump
        COP depends on it. Skipped in demo mode, which keeps its simulated weather."""
        if not self.hub.cfg.get("octopus") or time.time() - getattr(self, "_wx_at", 0) < 900:
            return
        from adapters import http_json
        try:
            d = http_json("https://api.open-meteo.com/v1/forecast?latitude=51.40&longitude=-1.00"
                          "&current=temperature_2m&timezone=Europe%2FLondon", timeout=10)
            self.house.weather = {"outdoor_c": d["current"]["temperature_2m"], "at": time.time(), "source": "Open-Meteo"}
            self._wx_at = time.time()
        except Exception as e:
            log.info("weather fetch failed: %s", e)

    def poll(self):
        self._weather()
        now = time.time()
        dt, self._last = now - self._last, now
        opt = self.house.optimiser
        today = datetime.now().date().isoformat()
        if opt["day"] != today:
            opt.update(day=today, savedTodayP=0.0)
            opt["hw"].update(kwhToday=0.0, costTodayP=0.0, gasEquivTodayP=0.0)
        p = self.prices()
        if p["marginal"] is None:
            opt["loft"] = {"decision": "waiting", "reason": "No electricity price yet"}
            return
        per = self.period(p)
        if per["kind"] != opt.get("period", {}).get("kind"):
            opt["log"].insert(0, {"at": now, "rule": "period", "decision": per["kind"], "reason": per.get("why", "")})
            del opt["log"][20:]
        opt["period"] = per
        if per["kind"] == "free":
            p = {**p, "marginal": min(p["marginal"], 0.0)}
        self._loft(p, dt, per)
        self._immersion(p, per, dt)

    simulate = poll

    def _say(self, rule, decision):
        opt = self.house.optimiser
        prev = opt[rule].get("decision")
        opt[rule] = decision
        if prev != decision.get("decision"):
            opt["log"].insert(0, {"at": time.time(), "rule": rule, "decision": decision["decision"],
                                  "reason": decision["reason"]})
            del opt["log"][20:]
            log.info("optimiser %s → %s (%s)", rule, decision["decision"], decision["reason"])

    # ---- loft: aircon vs radiator -----------------------------------------
    def _loft(self, p, dt, per):
        c, h = self.conf["loft"], self.house
        a, zone = h.aircon, h.zones.get("bed1")
        if c["mode"] == "off" or zone is None:
            return self._say("loft", {"decision": "off", "mode": c["mode"], "reason": "Rule switched off"})
        hour = datetime.now().hour
        night = hour >= c["nightFrom"] or hour < c["nightTo"]
        target = c["nightTargetC"] if night else c["dayTargetC"]
        cop = self.cop()
        ac_p = round(p["marginal"] / cop, 2)
        gas_p = p["gasHeat"]
        cheaper = "aircon" if ac_p < gas_p else "radiator"
        preheat = False
        if per["kind"] == "powerdown":
            cheaper = "radiator"  # keep electricity use down; gas covers the loft
        elif per["kind"] == "free":
            preheat, target = True, target + c["preheatC"]  # store free heat in the room
        elif cheaper == "aircon" and p["next"] is not None and p["nextAt"]:
            # pre-heat: cheap now, but the price is about to rise above the gas equivalent
            mins = (p["nextAt"] - time.time()) / 60
            if 0 < mins <= c["preheatMinutes"] and p["next"] / cop > gas_p:
                preheat, target = True, target + c["preheatC"]
        temp = a.indoor_c
        heating_now = (a.power and a.mode == "heat" and self._ac_ours) or zone.setpoint > c["frostC"] + 0.1
        need = temp < target - 0.3 or (heating_now and temp < target + 0.3)
        manual = a.power and not self._ac_ours  # someone turned the aircon on themselves
        why = f"Aircon {ac_p:.1f}p vs gas {gas_p:.1f}p per kWh of heat (COP {cop:.1f}" + \
              (", using solar that would be exported" if p["exporting"] and per["kind"] == "normal" else "") + ")"
        if per["kind"] != "normal":
            why = per["why"] + ". " + why
        d = {"mode": c["mode"], "acP": ac_p, "gasP": gas_p, "cop": cop, "target": target, "temp": temp,
             "cheaper": cheaper, "preheat": preheat, "night": night, "period": per["kind"]}
        if manual and a.mode != "heat":
            d.update(decision="manual", reason=f"Aircon is in {a.mode} mode (set by hand), leaving it alone")
            return self._say("loft", d)
        if not need:
            d.update(decision="idle", reason=f"Loft {temp:.1f}° is at target {target:.1f}°. " + why)
            if c["mode"] == "auto":
                self._ac(False); self._zone(c["frostC"])
            return self._say("loft", d)
        if cheaper == "aircon":
            d.update(decision="aircon", reason=("Pre-heating. " if preheat and per["kind"] == "normal" else "") + why)
            if c["mode"] == "auto":
                self._ac(True, target); self._zone(c["frostC"])
                if a.power_w:
                    heat_kwh = a.power_w * cop * dt / 3.6e6
                    h.optimiser["savedTodayP"] += heat_kwh * (gas_p - ac_p)
        else:
            d.update(decision="radiator", reason=why)
            if c["mode"] == "auto":
                self._ac(False); self._zone(target)
        self._say("loft", d)

    def _ac(self, on, setpoint=None):
        a = self.house.aircon
        if on:
            if not (a.power and a.mode == "heat" and abs(a.setpoint - setpoint) < 0.1):
                self.hub.command("aircon", {"power": True, "mode": "heat", "setpoint": setpoint}, notify=False)
            self._ac_ours = True
        elif self._ac_ours:
            if a.power:
                self.hub.command("aircon", {"power": False}, notify=False)
            self._ac_ours = False

    def _zone(self, setpoint):
        z = self.house.zones["bed1"]
        if abs(z.setpoint - setpoint) >= 0.25:
            self.hub.command("heating", {"room": "bed1", "setpoint": setpoint, "mode": "auto"}, notify=False)

    # ---- hot water: two immersion elements vs gas ---------------------------
    def _discover_power(self):
        """Find each element's power sensor: configured, or switch.X → sensor.X_power
        (SonoffLAN's naming) if Home Assistant has it. Re-checked every 10 minutes."""
        if self.sim or time.time() - self._pw_at < 600:
            return
        self._pw_at = time.time()
        ha = self._ha()
        for i, e in enumerate(self.conf["immersion"]["elements"]):
            pid = e.get("powerEntity")
            if not pid:
                ent = e.get("entity") or ""
                guess = "sensor." + ent.split(".", 1)[1] + "_power" if ent.startswith("switch.") else None
                if guess and ha.get("token"):
                    try:
                        ha_get_state(ha, guess)
                        pid = guess
                    except Exception:
                        pid = None
            if pid != self._pw_ids[i] and e.get("entity"):
                log.info("immersion %s: power sensor %s", e["name"], pid or "not found")
            self._pw_ids[i] = pid

    def _read(self, dt):
        """Each element's real switch state and power (or the demo simulation),
        then who switched it, and whether its own thermostat has cut out."""
        now, ha, hw = time.time(), self._ha(), self.house.hotwater
        for i, e in enumerate(self.conf["immersion"]["elements"]):
            s = self._st[i]
            if self.sim:
                t = hw.get("temperature")
                s["online"], s["on"] = True, bool(s["cmd"])
                s["watts"] = ELEMENT_W + random.uniform(-40, 40) if s["on"] and (t is None or t < 60) else 0.0
                if s["watts"] and t is not None and not hw.get("live"):
                    hw["temperature"] = round(t + DEMO_SPEED * s["watts"] * min(dt, 120) / (TANK_L * 4186), 2)
            elif not e.get("entity"):
                s.update(on=None, watts=None, online=None)
                continue
            else:
                try:
                    state = ha_get_state(ha, e["entity"])["state"]
                except Exception as ex:
                    log.info("immersion %s: can't read %s: %s", e["name"], e["entity"], ex)
                    state = "unreachable"
                s["online"] = state in ("on", "off")
                s["on"] = state == "on" if s["online"] else None
                s["watts"] = None
                if s["online"] and self._pw_ids[i]:
                    try:
                        s["watts"] = max(0.0, float(ha_get_state(ha, self._pw_ids[i])["state"]))
                    except Exception:  # "unavailable", or HA hiccup
                        pass
            if not s["online"]:
                s.update(cmd=None, ours=False)  # power cut or Wi-Fi drop: forget what we'd set
            elif s["cmd"] is True and not s["on"]:
                # we'd switched it on and someone switched it off: respect that for a while
                s.update(cmd=None, ours=False, blocked_until=now + RETRY_S)
                log.info("immersion %s: switched off by hand, leaving it off until %s", e["name"], hm(now + RETRY_S))
            if s["on"]:
                s["on_since"] = s["on_since"] or now
                w = s["watts"]
                if w is None or w >= POWER_ON_W:
                    s["idle_since"] = None
                    if w is not None:
                        s["full"] = False
                else:
                    s["idle_since"] = s["idle_since"] or now
                    if not s["full"] and now - s["idle_since"] >= FULL_AFTER_S:
                        s["full"] = True
                        self._full_at, self._full_name = now, e["name"]
                        log.info("immersion %s: on but drawing %.0f W, its thermostat is off: tank full", e["name"], w)
            else:
                s.update(on_since=None, idle_since=None, full=False)

    def _meter(self, p, dt):
        """Real kWh and cost of hot water, from the power readings."""
        opt, now = self.house.optimiser, time.time()
        hw, dtc = opt["hw"], min(dt, 120.0)
        watts = [s["watts"] or 0.0 for s in self._st]
        total = sum(w for w in watts if w >= POWER_ON_W)
        if total < POWER_ON_W:
            if self._session:  # heat-up finished: thermostat off, or switched off
                self._session["end"] = now - dtc
                hw["sessions"].insert(0, self._session)
                del hw["sessions"][10:]
                self._session = None
            hw["current"] = None
            return
        kwh = total * dtc / 3.6e6
        cost, gas = kwh * p["marginal"], kwh * p["gasHeat"]
        hw["kwhToday"] += kwh
        hw["costTodayP"] += cost
        hw["gasEquivTodayP"] += gas
        ours = sum(w * dtc / 3.6e6 for w, s in zip(watts, self._st) if w >= POWER_ON_W and s["ours"])
        opt["savedTodayP"] += ours * (p["gasHeat"] - p["marginal"])  # unrounded: it adds up every minute
        if self._session is None:
            self._session = {"start": now - dtc, "end": None, "kwh": 0.0, "costP": 0.0, "gasEquivP": 0.0}
        self._session["kwh"] += kwh
        self._session["costP"] += cost
        self._session["gasEquivP"] += gas
        hw["current"] = self._session

    def _switch(self, i, on):
        e, s = self.conf["immersion"]["elements"][i], self._st[i]
        if not self.sim:
            try:
                ha_call(self._ha(), "switch", "turn_on" if on else "turn_off", {"entity_id": e["entity"]})
            except Exception as ex:
                log.warning("immersion %s: %s", e["name"], ex)
                return False
        s.update(cmd=on, ours=on, on=on)
        if not on:
            s.update(on_since=None, idle_since=None, full=False)
        return True

    def _immersion(self, p, per, dt=60.0):
        c, hw = self.conf["immersion"], self.house.hotwater
        els, st, now = c["elements"], self._st, time.time()
        n = len(els)
        self._discover_power()
        self._read(dt)
        self._meter(p, dt)
        connected = [self.sim or bool(e.get("entity")) for e in els]
        metered = [self.sim or bool(connected[i] and self._pw_ids[i]) for i in range(n)]
        t = hw.get("temperature")
        tank = f"Tank {t:.0f}°. " if t is not None else "No tank temperature yet. "
        elec_p, gas_p = round(p["marginal"], 2), p["gasHeat"]
        want = [False] * n
        if c["mode"] == "off":
            decision, why = "off", "Rule switched off."
        elif per["kind"] == "powerdown":
            decision, why = "powerdown", per["why"] + "."
        elif per["kind"] == "free":
            # soak it up: heat until each element's own thermostat stops it (it stays on: if the
            # tank cools, it heats again for free)
            k = n if c["bothAllowed"] else 1
            want = [i < k for i in range(n)]
            decision = "free"
            why = per["why"] + (". Both elements on." if k > 1 else
                                ". One element on: running both needs the circuit check first (immersion.bothAllowed).")
            full = [els[i]["name"] for i in range(n) if st[i]["full"]]
            if full:
                why += f" {' and '.join(full)}: tank full (its own thermostat is off), left on in case it cools."
        elif elec_p < gas_p:
            cmp = f"Immersion {elec_p:.1f}p vs gas {gas_p:.1f}p per kWh of heat" + \
                  (" (solar surplus)" if p["exporting"] else "") + "."
            heating = any(s["on"] and s["ours"] for s in st)
            if now - self._full_at < RETRY_S:
                decision = "idle"
                why = (f"Tank full at {hm(self._full_at)}: {self._full_name}'s own thermostat switched off "
                       f"(or its cut-out has tripped). Not trying again until {hm(self._full_at + RETRY_S)}. " + cmp)
            elif t is None and metered[0]:
                want[0], decision = True, "on"
                why = "Heating until the element's own thermostat says the tank is full. " + cmp
            else:
                want[0] = t is not None and (t < c["minC"] or (heating and t < c["targetC"]))
                decision = "on" if want[0] else "idle"
                why = cmp
        else:
            decision = "gas"
            why = f"Immersion {elec_p:.1f}p vs gas {gas_p:.1f}p per kWh of heat."
        for i, s in enumerate(st):  # switched off by hand: leave it off for a while
            if want[i] and s["blocked_until"] > now:
                want[i] = False
                why += f" {els[i]['name']} was switched off by hand, so it stays off until {hm(s['blocked_until'])}."
        # switched on by hand: if we'd want it on anyway, adopt it; otherwise leave it until the tank is full
        manual, done = [False] * n, [False] * n
        for i, s in enumerate(st):
            if s["on"] and not s["ours"]:
                if want[i] and c["mode"] == "auto":
                    s.update(ours=True, cmd=True)
                    continue
                manual[i] = True
                done[i] = s["full"] or (not metered[i] and t is not None and t >= c["targetC"])
        mode = c["mode"] if (c["mode"] != "auto" or any(connected)) else "advise"
        note = "" if any(connected) or c["mode"] != "auto" else " No immersion switches connected yet, so this is advice only."
        if mode == "auto":
            for i, s in enumerate(st):
                if not connected[i] or not s["online"]:
                    continue
                if manual[i]:
                    if done[i] and self._switch(i, False):
                        manual[i] = False
                        log.info("immersion %s: manual boost finished, switched off", els[i]["name"])
                elif want[i] != bool(s["on"]):
                    self._switch(i, want[i])
        if any(manual):
            names = " and ".join(els[i]["name"] for i in range(n) if manual[i])
            until = "until the tank is full (its own thermostat switches off)" if all(
                metered[i] for i in range(n) if manual[i]) else f"until the tank reaches {c['targetC']:.0f}°"
            if mode == "auto":
                why = f"{names} switched on by hand: leaving it on {until}. Otherwise: " + why
            else:
                why = f"{names} switched on by hand. " + why
            decision = "manual"
        elements = []
        for i, e in enumerate(els):
            s = st[i]
            real = bool(connected[i] and s["online"])
            w = s["watts"] if real else None
            elements.append({"name": e["name"], "want": want[i], "on": bool(s["on"]) if real else want[i],
                             "connected": connected[i], "online": s["online"], "watts": None if w is None else round(w),
                             "metered": metered[i], "full": s["full"], "manual": manual[i], "sim": self.sim})
        self._say("immersion", {"mode": mode, "elecP": elec_p, "gasP": gas_p, "temp": t, "decision": decision,
                                "elements": elements, "bothAllowed": c["bothAllowed"], "period": per["kind"],
                                "reason": (tank + why + note).strip()})

    # ---- commands from the dashboard --------------------------------------------
    def command(self, kind, body):
        if body.get("action") == "free":  # "Free power now" button
            mins = max(0, min(int(body.get("minutes", 60)), 24 * 60))
            self.free_until = time.time() + mins * 60 if mins else 0.0
            self._wake.set()
            return {"ok": True, "freeUntil": self.free_until}
        rule, mode = body["rule"], body["mode"]
        if rule not in ("loft", "immersion") or mode not in ("auto", "advise", "off"):
            raise KeyError(f"{rule}/{mode}")
        self.conf[rule]["mode"] = mode
        if rule == "loft":
            self.hub.optimiser_owned_zones = {"bed1"} if mode == "auto" else set()
            if mode != "auto":
                self._ac(False)
        if rule == "immersion" and mode != "auto":  # hand the elements back, switched off
            for i, s in enumerate(self._st):
                if s["ours"] and s["on"]:
                    self._switch(i, False)
        self._wake.set()
        return {"ok": True}


def hm(ts):
    return datetime.fromtimestamp(ts).strftime("%H:%M")
