"""In-memory model of the house. Adapters write to it; the UI reads it."""
from __future__ import annotations

import copy
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Light:
    id: str
    name: str
    room: str
    dimmable: bool = False
    hubitat: int | None = None
    endpoint: int | None = None
    stairs: bool = False
    assumed: bool = False
    on: bool = False
    level: int = 100
    live: bool = False  # True when backed by a real Hubitat device


@dataclass
class Zone:
    """A Wiser heating zone (one room)."""
    room: str
    name: str
    temperature: float = 19.0
    setpoint: float = 19.0
    humidity: float | None = None
    demand: int = 0  # % heat demand
    mode: str = "auto"  # auto | manual | boost | off
    live: bool = False


@dataclass
class Energy:
    solar_w: float = 0
    load_w: float = 0
    battery_w: float = 0  # +charging / -discharging
    grid_w: float = 0  # +import / -export
    soc: float = 50
    battery_kwh: float = 10.4
    today_solar_kwh: float = 0
    today_import_kwh: float = 0
    today_export_kwh: float = 0
    work_mode: str = "Self Use"
    history: list = field(default_factory=list)  # [[ts, solar, load, soc], ...]
    live: bool = False


@dataclass
class Aircon:
    power: bool = False
    mode: str = "heat"  # auto | heat | cool | dry | fan
    setpoint: float = 21.0
    fan: str = "auto"  # auto | quiet | 1..5
    swing: str = "auto"
    indoor_c: float = 20.0
    outdoor_c: float = 9.0
    power_w: float = 0
    eco: bool = False
    live: bool = False


@dataclass
class Blind:
    id: str
    name: str
    position: int = 0  # 0 = open, 100 = fully closed
    battery: int = 90
    live: bool = False


class House:
    def __init__(self, layout: dict):
        self.layout = layout
        self.lights: dict[str, Light] = {}
        self.zones: dict[str, Zone] = {}
        self.sensors: dict[str, dict] = {}  # room -> {temperature, humidity, motion}
        self.devices: dict[str, dict] = {}
        self.energy = Energy()
        self.aircon = Aircon()
        self.hotwater = {"temperature": 48.0, "boost": False, "heating": False, "live": False}
        self.blinds: dict[str, Blind] = {}
        self.optimiser = {"loft": {}, "immersion": {}, "log": [], "savedTodayP": 0.0}
        self.ev = {                     # the Tesla, as Intelligent Octopus sees it (adapters.TeslaAdapter)
            "live": False, "via": None, "name": "Tesla",
            "state": None,              # Octopus's raw state, e.g. SMART_CONTROL_CAPABLE
            "plugged": False, "charging": False, "boost": False,
            "soc": None, "soc_at": None, "target": None, "ready_by": None, "smart": None,
            "power_w": 0.0, "slot": None, "next_slot": None, "slots_kwh": 0.0,
        }
        self.octopus = {
            "live": False, "homeMini": False,
            "demand_w": 0.0,            # live grid demand (Home Mini) — +import / -export
            "rate_p": None,             # current electricity unit rate, p/kWh inc VAT
            "next_rate_p": None, "next_rate_at": None,
            "tariff": None, "gas_tariff": None,
            "gas_rate_p": None,
            "elec_today_kwh": 0.0, "elec_today_cost_p": 0.0,
            "gas_today_kwh": 0.0, "gas_today_cost_p": 0.0,
            "elec_halfhours": [],       # [[ts, kWh, p/kWh], ...] today
            "gas_halfhours": [],        # [[ts, kWh], ...] today
            "rates": [],                # [[ts_from, p/kWh], ...] today+tomorrow (Agile etc.)
            "last_reading_at": None,
            "usage_day": "today", "gas_usage_day": "today",
        }
        names = {"blind-dormer": "Dormer window", "blind-roof-l": "Rooflight left",
                 "blind-roof-r": "Rooflight right",
                 "blind-stairs-roof": "Stairwell rooflight", "blind-ensuite-roof": "Ensuite rooflight"}
        for floor in layout["floors"]:
            for r in floor["rooms"]:
                for l in r.get("lights", []):
                    self.lights[l["id"]] = Light(
                        id=l["id"], name=l["name"], room=r["id"],
                        dimmable=l.get("dimmable", False), hubitat=l.get("hubitat"),
                        endpoint=l.get("endpoint"), stairs=l.get("stairs", False),
                        assumed=l.get("assumed", False))
                if "heating" in r:
                    self.zones[r["id"]] = Zone(room=r["id"], name=r["heating"]["wiser"])
                if "sensors" in r:
                    self.sensors[r["id"]] = {}
                for d in r.get("devices", []):
                    self.devices[d["id"]] = {**d, "room": r["id"], "on": False, "live": False}
                for b in r.get("blinds", []):
                    self.blinds[b] = Blind(id=b, name=names.get(b, b))

    @classmethod
    def from_layout(cls, path: Path) -> "House":
        return cls(json.loads(Path(path).read_text()))

    def to_dict(self) -> dict:
        return {
            "layout": self.layout,
            "lights": {k: asdict(v) for k, v in self.lights.items()},
            "zones": {k: asdict(v) for k, v in self.zones.items()},
            "sensors": copy.deepcopy(self.sensors),
            "devices": copy.deepcopy(self.devices),
            "energy": asdict(self.energy),
            "aircon": asdict(self.aircon),
            "hotwater": dict(self.hotwater),
            "blinds": {k: asdict(v) for k, v in self.blinds.items()},
            "octopus": copy.deepcopy(self.octopus),
            "optimiser": copy.deepcopy(self.optimiser),
            "ev": copy.deepcopy(self.ev),
        }
