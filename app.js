/* 32 Demo Drive — dashboard. Vanilla JS, no build step. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const kw = (w) => Math.abs(w) >= 1000 ? (w / 1000).toFixed(2) + " kW" : Math.round(w) + " W";
const deg = (t) => (t == null ? "–" : (+t).toFixed(1) + "°");

let S = null;               // latest state from server
let floor = localStorage.getItem("floor") || "house";   // "house" = whole-house 3D view
let selectedRoom = null;
let view = localStorage.getItem("view") || "3d";         // "3d" (orbit) or "plan" (the same model from straight above)
let h3 = null, h3state = "idle";                         // web/house3d.js: idle | loading | ready | failed
let pending = 0;            // suppress SSE redraw flicker while sliders move

// ------------------------------------------------------------------ API
async function api(kind, body) {
  try {
    const r = await fetch(`/api/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  } catch (e) { toast("⚠ " + e.message); throw e; }
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (ev) => { S = JSON.parse(ev.data); scheduleRender(); };
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}

// Coalesce bursts of server updates: at most one redraw per ~400 ms, on an animation frame.
let renderQueued = false, lastRender = 0;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const wait = Math.max(0, 400 - (performance.now() - lastRender));
  setTimeout(() => requestAnimationFrame(() => {
    renderQueued = false;
    if (pending) return scheduleRender(); // a slider is being dragged; try again shortly
    lastRender = performance.now(); render();
  }), wait);
}

// ------------------------------------------------------------------ helpers
const rooms = () => S.layout.floors.flatMap((f) => f.rooms.map((r) => ({ ...r, floor: f.id })));
const roomById = (id) => rooms().find((r) => r.id === id);
const lightsIn = (rid) => Object.values(S.lights).filter((l) => l.room === rid);
const roomTemp = (rid) => (rid === "tank" ? S.hotwater?.temperature : null) ??  // the tank "room" shows the hot water
  (S.sensors[rid]?.live ? S.sensors[rid].temperature : null) ?? S.zones[rid]?.temperature ?? S.sensors[rid]?.temperature ??
  (rid === "bed1" ? S.aircon.indoor_c : null);

function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0; a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  a /= 2; return [cx / (6 * a), cy / (6 * a)];
}
const LABEL = {}; // hand-placed labels for awkward shapes, e.g. { kitchen: [560, 735] }

// ------------------------------------------------------------------ render
function render() {
  if (!S) return;
  renderTop(); renderTabs(); renderHouse(); renderFloorLights(); renderEnergy();
  renderLoft(); renderHeating(); renderOctopus(); renderOptimiser(); renderCar(); renderIntegrations();
  if (selectedRoom) renderDrawer(selectedRoom);
}

function renderTop() {
  $("#demo-ribbon").hidden = !S.demoMode;
  if (window.HOUSE_STATIC) $("#real-link").hidden = true;   // the public demo site: there's no real house behind it
  else if (S.demoMode) $("#real-link").href = `${location.protocol}//${location.hostname}:${location.protocol === "https:" ? 8443 : 8080}/`;
  document.title = S.demoMode ? "32 Demo Drive · DEMO" : "32 Demo Drive";
  const on = Object.values(S.lights).filter((l) => l.on).length;
  $("#t-lights").textContent = on;
  $("#t-solar").textContent = kw(S.energy.solar_w);
  $("#t-soc").textContent = Math.round(S.energy.soc) + "%";
  $("#t-outside").textContent = deg(S.aircon.outdoor_c);
}

function tick() {
  const d = new Date();
  $("#clock-time").textContent = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $("#clock-date").textContent = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const hr = d.getHours();
  $("#greeting").textContent = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
}

const engine3d = () => h3state !== "failed";                  // the 3D model draws both views when it can
const is3d = () => view === "3d" && engine3d();                 // orbiting 3D (has the whole-house view)
const planFloor = () => (floor === "house" ? "ground" : floor);  // plans are per floor, plus the roof
const floor3d = () => (floor === "roof" ? "house" : floor);       // in 3D the whole house shows the roof
const svgFloor = () => (S.layout.floors.some((f) => f.id === floor) ? floor : "ground");  // the flat fallback plan

function renderTabs() {
  const el = $("#floor-tabs"); el.innerHTML = "";
  const tabs = [...S.layout.floors].reverse().map((f) => [f.id, f.name.replace(" floor", "")]);
  if (is3d()) tabs.unshift(["house", "House"]);
  else if (engine3d()) tabs.unshift(["roof", "Roof"]);
  const cur = is3d() ? floor3d() : engine3d() ? planFloor() : svgFloor();
  for (const [id, name] of tabs) {
    el.append(h("button", { class: id === cur ? "on" : "", role: "tab",
      onclick: () => { floor = id; localStorage.setItem("floor", floor); render(); } }, name));
  }
  const vt = $("#view-tog"); vt.innerHTML = "";
  for (const [id, name] of [["3d", "3D"], ["plan", "Plan"]]) {
    vt.append(h("button", { class: id === view ? "on" : "", title: id === "3d" ? "3D model you can turn" : "The model from straight above, one floor at a time",
      onclick: () => { view = id; localStorage.setItem("view", view); if (h3state === "failed") h3state = "idle"; render(); } }, name));
  }
}

// The house view: the 3D model (web/house3d.js) for both 3D and Plan; the flat SVG plan only if the model can't load.
function renderHouse() {
  if (engine3d() && h3state === "idle") {
    h3state = "loading";
    House3D.load().then(() => {
      $("#h3d").style.display = ""; $("#plan").style.display = "none";  // mount needs a sized box
      h3 = House3D.mount($("#h3d"), {
        onRoom: openRoom, onCar: () => $("#car-card").scrollIntoView({ behavior: "smooth", block: "center" }),
        onLight: (id, on) => { const l = S.lights[id]; if (!l) return; setLight(l, { on }); toast(`${roomById(l.room).name} · ${l.name} ${on ? "on" : "off"}`); },
        onSetpoint: async (rid, sp) => { const z = S.zones[rid]; if (!z) return; sp = Math.max(5, Math.min(30, sp)); z.setpoint = sp; render();
          toast(`${roomById(rid).name} set to ${sp.toFixed(1)}°`); try { await api("heating", { room: rid, setpoint: sp }); } catch (e) {} },
        onBlind: async (id, pos) => { const b = S.blinds[id]; if (!b) return; b.position = pos; render();
          toast(`${b.name}: ${pos === 0 ? "open" : pos >= 100 ? "closed" : pos + "% closed"}`); try { await api("blinds", { id, position: pos }); } catch (e) {} },
      });
      h3state = "ready"; render();
    }).catch((e) => { console.warn(e); h3state = "failed"; toast("The 3D view couldn't load, so here's the flat plan"); render(); });
  }
  const flat = h3state === "failed";   // the flat plan only if the 3D model can't load; while it loads, its own box waits
  $("#h3d").style.display = flat ? "none" : "";
  $("#plan").style.display = flat ? "" : "none";
  $(".plan-legend").style.display = flat ? "" : "none";
  if (h3state === "ready") h3.update(S, { floor: view === "plan" ? planFloor() : floor3d(), mode: view, selected: selectedRoom, temp: roomTemp });
  else if (flat) renderPlan();
}

function renderPlan() {
  const f = S.layout.floors.find((x) => x.id === svgFloor());
  const p = $("#plan"); p.innerHTML = ""; p.setAttribute("viewBox", f.viewBox);
  const defs = svg("defs", {}, p);
  const g = svg("radialGradient", { id: "glow" }, defs);
  svg("stop", { offset: "0%", "stop-color": "#ffb547", "stop-opacity": ".55" }, g);
  svg("stop", { offset: "70%", "stop-color": "#ffb547", "stop-opacity": ".08" }, g);
  svg("stop", { offset: "100%", "stop-color": "#ffb547", "stop-opacity": "0" }, g);

  if (f.roof) {
    const pts = f.roof.map((q) => q.join(",")).join(" ");
    svg("polygon", { class: "roof", points: pts }, p);
    const [x0, y0] = f.roof[0], [x1, y1] = f.roof[2];
    svg("line", { class: "roof", x1: x0, y1: y0, x2: x1, y2: y1 }, p);
    svg("line", { class: "roof", x1: x1, y1: y0, x2: x0, y2: y1 }, p);
    const t = svg("text", { class: "roof-label", x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 40 }, p);
    t.textContent = "CONSERVATORY ROOF";
  }

  for (const r of f.rooms) {
    const lights = lightsIn(r.id);
    const lit = lights.some((l) => l.on);
    const zone = S.zones[r.id];
    const grp = svg("g", { class: `room${lit ? " lit" : ""}${selectedRoom === r.id ? " selected" : ""}`,
      tabindex: 0, role: "button", "aria-label": r.name }, p);
    grp.addEventListener("click", () => openRoom(r.id));
    grp.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && openRoom(r.id));
    const pts = r.shape.map((q) => q.join(",")).join(" ");
    svg("polygon", { class: "room-fill", points: pts }, grp);
    const [cx, cy] = LABEL[r.id] || centroid(r.shape);
    const xs = r.shape.map((q) => q[0]), ys = r.shape.map((q) => q[1]);
    const rr = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * .7;
    const clip = svg("clipPath", { id: `clip-${r.id}` }, defs);
    svg("polygon", { points: pts }, clip);
    svg("circle", { class: "room-glow", cx, cy, r: rr, "clip-path": `url(#clip-${r.id})` }, grp);

    if (r.stairs) {
      const [[sx0, sy0], [sx1, sy1]] = r.stairs, st = svg("g", { class: "stairs" }, grp);
      const vertical = (sy1 - sy0) > (sx1 - sx0), n = 7;
      for (let i = 0; i <= n; i++) {
        if (vertical) { const y = sy0 + (sy1 - sy0) * i / n; svg("line", { x1: sx0, y1: y, x2: sx1, y2: y }, st); }
        else { const x = sx0 + (sx1 - sx0) * i / n; svg("line", { x1: x, y1: sy0, x2: x, y2: sy1 }, st); }
      }
    }
    for (const w of r.windows || []) {
      const [x, y, wd, ht] = w.rect, b = S.blinds[w.id];
      svg("rect", { class: "window", x, y, width: wd, height: ht, rx: 3 }, grp);
      if (b) svg("rect", { class: "window-shade", x: x + 2, y: y + 2, width: wd - 4, height: Math.max(0, (ht - 4) * b.position / 100) }, grp);
    }
    svg("polygon", { class: "room-wall", points: pts }, grp);

    const small = (Math.max(...xs) - Math.min(...xs)) < 120;
    const name = svg("text", { class: "room-name", x: cx, y: cy - (small ? 4 : 8), style: small ? "font-size:15px" : "" }, grp);
    name.textContent = r.name;
    const t = roomTemp(r.id);
    const subTxt = [t != null ? deg(t) : null, zone && zone.demand > 0 ? "heating" : null].filter(Boolean).join(" · ");
    if (subTxt) {
      const sub = svg("text", { class: `room-sub${zone?.demand > 0 ? " heat" : ""}`, x: cx, y: cy + (small ? 13 : 18) }, grp);
      sub.textContent = subTxt;
    }
    // bulbs row
    const bw = 20, start = cx - (lights.length - 1) * bw / 2;
    lights.forEach((l, i) => {
      const bg = svg("g", { class: `bulb${l.on ? " on" : ""}` }, grp);
      svg("circle", { cx: start + i * bw, cy: cy + (small ? 30 : 40), r: 6 }, bg);
      if (!l.live) svg("circle", { class: "sim-dot", cx: start + i * bw + 5, cy: cy + (small ? 24 : 34), r: 2.4 }, bg);
    });
  }
}

function renderFloorLights() {
  const el = $("#floor-lights"); el.innerHTML = "";
  const whole = engine3d() && ((is3d() && floor3d() === "house") || (!is3d() && floor === "roof"));  // whole house: just the lights that are on
  const f = S.layout.floors.find((x) => x.id === svgFloor());
  const ids = new Set(f.rooms.map((r) => r.id));
  const ls = Object.values(S.lights).filter((l) => whole ? l.on : ids.has(l.room));
  if (whole && !ls.length) el.append(h("span", { class: "muted" }, "All lights are off. Pick a floor to switch some on."));
  for (const l of ls) {
    el.append(h("button", { class: `lchip${l.on ? " on" : ""}`, onclick: () => setLight(l, { on: !l.on }) },
      h("span", { class: "b" }), l.name, h("span", { class: "r" }, roomById(l.room).name)));
  }
  if (ls.some((l) => l.on))
    el.append(h("button", { class: "lchip alloff", onclick: () => ls.filter((l) => l.on).forEach((l) => setLight(l, { on: false })) }, "All off"));
}

async function setLight(l, body) {
  Object.assign(S.lights[l.id], body);
  if ("level" in body) S.lights[l.id].on = body.level > 0;
  render();
  await api("light", { id: l.id, ...body });
}

// ------------------------------------------------------------------ energy
function renderEnergy() {
  const e = { ...S.energy }, f = $("#flow"); f.innerHTML = "";
  if (S.octopus?.live && S.octopus.homeMini) e.grid_w = S.octopus.demand_w; // real meter beats simulator
  setBadge("#fox-badge", S.integrations.fox);
  const C = [180, 125];
  const nodes = {
    solar: { x: 180, y: 34, c: "var(--solar)", k: "Solar", v: e.solar_w, flow: e.solar_w },
    grid: { x: 46, y: 125, c: "var(--grid)", k: e.grid_w >= 0 ? "Import" : "Export", v: Math.abs(e.grid_w), flow: e.grid_w },
    house: { x: 314, y: 125, c: "var(--house)", k: "House", v: e.load_w, flow: -e.load_w },
    battery: { x: 180, y: 216, c: "var(--battery)", k: `Battery ${Math.round(e.soc)}%`, v: Math.abs(e.battery_w), flow: -e.battery_w },
  };
  for (const n of Object.values(nodes)) {
    const d = `M${n.x},${n.y} L${C[0]},${C[1]}`;
    svg("path", { class: "wire", d }, f);
    if (Math.abs(n.flow) > 15) {
      const pth = svg("path", { class: `pulse${n.flow < 0 ? " rev" : ""}`, d, stroke: n.c }, f);
      pth.style.animationDuration = Math.max(.35, 2.2 - Math.abs(n.flow) / 2000) + "s";
    }
  }
  svg("circle", { cx: C[0], cy: C[1], r: 5, fill: "#fff", opacity: .5 }, f);
  for (const n of Object.values(nodes)) {
    const g = svg("g", { class: "node" }, f);
    svg("circle", { cx: n.x, cy: n.y, r: 30, stroke: n.c }, g);
    const v = svg("text", { class: "v", x: n.x, y: n.y + 4 }, g); v.textContent = kw(n.v).replace(" ", "");
    const k = svg("text", { class: "k", x: n.x, y: n.y + (n.y > 150 ? 46 : n.y < 60 ? -38 : 46) }, g); k.textContent = n.k;
  }
  // SoC ring on battery node
  const b = nodes.battery, R = 34, circ = 2 * Math.PI * R;
  svg("circle", { cx: b.x, cy: b.y, r: R, fill: "none", stroke: "var(--battery)", "stroke-width": 3,
    "stroke-dasharray": `${circ * e.soc / 100} ${circ}`, transform: `rotate(-90 ${b.x} ${b.y})`, opacity: .9, "stroke-linecap": "round" }, f);

  $("#k-gen").textContent = e.today_solar_kwh.toFixed(1) + " kWh";
  $("#k-imp").textContent = e.today_import_kwh.toFixed(1) + " kWh";
  $("#k-exp").textContent = e.today_export_kwh.toFixed(1) + " kWh";
  $("#k-mode").textContent = e.work_mode;
  renderHistory(e.history);
}

function renderHistory(hist) {
  const el = $("#history"); el.innerHTML = "";
  const W = 360, H = 120, m = new Date(); m.setHours(0, 0, 0, 0);
  const t0 = m.getTime() / 1000, x = (t) => (t - t0) / 86400 * W;
  const pts = hist.filter((p) => p[0] >= t0);
  const maxW = Math.max(3000, ...pts.map((p) => Math.max(p[1], p[2])));
  const y = (w) => H - 8 - (w / maxW) * (H - 18), ys = (s) => H - 8 - (s / 100) * (H - 18);
  for (const hr of [6, 12, 18]) {
    svg("line", { x1: x(t0 + hr * 3600), x2: x(t0 + hr * 3600), y1: 0, y2: H - 8, stroke: "rgba(255,255,255,.05)" }, el);
    const t = svg("text", { x: x(t0 + hr * 3600) + 3, y: H - 1, fill: "var(--ink3)", "font-size": 8 }, el); t.textContent = `${hr}:00`;
  }
  if (pts.length < 2) return;
  const defs = svg("defs", {}, el), lg = svg("linearGradient", { id: "sg", x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
  svg("stop", { offset: 0, "stop-color": "#ffd54a", "stop-opacity": .55 }, lg);
  svg("stop", { offset: 1, "stop-color": "#ffd54a", "stop-opacity": 0 }, lg);
  const line = (fn) => pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${fn(p).toFixed(1)}`).join("");
  svg("path", { d: line((p) => y(p[1])) + `L${x(pts.at(-1)[0])},${H - 8}L${x(pts[0][0])},${H - 8}Z`, fill: "url(#sg)" }, el);
  svg("path", { d: line((p) => y(p[1])), fill: "none", stroke: "var(--solar)", "stroke-width": 1.5 }, el);
  svg("path", { d: line((p) => y(p[2])), fill: "none", stroke: "var(--house)", "stroke-width": 1, opacity: .6 }, el);
  svg("path", { d: line((p) => ys(p[3])), fill: "none", stroke: "var(--battery)", "stroke-width": 1.5, "stroke-dasharray": "3 3" }, el);
  const nx = x(pts.at(-1)[0]);
  svg("line", { x1: nx, x2: nx, y1: 0, y2: H - 8, stroke: "rgba(255,255,255,.25)" }, el);
}

// ------------------------------------------------------------------ loft
const MODES = [["heat", "Heat", "var(--heat)"], ["cool", "Cool", "var(--cool)"], ["auto", "Auto", "#c4b5fd"], ["dry", "Dry", "#7dd3fc"], ["fan", "Fan", "#e5e7eb"]];
const FANS = ["auto", "quiet", "1", "2", "3", "4", "5"];

function renderLoft() {
  const a = S.aircon; setBadge("#ac-badge", S.integrations.aircon);
  const accent = MODES.find((m) => m[0] === a.mode)?.[2] || "var(--heat)";
  $(".loft-card").style.setProperty("--accent", accent);
  // dial: 16–30 °C over 270°
  const d = $("#dial"); d.innerHTML = "";
  const cx = 100, cy = 100, R = 84, a0 = 135, span = 270;
  const pt = (ang, r = R) => [cx + r * Math.cos(ang * Math.PI / 180), cy + r * Math.sin(ang * Math.PI / 180)];
  const arc = (from, to, r = R) => { const [x0, y0] = pt(from, r), [x1, y1] = pt(to, r); return `M${x0},${y0} A${r},${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1},${y1}`; };
  svg("path", { d: arc(a0, a0 + span), stroke: "rgba(255,255,255,.08)", "stroke-width": 12, fill: "none", "stroke-linecap": "round" }, d);
  const frac = (t) => (Math.min(30, Math.max(16, t)) - 16) / 14;
  const setAng = a0 + span * frac(a.setpoint);
  if (a.power) svg("path", { d: arc(a0, setAng), stroke: accent, "stroke-width": 12, fill: "none", "stroke-linecap": "round", style: `filter: drop-shadow(0 0 6px ${accent})` }, d);
  const [kx, ky] = pt(setAng); svg("circle", { cx: kx, cy: ky, r: 9, fill: "#fff" }, d);
  const [nx, ny] = pt(a0 + span * frac(a.indoor_c), R - 18); svg("circle", { cx: nx, cy: ny, r: 3.5, fill: "var(--ink2)" }, d);
  for (let t = 16; t <= 30; t += 2) { const [x0, y0] = pt(a0 + span * frac(t), R + 10), [x1, y1] = pt(a0 + span * frac(t), R + 14); svg("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: "rgba(255,255,255,.2)" }, d); }

  $("#ac-set").textContent = a.power ? a.setpoint.toFixed(1) + "°" : "Off";
  $("#ac-now").textContent = `Room ${deg(a.indoor_c)}${a.power && a.power_w ? " · " + kw(a.power_w) : ""}`;
  $("#ac-power").classList.toggle("on", a.power);
  const mEl = $("#ac-modes"); mEl.innerHTML = "";
  for (const [m, label] of MODES) mEl.append(h("button", { class: a.mode === m && a.power ? "on" : "", onclick: () => ac({ mode: m, power: true }) }, label));
  const fEl = $("#ac-fan"); fEl.innerHTML = "";
  for (const fn of FANS) fEl.append(h("button", { class: a.fan === fn ? "on" : "", onclick: () => ac({ fan: fn }) }, fn === "auto" ? "Auto" : fn === "quiet" ? "Quiet" : fn));

  const surplus = S.energy.solar_w - S.energy.load_w;
  const hint = $("#ac-hint");
  if (surplus > 800 && !a.power) { hint.textContent = `☀︎ ${kw(surplus)} solar surplus — a good time to pre-heat or cool the loft for free.`; hint.classList.add("show"); }
  else if (a.power && S.energy.soc < 20 && S.energy.solar_w < 200) { hint.textContent = "Battery low and no sun — aircon is running from the grid."; hint.classList.add("show"); }
  else hint.classList.remove("show");

  const bl = $("#blind-list"); bl.innerHTML = "";
  for (const b of Object.values(S.blinds)) {
    const r = h("input", { type: "range", min: 0, max: 100, step: 5, value: b.position, style: `--p:${b.position}%;--fill:var(--cool)`, "aria-label": b.name });
    r.addEventListener("input", () => { pending++; r.style.setProperty("--p", r.value + "%"); r.closest(".blind").querySelector(".pct").textContent = r.value + "%"; });
    r.addEventListener("change", async () => { pending = 0; S.blinds[b.id].position = +r.value; await api("blinds", { id: b.id, position: +r.value }); });
    bl.append(h("div", { class: "blind" },
      h("div", { class: "win" }, h("i", { style: `height:${b.position}%` })),
      h("div", { class: "nm" }, b.name, h("small", {}, `Solar · battery ${b.battery}%`), r),
      h("div", { class: "pct" }, b.position + "%")));
  }
}
async function ac(body) { Object.assign(S.aircon, body); render(); await api("aircon", body); }

// ------------------------------------------------------------------ heating
function renderHeating() {
  setBadge("#wiser-badge", S.integrations.wiser);
  const hw = S.hotwater, el = $("#hw"); el.innerHTML = "";
  const pct = Math.max(5, Math.min(100, (hw.temperature - 20) / 40 * 100));
  el.append(
    h("div", { class: "tank" }, h("i", { style: `height:${pct}%` })),
    h("div", { class: "t" }, h("b", {}, deg(hw.temperature)), h("small", {}, `Hot water · ${hw.boost ? "boosting" : hw.heating ? "heating" : "idle"}${hw.live ? "" : " · demo"}`)),
    h("button", { class: `boost${hw.boost ? " on" : ""}`, onclick: async () => { hw.boost = !hw.boost; render(); await api("heating", { hotwater: hw.boost }); } }, hw.boost ? "Boosting" : "Boost 30 min"));
  const zs = $("#zones"); zs.innerHTML = "";
  for (const z of Object.values(S.zones)) {
    const room = roomById(z.room);
    const bump = (d) => async (ev) => { ev.stopPropagation(); z.setpoint = Math.max(5, Math.min(30, z.setpoint + d)); render(); await api("heating", { room: z.room, setpoint: z.setpoint }); };
    zs.append(h("div", { class: `zone${z.demand > 0 ? " heating" : ""}`, onclick: () => openRoom(z.room) },
      h("div", { class: "zn" }, room.name),
      h("div", { class: "zt" }, deg(z.temperature)),
      h("div", { class: "zctl" }, h("button", { onclick: bump(-0.5), "aria-label": "Lower" }, "−"),
        h("span", { class: "zsp" }, "→ " + deg(z.setpoint)), h("button", { onclick: bump(0.5), "aria-label": "Raise" }, "+")),
      h("div", { class: "bar", style: `width:${z.demand}%` })));
  }
}


// ------------------------------------------------------------------ octopus
const pounds = (p) => "£" + (p / 100).toFixed(2);
function renderOctopus() {
  const o = S.octopus; if (!o) return;
  setBadge("#octo-badge", S.integrations.octopus);
  const exp = o.demand_w < 0;
  $(".octo-demand").classList.toggle("export", exp);
  $("#o-dir").textContent = exp ? "Exporting now" : "Importing now";
  $("#o-demand").textContent = kw(Math.abs(o.demand_w));
  $("#o-mini").textContent = o.homeMini ? "Live from smart meter · Home Mini" : "Live needs an Octopus Home Mini";
  const chip = $("#o-rate-chip");
  chip.classList.toggle("cheap", o.rate_p != null && o.rate_p < 12);
  chip.classList.toggle("peak", o.rate_p != null && o.rate_p > 28);
  $("#o-rate").textContent = o.rate_p == null ? "–" : o.rate_p.toFixed(1) + "p";
  $("#o-next").textContent = o.next_rate_p == null ? "per kWh" :
    `then ${o.next_rate_p.toFixed(1)}p at ${new Date(o.next_rate_at * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  const dayLbl = (d) => d && d !== "today" ? d : "today";
  $(".tile.elec span").textContent = `Electricity ${dayLbl(o.usage_day)}`;
  $(".tile.gas span").textContent = `Gas ${dayLbl(o.gas_usage_day)}`;
  $("#o-ekwh").textContent = o.elec_today_kwh.toFixed(1) + " kWh";
  $("#o-ecost").textContent = pounds(o.elec_today_cost_p) + (o.usage_day === "today" ? " so far" : "");
  $("#o-gkwh").textContent = o.gas_today_kwh.toFixed(1) + " kWh";
  $("#o-gcost").textContent = pounds(o.gas_today_cost_p) + (o.gas_rate_p ? ` · ${o.gas_rate_p.toFixed(1)}p/kWh` : "");

  const el = $("#o-rates"); el.innerHTML = "";
  const m = new Date(); m.setHours(0, 0, 0, 0); const t0 = m.getTime() / 1000;
  const rates = o.rates.filter((r) => r[0] >= t0 && r[0] < t0 + 86400);
  if (rates.length > 1) {
    const W = 360, H = 90, bw = W / 48, max = Math.max(35, ...rates.map((r) => r[1])), min = Math.min(0, ...rates.map((r) => r[1]));
    const y = (v) => H - 12 - (v - min) / (max - min) * (H - 20);
    const now = Date.now() / 1000;
    for (const [ts, v] of rates) {
      const i = Math.round((ts - t0) / 1800), col = v < 12 ? "var(--battery)" : v > 28 ? "var(--heat)" : "var(--grid)";
      svg("rect", { x: i * bw + .6, y: y(v), width: bw - 1.2, height: Math.max(1, y(min) - y(v)), rx: 1.5, fill: col,
        opacity: ts + 1800 < now ? .35 : (ts <= now ? 1 : .75) }, el);
    }
    for (const hr of [6, 12, 18]) { const t = svg("text", { x: hr * 2 * bw + 2, y: H - 1, fill: "var(--ink3)", "font-size": 8 }, el); t.textContent = hr + ":00"; }
    const nx = (now - t0) / 1800 * bw; svg("line", { x1: nx, x2: nx, y1: 0, y2: H - 10, stroke: "#fff", opacity: .5 }, el);
  }
  const tariff = o.tariff?.includes("IOG") ? "Intelligent Octopus Go" : (o.tariff || "").replace(/^E-1R-|-[A-P]( \(demo\))?$/g, "");
  $("#o-foot").textContent = `Tariff ${tariff || "—"}. Half-hourly meter data from Octopus usually lags by a few hours to a day; the live figure needs a Home Mini.`;
}


// ------------------------------------------------------------------ optimiser
const RULE_TXT = {
  loft: { title: "Loft heating", icons: { aircon: "❄︎", radiator: "♨︎", idle: "✓", manual: "✋", off: "–", waiting: "…" },
    head: { aircon: "Heating with the aircon", radiator: "Heating with the radiator (gas)", idle: "Warm enough", manual: "Aircon set by hand", off: "Rule off", waiting: "Waiting for prices" } },
  immersion: { title: "Hot water", icons: { on: "⚡︎", free: "⚡︎", gas: "♨︎", idle: "✓", powerdown: "⏸", manual: "✋", off: "–" },
    head: { on: "Immersion heating the tank", free: "Soaking up free power", gas: "Gas is cheaper, immersion off",
            idle: "Electric is cheaper, tank warm enough", powerdown: "Paused for Power Down",
            manual: "Immersion switched on by hand", off: "Rule off" } },
  period: { title: "Power", head: { normal: "Normal prices", free: "Free power", powerdown: "Power Down session" } },
};
function renderOptimiser() {
  const o = S.optimiser; if (!o) return;
  const watts = (w) => w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`;
  const pence = (p) => Math.abs(p) >= 100 ? pounds(p) : `${Math.round(p)}p`;
  const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  // One chip per immersion element: real state and power once its Sonoff is connected, advice before that
  function elementChip(e) {
    let txt, cls = "", tip = e.sim ? "Simulated (demo)" : "";
    if (!e.connected) { txt = e.on ? "on" : "off"; cls = `${e.on ? "on" : ""} nc`; tip = "Not connected yet: advice only"; }
    else if (e.online === false) { txt = "offline"; cls = "offline"; tip = "Home Assistant can't reach this switch"; }
    else if (e.full) { txt = "full"; cls = "full"; tip = "On, but its own thermostat has switched off: the tank is full"; }
    else if (e.on) {
      txt = e.watts == null ? "on" : watts(e.watts); cls = "on";
      if (e.manual) { txt = `by hand · ${txt}`; cls += " manual"; tip = "Switched on by hand"; }
    } else txt = "off";
    return h("span", { class: cls, title: tip }, `${e.name}: ${txt}`);
  }
  // "Today 4.2 kWh · 28p (gas would be 40p)" and the current or last heat-up
  function hotWaterUse(hw) {
    if (!hw || !(hw.kwhToday > 0.01 || hw.current || hw.sessions?.length)) return null;
    const parts = [];
    if (hw.kwhToday > 0.01) parts.push(`Today ${hw.kwhToday.toFixed(1)} kWh · ${pence(hw.costTodayP)} (gas would be ${pence(hw.gasEquivTodayP)})`);
    const s = hw.current || hw.sessions?.[0];
    if (s) parts.push(hw.current ? `Heating since ${hhmm(s.start)} · ${s.kwh.toFixed(1)} kWh so far`
      : `Last heat-up ${hhmm(s.start)}–${hhmm(s.end)} · ${s.kwh.toFixed(1)} kWh · ${pence(s.costP)}`);
    return h("div", { class: "use" }, parts.join(". "));
  }
  $("#opt-saved").textContent = `Saved today ${pounds(o.savedTodayP || 0)}`;
  const per = o.period || { kind: "normal" }, pe = $("#opt-period");
  pe.className = `opt-period ${per.kind}`; pe.innerHTML = "";
  const manualFree = per.kind === "free" && per.until;
  pe.append(h("span", {}, per.kind === "normal" ? "Normal prices. If Octopus gives you free power, tell the house:" : per.why),
    h("div", { class: "btns" }, manualFree
      ? h("button", { class: "chip", onclick: async () => { await api("optimiser", { action: "free", minutes: 0 }); toast("Free power cancelled"); } }, "Cancel")
      : per.kind === "normal" ? [1, 2, 3].map((hr) => h("button", { class: "chip", onclick: async () => {
          await api("optimiser", { action: "free", minutes: hr * 60 }); toast(`Free power for ${hr} h`); } }, `Free ${hr}h`)) : null));
  const el = $("#opt-rules"); el.innerHTML = "";
  for (const rule of ["loft", "immersion"]) {
    const d = o[rule] || {}, t = RULE_TXT[rule], dec = d.decision || "waiting";
    const elecKey = rule === "loft" ? "acP" : "elecP", elecLbl = rule === "loft" ? "Aircon" : "Immersion";
    const vs = d.gasP != null ? h("div", { class: "vs" },
      h("span", { class: d[elecKey] < d.gasP ? "win" : "" }, `${elecLbl} ${d[elecKey].toFixed(1)}p`),
      h("span", { class: d[elecKey] >= d.gasP ? "win" : "" }, `Gas ${d.gasP.toFixed(1)}p`),
      rule === "loft" && d.target != null ? h("span", {}, `Target ${d.target.toFixed(1)}°${d.preheat ? " · pre-heat" : ""}`) : null) : null;
    const seg = h("div", { class: "seg small" }, ...["auto", "advise", "off"].map((m) => h("button", {
      class: (d.mode || "auto") === m ? "on" : "", title: { auto: "Act automatically", advise: "Show advice only", off: "Ignore" }[m],
      onclick: async () => { await api("optimiser", { rule, mode: m }); toast(`${t.title}: ${m}`); } }, m[0].toUpperCase() + m.slice(1))));
    const els = rule === "immersion" && d.elements ? h("div", { class: "els" }, d.elements.map(elementChip)) : null;
    const use = rule === "immersion" ? hotWaterUse(o.hw) : null;
    el.append(h("div", { class: "rule" },
      h("div", { class: `ri ${dec}` }, t.icons[dec] || "•"),
      h("div", {}, h("div", { class: "rt" }, `${t.title} · ${t.head[dec] || dec}`), vs, els, use), seg,
      h("div", { class: "rr" }, d.reason || "")));
  }
  $("#opt-log").innerHTML = "";
  for (const x of (o.log || []).slice(0, 8)) $("#opt-log").append(h("li", {},
    `${new Date(x.at * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · ${(RULE_TXT[x.rule] || { title: x.rule }).title}: ${(RULE_TXT[x.rule]?.head || {})[x.decision] || x.decision}`));
}

// ------------------------------------------------------------------ Tesla (via Intelligent Octopus)
const hmTs = (ts) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const READY_TIMES = Array.from({ length: 15 }, (_, i) => `${String(4 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);  // 04:00–11:00
function renderCar() {
  const ev = S.ev; if (!ev) return;
  const card = $("#car-card");
  card.classList.toggle("charging", !!ev.charging);
  setBadge("#car-badge", S.integrations.tesla);
  $("#car-soc").textContent = ev.soc == null ? "–" : Math.round(ev.soc) + "%";
  const st = $("#car-state");
  st.textContent = ev.charging ? (ev.boost ? "Charging now (bump)" : "Charging") + (ev.power_w ? ` · ${kw(ev.power_w)}` : "")
    : ev.plugged ? (ev.state === "SMART_CONTROL_OFF" ? "Plugged in · smart charging paused" : ev.next_slot || ev.state === "SMART_CONTROL_IN_PROGRESS" ? "Plugged in · charge scheduled" : "Plugged in")
    : ev.state === "LOST_CONNECTION" ? "Octopus has lost touch with the car" : "Not plugged in (or away)";
  st.className = ev.charging ? "charging" : ev.plugged ? "ready" : "";
  $("#car-fill").style.width = Math.max(0, Math.min(100, ev.soc || 0)) + "%";
  $("#car-mark").style.left = `calc(${Math.max(0, Math.min(100, ev.target || 0))}% - 1px)`;
  const bits = [];
  if (ev.slot) bits.push(`This slot ends ${hmTs(ev.slot[1])}`);
  else if (ev.next_slot) bits.push(`Next charge ${hmTs(ev.next_slot[0])}–${hmTs(ev.next_slot[1])}`);
  if (ev.slots_kwh) bits.push(`${ev.slots_kwh} kWh planned`);
  if (ev.soc_at) bits.push(`charge level from ${new Date(ev.soc_at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`);
  $("#car-sub").textContent = bits.join(" · ");
  $("#car-bump").classList.toggle("on", !!ev.boost);
  $("#car-smart").classList.toggle("on", !!ev.smart);
  $("#car-target").textContent = ev.target == null ? "–" : Math.round(ev.target) + "%";
  const sel = $("#car-ready");
  if (sel.options.length !== READY_TIMES.length) READY_TIMES.forEach((t) => sel.append(h("option", { value: t }, t)));
  if (document.activeElement !== sel && ev.ready_by) sel.value = ev.ready_by;
}
async function carCmd(body, msg) {
  try { await api("tesla", body); toast(msg); } catch (e) { /* api() has already said what went wrong */ }
}

