# Cost optimisation: what to use (researched 6 Nov 2026)

Goal: heat, cool, store and use energy the cheapest way. That covers the Fox battery, the immersion and gas for hot water, the RAC Solo in the loft against the gas boiler, and solar.

✔ = I checked it myself. Everything else comes from a research pass with sources; treat it as likely, not certain.

## Decision

**Run Home Assistant (HA) in Docker on the Pi as the energy engine, with Predbat for the battery. Keep this dashboard as the front end.**

- **Predbat:** plans battery charge, discharge and export against Octopus rates, the solar forecast and learned house load, re-planning about every 5 minutes. It supports Fox ESS and understands Intelligent Octopus Go dispatch slots (the 6-hour cap, slots priced at the cheap rate). It can also run the immersion as an "iBoost" load, and only when electricity is cheaper than gas. Very active: ✔ v9.6.5 released 4 Nov 2026. Licence: free for personal use, not OSI open source.
- **HA** is required because Predbat, the Octopus integration (BottlecapDave), `foxess_modbus`, the Wiser integration and SonoffLAN all run inside HA.
- **This dashboard** stays as it is and reads HA's API for anything HA owns.

### Alternatives considered

- **EMHASS standalone** (✔ 0.18.8, MIT licence, no HA needed). It's a good optimiser, but it has no Fox driver, doesn't handle Intelligent Go slots and forecasts no load. We'd have to write all of that ourselves, which is the reinvention you want to avoid. Its thermal model could plan loft pre-heating later.
- **evcc.** Built mainly around EV charging. Its whole-home optimiser is advisory only and needs a sponsor token.
- **Akkudoktor EOS / OpenEMS / SolarAssistant.** Aimed at Germany or other hardware, or don't support Fox.

### How to install HA

- **HA "Core" (Python venv): not possible.** ✔ HA 2026.11 needs Python ≥ 3.14.2, and the Pi (Debian 13) has 3.13.
- **HA Container (Docker): recommended.** ✔ `docker.io` 26.1 and `docker-compose` 2.26 are in Debian's repositories. It needs `sudo` once.
- **HA OS: not for now.** It takes over the whole Pi, which means moving this dashboard. Choose it only if you add a second box.

✔ The Pi has room: 3.3 GB of RAM free, 108 GB of disk free, and ports 8123/5052 are free.

**Two cautions:**
- **The Pi boots from an SD card**, and HA writes to its database constantly. Plan to move to a USB SSD. Until then, HA is set to keep only 7 days of history.
- **Predbat's learning load model (LoadML)** wants at least 3 GB of RAM for HA. Leave it off on this 4 GB Pi.

## What works when

| Now (no battery yet) | When the Fox arrives | Later |
|---|---|---|
| HA + Octopus integration: rates, Home Mini, IOG dispatch sensors, gas rate | Predbat with `fox.yaml` + `foxess_modbus` | Wiser integration once the hub is bought: the boiler setpoint becomes a control |
| **Immersion vs gas rule**: run the immersion only when electricity costs less than gas ÷ boiler efficiency (≈ 8.2p ÷ 0.85 ≈ 9.6p per kWh of heat) | Predbat **iBoost** takes over the immersion: cheapest slots plus `iboost_gas` | RAC Solo pre-heat/cool in cheap or solar windows (needs its control route, below) |
| Two Sonoff POWR320D switches for the immersion elements, via SonoffLAN (local) | | |

Hot water cost per kWh of heat:

| Source | Cost |
|---|---|
| Immersion, off-peak electricity (6.6p) | **6.6p**, so the immersion wins |
| Gas boiler (8.2p at ~85% efficiency) | **~9.6p** |
| Immersion, peak electricity (36.4p) | **36.4p**, so gas wins |

**Loft heat pump vs gas.** A heat pump beats gas when its COP (heat out per unit of electricity) exceeds the breakeven: about **0.7 off-peak**, so always worth it, and about **3.8 at peak**, so usually not. That means pre-heating the loft overnight or on solar. No project optimises an air-to-air unit against a gas boiler out of the box, so this starts as an HA automation. EMHASS's thermal model is the option if we later want it optimised properly.

## Buying caveats

- **Fox ESS:** don't count on the inverter's own network port for Modbus. Users report Fox disabling it in firmware. Budget about £20–30 for an RS485-to-Ethernet adapter (Elfin EW11 or Waveshare) on the COM port, and pick a model on `foxess_modbus`'s supported list (KH or H1-G2 for single phase). Predbat's Fox Cloud mode is the fallback.
- **Panasonic RAC Solo:** check whether it has a CN-CNT/CN-WLAN connector, which allows ESPHome local control, or a Modbus controller option. `panasonic_cc` is the cloud fallback, and an IR blaster the last resort.

