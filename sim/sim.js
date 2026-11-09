/* The simulated house for the public demo site, which has no server behind it.

Loads Pyodide (Python compiled to WebAssembly), runs the dashboard server's own Python in it (house.py and the
adapters, every one in demo mode: see webhub.py) and answers the dashboard's calls itself:
  GET /api/state, POST /api/<kind>, and the /api/events stream.
The dashboard's own code is unchanged: this file goes in before it and stands in for fetch and EventSource. */
(() => {
  "use strict";
  const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";
  const FILES = ["house.py", "model.py", "adapters.py", "optimiser.py", "scenes.py", "layout.json", "webhub.py"];
  const here = document.currentScript.src.replace(/[^/]*$/, "");   // this folder: the Python sits beside it
  window.HOUSE_STATIC = true;                                       // the dashboard hides links to a real house

  const streams = new Set();
  let snap = null;
  const push = (json) => { if (json) { snap = json; streams.forEach((s) => s._emit(json)); } };

  // ---- a "starting up" card while Python loads (a few MB, the first time only) ----
  const card = document.createElement("div");
  card.style.cssText = "position:fixed;inset:auto 0 24px 0;margin:auto;width:max-content;max-width:90vw;z-index:9999;" +
    "padding:12px 18px;border-radius:14px;background:#1c2229ee;color:#eef1f5;font:14px system-ui,sans-serif;" +
    "box-shadow:0 6px 30px #0008;text-align:center";
  card.textContent = "Starting the simulated house…";
  const showCard = () => document.body.appendChild(card);
  document.body ? showCard() : document.addEventListener("DOMContentLoaded", showCard);

  const ready = (async () => {
    await new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = PYODIDE + "pyodide.js"; s.onload = ok; s.onerror = () => fail(new Error("couldn't download Python (Pyodide)"));
      document.head.appendChild(s);
    });
    const py = await loadPyodide({ indexURL: PYODIDE });
    py.FS.mkdirTree("/house/server");
    await Promise.all(FILES.map(async (f) => {
      const r = await fetch(here + f);
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      py.FS.writeFile("/house/server/" + f, new Uint8Array(await r.arrayBuffer()));
    }));
    py.runPython("import sys; sys.path.insert(0, '/house/server')");
    const sim = py.pyimport("webhub");
    push(sim.tick() ?? sim.snapshot());
    setInterval(() => push(sim.tick()), 1000);
    card.remove();
    return sim;
  })();
  ready.catch((e) => { card.textContent = "⚠ The simulation couldn't start: " + e.message; console.error(e); });

  const reply = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "Content-Type": "application/json" } });

  // ---- fetch: /api/… answered here, everything else as normal ----
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    const kind = url.pathname.slice(5);
    const sim = await ready;
    if ((init.method || "GET").toUpperCase() === "GET") {
      return kind === "state" ? reply(200, snap || sim.snapshot()) : reply(404, { error: "not found" });
    }
    const res = JSON.parse(sim.command(kind, typeof init.body === "string" ? init.body : "{}"));
    push(sim.tick() ?? sim.snapshot());               // as the server does: every command sends fresh state
    return reply(res.status, res.body);
  };

  // ---- EventSource: /api/events fed from the simulation, a new state each time anything changes ----
  const RealEventSource = window.EventSource;
  class SimEvents {
    constructor() {
      this.readyState = 0; this.onmessage = null; this.onerror = null; this.onopen = null;
      streams.add(this);
      ready.then(() => {
        if (this.readyState === 2) return;
        this.readyState = 1; this.onopen && this.onopen({});
        if (snap) this._emit(snap);
      }, () => { streams.delete(this); this.readyState = 2; });   // the card says what went wrong; no retry storm
    }
    _emit(data) { this.onmessage && this.onmessage({ data }); }
    close() { this.readyState = 2; streams.delete(this); }
    addEventListener(type, fn) { if (type === "message") this.onmessage = fn; else if (type === "error") this.onerror = fn; }
  }
  window.EventSource = function (url, opts) {
    const u = new URL(url, location.href);
    return u.origin === location.origin && u.pathname === "/api/events" ? new SimEvents() : new RealEventSource(url, opts);
  };
})();