// ------------------------------------------------------------------ drawer
function openRoom(id) {
  selectedRoom = id; const r = roomById(id);
  if (r.floor !== floor) floor = r.floor;
  $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false");  // no dimming: the page stays live, and another room just takes over the panel
  render();
}
function closeRoom() {
  selectedRoom = null; $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); render();
}
function renderDrawer(id) {
  const r = roomById(id), body = $("#drawer-body"); body.innerHTML = "";
  const floorName = S.layout.floors.find((f) => f.id === r.floor).name;
  body.append(h("div", { class: "d-title" }, r.name), h("div", { class: "d-sub" }, `${floorName} · ${r.area} m²${r.note ? " · " + r.note : ""}`));

  const s = S.sensors[id], z = S.zones[id];
  if (s || z) {
    const cells = [];
    const t = roomTemp(id); if (t != null) cells.push(["Temp", deg(t)]);
    if (s?.humidity != null) cells.push(["Humidity", Math.round(s.humidity) + "%"]);
    if (s?.motion) cells.push(["Motion", s.motion === "active" ? "Yes" : "No"]);
    if (z) cells.push(["Target", deg(z.setpoint)]);
    body.append(h("div", { class: "d-section" }, h("h3", {}, "Climate"), h("div", { class: "sensors" }, cells.map(([k, v]) => h("div", {}, h("span", {}, k), h("b", {}, v))))));
  }
  if (z) {
    const r2 = h("input", { type: "range", min: 5, max: 30, step: .5, value: z.setpoint, style: `--p:${(z.setpoint - 5) / 25 * 100}%;--fill:var(--heat)` });
    const lbl = h("b", {}, deg(z.setpoint));
    r2.addEventListener("input", () => { pending++; r2.style.setProperty("--p", (r2.value - 5) / 25 * 100 + "%"); lbl.textContent = deg(r2.value); });
    r2.addEventListener("change", async () => { pending = 0; z.setpoint = +r2.value; await api("heating", { room: id, setpoint: +r2.value }); });
    body.append(h("div", { class: "d-section" }, h("h3", {}, "Heating · Wiser"),
      h("div", { class: "dl" }, h("div", { class: "nm" }, "Set point", h("small", {}, `${z.demand}% demand · ${z.mode}`)), lbl, r2)));
  }
  const ls = lightsIn(id);
  if (ls.length) {
    const sec = h("div", { class: "d-section" }, h("h3", {}, "Lights"));
    for (const l of ls) {
      const tog = h("button", { class: `toggle${l.on ? " on" : ""}`, "aria-label": l.name, onclick: () => setLight(l, { on: !l.on }) });
      const tag = l.live ? h("span", { class: "tag live" }, "Hubitat") : h("span", { class: "tag" }, l.hubitat ? "Hubitat · demo" : "planned");
      const row = h("div", { class: "dl" }, h("div", { class: "nm" }, l.name, tag, h("small", {}, (l.stairs ? "Stairs · " : "") + (l.dimmable ? `${l.on ? l.level : 0}%` : l.on ? "On" : "Off") + (l.assumed ? " · room assumed" : ""))), tog);
      if (l.dimmable) {
        const rg = h("input", { type: "range", min: 1, max: 100, value: l.on ? l.level : 0, style: `--p:${l.on ? l.level : 0}%` });
        rg.addEventListener("input", () => { pending++; rg.style.setProperty("--p", rg.value + "%"); });
        rg.addEventListener("change", async () => { pending = 0; await setLight(l, { level: +rg.value }); });
        row.append(rg);
      }
      sec.append(row);
    }
    body.append(sec);
  }
  for (const dv of Object.values(S.devices).filter((d) => d.room === id)) {
    body.append(h("div", { class: "d-section" }, h("h3", {}, "Devices"), h("div", { class: "dl" }, h("div", { class: "nm" }, dv.name, h("span", { class: `tag${dv.live ? " live" : ""}` }, dv.live ? "Hubitat" : "demo")),
      h("button", { class: `toggle${dv.on ? " on" : ""}`, onclick: async () => { dv.on = !dv.on; render(); await api("device", { id: dv.id, on: dv.on }); } }))));
  }
  if (r.aircon) body.append(h("div", { class: "d-section" }, h("h3", {}, "Aircon & blinds"), h("div", { class: "muted" }, "Controls are in the Loft card on the main screen.")));
}