## Sources

- Predbat: https://springfall2008.github.io/batpred/ · [IOG / car charging](https://springfall2008.github.io/batpred/car-charging/) · [iBoost](https://springfall2008.github.io/batpred/customisation/) · [Fox setup](https://springfall2008.github.io/batpred/inverter-setup/)
- EMHASS: https://emhass.readthedocs.io/ · [thermal](https://emhass.readthedocs.io/en/latest/section_thermal.html)
- Octopus Energy for HA: https://bottlecapdave.github.io/HomeAssistant-OctopusEnergy/
- foxess_modbus: https://github.com/nathanmarlor/foxess_modbus (and its wiki for adapters)
- SonoffLAN: https://github.com/AlexxIT/SonoffLAN ([device list](https://github.com/AlexxIT/SonoffLAN/blob/master/DEVICES.md)) · Wiser: https://github.com/asantaga/wiserHomeAssistantPlatform · Hubitat: https://github.com/jason0x43/hacs-hubitat
- evcc: https://docs.evcc.io · HA install methods: https://www.home-assistant.io/installation/

## Built so far (6 Nov 2026)

**Home Assistant** runs in Docker on the Pi at `:8123`, with the Octopus Energy integration v19.3.0. Its settings:
- Intelligent slots count as cheap only once they've started
- the 6-hour cap is enforced
- the Home Mini is read every minute

The dashboard now takes its live reading from HA's Home Mini sensor instead of polling Octopus itself. Polling from both tripped Octopus's rate limit.

**The optimiser** (`server/optimiser.py`) runs every minute and shows each decision, with its reasoning, on the dashboard's *Cost optimiser* card. Every rule has an **Auto / Advise / Off** switch.

| Rule | Chooses between | How |
|---|---|---|
| **Loft heating** | RAC Solo aircon vs the master bedroom radiator (gas, Wiser zone) | Picks whichever gives a kWh of heat for less: aircon = marginal electricity price ÷ COP; radiator = gas ÷ 0.85. The COP falls as it gets colder outside, using real outdoor temperature from Open-Meteo. Pre-heats +1 °C when cheap power ends within 90 minutes. Targets are 20 °C by day and 18 °C at night (22:00–07:00). |
| **Hot water** | Immersion vs gas | Runs the immersion only when electricity costs less than gas ÷ 0.85, heating to 55 °C and starting below 45 °C. |

The **marginal price** is the export rate while you're exporting solar (default 15p), because that's what the energy is really worth then. Otherwise it's the import rate.

You can tune everything in `config.json` → `optimiser` (see `DEFAULTS` in `optimiser.py`): `acCop`, `boilerEfficiency`, `exportRateP`, the targets, and `immersion.entity`.

**Status:**
- The loft rule acts in Auto, but the aircon and Wiser are still simulated, so nothing real moves yet.
- The immersion rule is advice only until an HA switch entity is set.
- **Predbat** (battery) waits for the Fox, and is already in `deploy/ha/compose.yaml` under the `predbat` profile.

## Hot water with two elements, free power and Power Down (6 Nov 2026)

**Hardware (bought 6 Nov 2026):** two **Sonoff POW Elite POWR320D** switches, one per 3 kW Telford element.

- **Rating:** 20 A / 4,400 W. A 3 kW element draws about 13 A, which is about 65% of that.
- **Size:** 98 × 54 × 31 mm, in a small surface box beside each 20 A double-pole switch. It doesn't fit inside the switch's back box.
- **Wiring:** switch load side → POWR320D → existing cable or flex to the element. It switches the live only; the DP switch stays the isolator.
- **Location:** rated for −10 to 40 °C ambient, so keep it out of the airing cupboard. It's 2.4 GHz Wi-Fi only.
- **Readings:** power, current, voltage and energy.

✔ **SonoffLAN** lists the POWR320D as UIID 190 with **local** control. Power, current, voltage and today's energy update locally; history comes hourly from the cloud. It needs your eWeLink login once, to fetch each device's key. Use connection mode `auto`, which is what SonoffLAN recommends.

**When setting up in eWeLink:**
- Set each switch's **power-on state to Off**, so a power cut never restarts heating at peak price.
- Name them *Immersion 1* and *Immersion 2*.

Set their switch entities in `config.json`:

```json
"optimiser": {"immersion": {"mode": "auto", "bothAllowed": false,
  "elements": [{"name": "Element 1", "entity": "switch.sonoff_xxx"},
               {"name": "Element 2", "entity": "switch.sonoff_yyy"}]}}
```

The hot-water rule checks these in order:

| Situation | Hot water | Loft |
|---|---|---|
| **Power Down** (Octoplus calendar in HA is on) | both elements **off** | aircon off, radiator (gas) heats |
| **Free power** (price ≤ 0p, an Octopus free-electricity entity in HA, or the dashboard's *Free 1h/2h/3h* button) | element 1 on, plus **element 2 too if `bothAllowed`** | aircon pre-heats +1 °C |
| Electricity cheaper than gas (÷ 0.85) | element 1 on below 45 °C, off at 55 °C | aircon vs radiator, as before |
| Otherwise | off, so gas heats the water | as before |

Notes:
- **`bothAllowed` stays false until the electrician confirms the circuit can carry about 26 A.** That needs two separate circuits, or one 32 A circuit.
- **Each element's factory thermostat still sets the safe maximum.** The switches only allow heating.
- **Switching the rule to Advise or Off turns off any element it had switched on.**

### Power readings (added 6 Nov 2026)

The optimiser reads each POWR320D's **switch state and power** from Home Assistant every minute. It finds the power sensor itself: `switch.X` becomes `sensor.X_power`, which is SonoffLAN's naming. If you renamed it, set `powerEntity`:

```json
{"name": "Element 1", "entity": "switch.sonoff_xxx", "powerEntity": "sensor.immersion_1_power"}
```

What it does with them:

| Seen | Meaning | What the optimiser does |
|---|---|---|
| Element on, drawing ~3 kW | heating | chip shows **3.0 kW**; kWh and cost are logged |
| On, but under 50 W for 3 minutes | **the element's own thermostat is off: tank full** (or its cut-out has tripped) | Normal prices: switches it off and **doesn't try again for 3 hours**. Free power: leaves it on, shown as **full**, so it heats again for free if the tank cools. |
| On, but the optimiser didn't switch it on | **switched on by hand** (eWeLink app or Alexa) | leaves it on until the tank is full (or reaches 55 °C without a power sensor), then switches it off. No "saved" credit. |
| Switched off by hand after the optimiser switched it on | you want it off | leaves it off for 3 hours |
| Switch `unavailable` | offline (power cut or Wi-Fi) | chip shows **offline**; no commands sent |

**Why tank-full detection matters:** the tank probe sits on the hot outlet pipe. With no water flowing, that pipe cools while the tank stays hot, so the "below 45 °C" trigger can fire when the tank is actually full. The element then draws nothing, the optimiser sees that within about 3 minutes, and it backs off instead of trying every minute. With power sensors and no tank probe at all, it heats until the thermostat says full.

**Cost logging:** kWh × the price at the time (the export rate while you're exporting solar; 0p in free sessions), and what gas would have cost for the same heat. The *Cost optimiser* card shows today's total and the last heat-up. Only heating the optimiser chose counts towards *Saved today*. The figures reset at midnight and on restart.

**Demo mode** (`:8081`) simulates both elements: about 3 kW each, heating the pretend tank until its thermostat stops at 60 °C. Hot water runs in Auto there. Tap *Free 1h* to watch an element run and then show **full**.

**Not yet verified on real hardware:** this was tested against a simulated Home Assistant. Check it once the Sonoffs are fitted and SonoffLAN is set up.

## The Tesla (6 Nov 2026)

The car is already linked to Octopus for Intelligent Octopus Go, so the dashboard reads it through the Octopus integration in Home Assistant. No Tesla login is needed. `server/adapters.py` → `TeslaAdapter` finds the `octopus_energy_*_intelligent_*` entities. It shows:

- **State** (Octopus's own words):
  - `SMART_CONTROL_CAPABLE`: plugged in at home, nothing scheduled
  - `SMART_CONTROL_IN_PROGRESS`: a charge is scheduled or running
  - `BOOSTING`: bump charge
  - `SMART_CONTROL_NOT_AVAILABLE`: unplugged *or away*. Octopus can't tell which.
- **Charging** = inside an Octopus dispatch slot, or a bump charge. Power comes from the Home Mini (less ~400 W background) when it's live, else about 7 kW.
- **Charge level** as Octopus last heard it (the time is shown), the planned slots, the charge target and the ready-by time.

The Tesla card can bump-charge, change the target (5% steps), change the ready-by time (04:00–11:00, as in the Octopus app), and pause smart charging. These change your real Octopus settings.

**For more** (live range, exact plug state, climate, unlocking), add Tesla's own API later. Options: Home Assistant's *Tesla Fleet* integration (free, but needs a Tesla developer app), or Teslemetry (a paid relay, simplest).

In the 3D view, the car is parked on the left as seen from the road, backed in, with the charger on the front wall the other side of the door (between the hall window and the porch). A cable shows when it's plugged in. The charge port is blue when ready and green when charging.
