"""Render the Nest Hub screen (1024×600) as a PNG from the house state.

Why an image: the Hub's web-page receiver can't load our plain-HTTP page, but
its built-in media player happily shows an HTTP image — silently. Needs Pillow
(installed in ~/.local/share/house/venv on the Pi) and the Inter font.
"""
from __future__ import annotations

import io
import os
import time
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

W, H = 1024, 600
FONT_DIR = os.environ.get("HOUSE_FONTS", os.path.expanduser("~/.local/share/house/fonts"))
BG = (8, 10, 13)
INK, INK2, INK3 = (242, 245, 248), (168, 177, 189), (102, 113, 127)
LIGHT, HEAT, COOL, SOLAR, BATT, GRID = (255, 181, 71), (255, 107, 74), (76, 201, 240), (255, 213, 74), (91, 227, 160), (167, 139, 250)
TILE, EDGE = (20, 24, 29), (36, 41, 48)

_fonts: dict = {}


def font(weight: str, size: int):
    key = (weight, size)
    if key not in _fonts:
        try:
            _fonts[key] = ImageFont.truetype(os.path.join(FONT_DIR, f"Inter-{weight}.ttf"), size)
        except OSError:
            _fonts[key] = ImageFont.load_default(size)
    return _fonts[key]


def kw(w):
    return f"{abs(w) / 1000:.1f} kW" if abs(w) >= 1000 else f"{round(abs(w))} W"


def deg(t):
    return "–" if t is None else f"{t:.1f}°"


def temp(S, rid):
    s = S["sensors"].get(rid) or {}
    if s.get("live") and s.get("temperature") is not None:
        return s["temperature"]
    if rid == "bed1":
        return S["aircon"]["indoor_c"]
    z = S["zones"].get(rid)
    return z["temperature"] if z else s.get("temperature")


def fit(d, text, f, maxw):
    while d.textlength(text, font=f) > maxw and len(text) > 3:
        text = text[:-2] + "…" if not text.endswith("…") else text[:-2] + "…"
    return text


def tile(d, box, label, value, sub, color, fill=TILE, edge=EDGE):
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, radius=18, fill=fill, outline=edge, width=1)
    d.text((x0 + 18, y0 + 14), label.upper(), font=font("Medium", 13), fill=INK3)
    d.text((x0 + 18, y0 + 38), value, font=font("Light", 44), fill=color)
    if sub:
        d.text((x0 + 18, y1 - 30), fit(d, sub, font("Regular", 15), x1 - x0 - 36), font=font("Regular", 15), fill=INK2)