// ------------------------------------------------------------------ misc
function setBadge(sel, st) {
  const el = $(sel); if (!st) return;
  el.className = "badge " + (st.error ? "err" : st.mode);
  el.title = st.error || (st.mode === "live" ? "Connected" : "Demo data — not yet connected");
  el.textContent = `${st.label}${st.mode === "demo" ? " · demo" : ""}`;
}
function renderIntegrations() {
  const el = $("#integrations"); el.innerHTML = "";
  for (const st of Object.values(S.integrations)) {
    el.append(h("span", { class: "badge " + (st.error ? "err" : st.mode), title: st.error || "" }, `${st.label} · ${st.error ? "error" : st.mode}`));
  }
}

// Scenes live on the server (server/scenes.py) so voice and the dashboard run the same thing.
function renderScenes() {
  const el = $("#scenes"); el.innerHTML = "";
  for (const sc of S.scenes || []) el.append(h("button", { class: "scene", onclick: async () => {
    const r = await api("scene", { id: sc.id });
    toast(r.ok ? `${sc.name} ✓` : `${sc.name}: ${r.errors.length} problem(s)`);
  } }, h("span", { class: "ico" }, sc.icon), sc.name));
  const d = S.integrations.display;
  if (d && d.mode === "live") el.append(h("button", { class: `scene${d.enabled ? " on" : ""}`, title: `Nest Hub is showing: ${d.showing || "?"}`,
    onclick: async () => { const r = await api("display", { on: !d.enabled }); toast(r.ok ? (d.enabled ? "Hub back to photos" : "Dashboard on Hub ✓") : "Hub unreachable"); } },
    h("span", { class: "ico" }, "📺"), d.enabled ? "Hub: on" : "Hub: off"));
}