def render(S: dict) -> bytes:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # soft warm glow top-left
    glow = Image.new("RGB", (W, H), BG)
    gd = ImageDraw.Draw(glow)
    for r in range(420, 0, -12):
        a = int(14 * (1 - r / 420))
        gd.ellipse((-r, -r, r, r), fill=(BG[0] + a, BG[1] + int(a * .7), BG[2]))
    img.paste(glow)
    d = ImageDraw.Draw(img)

    now = datetime.now()
    d.text((34, 70), now.strftime("%H:%M"), font=font("Light", 120), fill=INK)
    d.text((38, 218), now.strftime("%A %-d %B"), font=font("Regular", 24), fill=INK2)
    hr = now.hour
    d.text((38, 256), "Good morning" if hr < 12 else "Good afternoon" if hr < 18 else "Good evening",
           font=font("Regular", 20), fill=LIGHT)

    o = S.get("octopus") or {}
    rate = o.get("rate_p")
    pfill, pedge, pcol = TILE, EDGE, INK
    if rate is not None and rate < 12:
        pfill, pedge, pcol = (16, 38, 30), (52, 120, 90), BATT
    elif rate is not None and rate > 28:
        pfill, pedge, pcol = (40, 20, 17), (130, 60, 45), HEAT
    nxt = (f"{o['next_rate_p']:.1f}p from {datetime.fromtimestamp(o['next_rate_at']).strftime('%H:%M')}"
           if o.get("next_rate_p") is not None else "per kWh")
    cols = [370, 692]
    rows = [(26, 174), (188, 336), (350, 498)]
    cw = 300
    tile(d, (cols[0], rows[0][0], cols[0] + cw, rows[0][1]), "Electricity now",
         "–" if rate is None else f"{rate:.1f}p", nxt, pcol, pfill, pedge)

    w = o["demand_w"] if (o.get("live") and o.get("homeMini")) else S["energy"]["grid_w"]
    day = o.get("usage_day") or "today"
    tile(d, (cols[1], rows[0][0], cols[1] + cw, rows[0][1]), "Exporting now" if w < 0 else "Importing now",
         kw(w), f"{o.get('elec_today_kwh', 0):.1f} kWh {day}" if o.get("elec_today_kwh") else "",
         BATT if w < 0 else GRID)

    on = [l for l in S["lights"].values() if l["on"]]
    names = {r["id"]: r["name"] for f in S["layout"]["floors"] for r in f["rooms"]}
    rooms = list(dict.fromkeys(names.get(l["room"], l["room"]) for l in on))
    tile(d, (cols[0], rows[1][0], cols[0] + cw, rows[1][1]), "Lights on", str(len(on)),
         " · ".join(rooms) if rooms else "All off", LIGHT)

    hw = S["hotwater"]
    els = ((S.get("optimiser") or {}).get("immersion") or {}).get("elements") or []
    hw_w = sum(e.get("watts") or 0 for e in els if (e.get("watts") or 0) >= 50)
    tile(d, (cols[1], rows[1][0], cols[1] + cw, rows[1][1]), "Hot water", deg(hw["temperature"]),
         f"Heating {kw(hw_w)}" if hw_w else
         "Boosting" if hw.get("boost") else ("Ready" if (hw["temperature"] or 0) >= 45 else "Cool"), HEAT)

    a = S["aircon"]
    tile(d, (cols[0], rows[2][0], cols[0] + cw, rows[2][1]), "Loft", deg(a["indoor_c"]),
         f"{a['mode'].title()} to {a['setpoint']:.1f}°" if a["power"] else "Aircon off",
         HEAT if a["power"] and a["mode"] == "heat" else COOL)

    e = S["energy"]
    demo = S["integrations"].get("fox", {}).get("mode") == "demo"
    tile(d, (cols[1], rows[2][0], cols[1] + cw, rows[2][1]), "Solar & battery", kw(e["solar_w"]),
         f"Battery {round(e['soc'])}%" + (" · demo" if demo else ""), SOLAR)

    # room temperatures
    rlist = [("lounge", "Sitting room"), ("study", "Study"), ("conservatory", "Conserv."),
             ("landing", "Landing"), ("ensuite1", "Ensuite"), ("kitchen", "Kitchen")]
    for i, (rid, n) in enumerate(rlist):
        x = 38 + (i % 2) * 170
        y = 330 + (i // 2) * 52
        d.text((x, y), n, font=font("Regular", 16), fill=INK2)
        t = deg(temp(S, rid))
        d.text((x + 158 - d.textlength(t, font=font("Regular", 21)), y - 2), t, font=font("Regular", 21), fill=INK)
        d.line((x, y + 32, x + 158, y + 32), fill=EDGE, width=1)

    # today's price strip
    d.text((38, 512), "TODAY'S PRICES", font=font("Medium", 12), fill=INK3)
    t0 = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    rates = [r for r in (o.get("rates") or []) if t0 <= r[0] < t0 + 86400]
    if rates:
        mx = max(35, *(r[1] for r in rates))
        x0, x1, ybase, hmax = 38, W - 38, H - 18, 52
        bw = (x1 - x0) / 48
        nowt = time.time()
        for ts, v in rates:
            i = int((ts - t0) // 1800)
            col = BATT if v < 12 else HEAT if v > 28 else GRID
            if ts + 1800 < nowt:
                col = tuple(int(c * .4 + BG[k] * .6) for k, c in enumerate(col))
            hgt = max(4, v / mx * hmax)
            bx = x0 + i * bw
            d.rounded_rectangle((bx + 1, ybase - hgt, bx + bw - 2, ybase), radius=3, fill=col)
            if ts <= nowt < ts + 1800:
                d.rounded_rectangle((bx - 1, ybase - hgt - 2, bx + bw, ybase + 2), radius=4, outline=INK, width=2)
    if S.get("demoMode"):
        d.text((W - 70, 8), "DEMO", font=font("Medium", 12), fill=GRID)

    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()