document.addEventListener("DOMContentLoaded", async () => {
  tick(); setInterval(tick, 10_000);
  $("#ac-plus").onclick = () => ac({ setpoint: Math.min(30, S.aircon.setpoint + .5), power: true });
  $("#ac-minus").onclick = () => ac({ setpoint: Math.max(16, S.aircon.setpoint - .5), power: true });
  $("#ac-power").onclick = () => ac({ power: !S.aircon.power });
  document.querySelectorAll("[data-blinds]").forEach((b) => b.onclick = () => api("blinds", { id: "all", position: +b.dataset.blinds }));
  $("#drawer-close").onclick = closeRoom;
  // inside the Android app: a gear for its settings; in a browser on Android: a link to get the app
  if (window.HouseApp) { $("#app-gear").hidden = false; $("#app-gear").onclick = () => window.HouseApp.settings(); }
  else if (/Android/i.test(navigator.userAgent) && !window.HOUSE_STATIC) $("#get-app").hidden = false;
  // 🤫 click the house name five times (quickly) to peek next door, unblurred; five more to stop
  { let clicks = [], peeking = false; const t = $(".brand h1");
    t.addEventListener("click", () => {
      const now = Date.now(); clicks = clicks.filter((c) => now - c < 2500); clicks.push(now);
      if (clicks.length < 5) return;
      clicks = []; peeking = !peeking; t.textContent = peeking ? "31 Demo Drive" : "32 Demo Drive";
      if (h3) h3.peek(peeking);
      toast(peeking ? "Number 31, unblurred. Pick a floor to look inside." : "Back to minding our own business");
    }); }
  $("#car-bump").onclick = () => carCmd({ bump: !S.ev.boost }, S.ev.boost ? "Bump charge off" : "Charging now");
  $("#car-smart").onclick = () => carCmd({ smart: !S.ev.smart }, S.ev.smart ? "Smart charging paused" : "Smart charging on");
  $("#car-tminus").onclick = () => carCmd({ target: Math.max(10, (S.ev.target || 80) - 5) }, `Charge to ${Math.max(10, (S.ev.target || 80) - 5)}%`);
  $("#car-tplus").onclick = () => carCmd({ target: Math.min(100, (S.ev.target || 80) + 5) }, `Charge to ${Math.min(100, (S.ev.target || 80) + 5)}%`);
  $("#car-ready").onchange = (e) => carCmd({ readyBy: e.target.value }, `Ready by ${e.target.value}`);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeRoom());
  // never let an abandoned slider drag freeze updates
  document.addEventListener("pointerup", () => setTimeout(() => { pending = 0; }, 300));
  S = await (await fetch("/api/state")).json(); render(); renderScenes();
  setInterval(renderScenes, 5000); // display toggle state
  connect();
});
