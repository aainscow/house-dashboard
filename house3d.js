/* 3D view of 32 Demo Drive for the dashboard, lit by the live house state.

The model is the one measured for the "32 Demo Drive" visualiser: plan positions from the PDF
vectors of the architect's plans at 1:50 (1 pt = 17.64 mm), levels from the sections,
window heights from the 1:100 elevations. Furniture is illustrative, and so is the aircon's spot.

Coordinates: x = metres from the party wall towards the side extension (that's north),
d = metres back from the front face (the front faces east). In three.js: +X north, +Z east, +Y up.

three.js r147 is bundled in web/vendor/three-0.147.0 (MIT; build/three.min.js and two examples/js files
from the npm package three@0.147.0, checksum checked against the registry). It loads when the 3D
view is first shown, so the house works without internet; jsDelivr is only a backup. If neither
loads, the dashboard keeps its 2D plan. It renders only when something changes, so an idle tablet
isn't drawing 60 frames a second.

API:  House3D.load() → Promise
      const v = House3D.mount(container, { onRoom(roomId) })
      v.update(S, { floor: "house"|"ground"|"first"|"loft", selected: roomId|null, temp: (roomId) → °C })
*/
(function () {
"use strict";
const FILES = [  // [bundled copy, same file on the CDN]
  ["vendor/three-0.147.0/three.min.js", "build/three.min.js"],
  ["vendor/three-0.147.0/OrbitControls.js", "examples/js/controls/OrbitControls.js"],
  ["vendor/three-0.147.0/CSS2DRenderer.js", "examples/js/renderers/CSS2DRenderer.js"],
];
const CDN = "https://cdn.jsdelivr.net/npm/three@0.147.0/";
const LAT = 51.40, LON = -1.00;  // southern England: close enough for the sun

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement("script"); s.src = src; s.async = false;
    s.onload = ok; s.onerror = () => { s.remove(); fail(new Error("couldn't load " + src)); };
    document.head.appendChild(s);
  });
}
let loading = null;
function load() {
  if (window.THREE && THREE.OrbitControls && THREE.CSS2DRenderer) return Promise.resolve();
  if (!loading) loading = FILES.reduce((p, [local, cdn]) => p.then(() => loadScript(local).catch(() => loadScript(CDN + cdn))), Promise.resolve())
    .catch((e) => { loading = null; throw e; });
  return loading;
}

/* Sun position (good to a fraction of a degree, plenty for lighting). Azimuth from north, clockwise. */
function sunPos(date) {
  const r = Math.PI / 180, d = date.getTime() / 86400000 - 10957.5;  // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * r, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * r, e = (23.439 - 0.00000036 * d) * r;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const H = (gmst * 15 + LON) * r - ra, phi = LAT * r;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { alt, az };
}

function mount(container, opts) {
const CX = 5.75, CD = 4.9, LV = [0, 2.54, 5.03];
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = Math.min(screen.width, screen.height) < 700;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);
const labelR = new THREE.CSS2DRenderer(); labelR.domElement.className = "labels"; container.appendChild(labelR.domElement);
const hint = document.createElement("div"); hint.className = "h3d-hint";
hint.textContent = "Drag to turn · scroll or pinch to zoom · tap a room";
container.appendChild(hint);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
const HOME = { pos: new THREE.Vector3(13.5, 10.5, 17.5), tgt: new THREE.Vector3(0, 3.2, 0) };
camera.position.copy(HOME.pos);
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.tgt); controls.enableDamping = true; controls.dampingFactor = .08;
controls.maxPolarAngle = Math.PI * .495; controls.minDistance = 3; controls.maxDistance = 70;

const hemi = new THREE.HemisphereLight(0xf2f5f7, 0x5c6650, .75); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1de, 1.7); sun.position.set(14, 22, 12); sun.castShadow = true;
sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -28, right: 28, top: 28, bottom: -28, near: 1, far: 100 });  // house, garden and drive
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; scene.add(sun);
const nbrScene = new THREE.Scene();  // number 31 lives here, drawn separately and blurred (see draw())
const hemiN = new THREE.HemisphereLight(), sunN = new THREE.DirectionalLight(); nbrScene.add(hemiN, sunN);
let nbrProxy = null;                 // an invisible stand-in in our scene, so their house still throws its shadow
const nbrBubbles = [[], [], []];      // speech bubbles next door, per floor: each shows only on its own floor's view

/* ---------- procedural textures (UVs are in metres) ---------- */
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const aniso = renderer.capabilities.getMaxAnisotropy();
function tex(w, h, draw, ru, rv, rot) {
  const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(ru, rv);
  t.encoding = THREE.sRGBEncoding; t.anisotropy = aniso; if (rot) t.rotation = rot; return t;
}
const rgb = (b, j) => `rgb(${b.map((v) => Math.max(0, Math.min(255, Math.round(v + j)))).join(",")})`;
const brickT = tex(384, 256, (x, w, h) => { x.fillStyle = "#c4b9a9"; x.fillRect(0, 0, w, h);
  for (let r = 0; r < 8; r++) { const off = r % 2 ? 48 : 0; for (let i = -1; i < 5; i++) { x.fillStyle = rgb([150, 76, 54], (rnd() - .5) * 34); x.fillRect(i * 96 + off + 2, r * 32 + 2, 92, 28); } } }, 1 / .9, 1 / .6);
const tileDraw = (x, w, h) => { x.fillStyle = "#3a2a24"; x.fillRect(0, 0, w, h); const rows = 10, rh = h / rows, tw = w / 6;
  for (let r = 0; r < rows; r++) { const off = r % 2 ? tw / 2 : 0; for (let i = -1; i < 7; i++) { x.fillStyle = rgb([104, 72, 60], (rnd() - .5) * 26); x.fillRect(i * tw + off + 1, r * rh + 1, tw - 2, rh - 1.5); x.fillStyle = "rgba(0,0,0,.22)"; x.fillRect(i * tw + off + 1, r * rh + rh - 5, tw - 2, 4); } } };
const roofT = tex(256, 256, tileDraw, 1, 1), roofTR = tex(256, 256, tileDraw, 1, 1, Math.PI / 2);
const hangT = tex(256, 256, tileDraw, 1.6, 1.6);
const woodT = tex(256, 256, (x, w, h) => { const n = 7, pw = w / n; for (let i = 0; i < n; i++) { let y = -rnd() * h; while (y < h) { const L = h * (.55 + rnd() * .6); x.fillStyle = rgb([176, 136, 94], (rnd() - .5) * 30); x.fillRect(i * pw, y, pw - 1, L - 1); y += L; } }
  x.globalAlpha = .07; x.strokeStyle = "#3b2410"; for (let k = 0; k < 120; k++) { const px = rnd() * w; x.beginPath(); x.moveTo(px, 0); x.lineTo(px + (rnd() - .5) * 4, h); x.stroke(); } x.globalAlpha = 1; }, 1, 1);
const tileFT = tex(256, 256, (x, w, h) => { x.fillStyle = "#a9a49b"; x.fillRect(0, 0, w, h); for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { x.fillStyle = rgb([214, 209, 200], (rnd() - .5) * 12); x.fillRect(i * 128 + 2, j * 128 + 2, 124, 124); } }, 1 / .6, 1 / .6);
const boardT = tex(256, 256, (x, w, h) => { x.fillStyle = "#c6a777"; x.fillRect(0, 0, w, h); for (let k = 0; k < 2600; k++) { x.fillStyle = rgb([150, 118, 76], (rnd() - .5) * 50); x.fillRect(rnd() * w, rnd() * h, 2, 1); } }, 1, 1);

const S = (o) => new THREE.MeshStandardMaterial(Object.assign({ roughness: .85 }, o));
const M = {
  brick: S({ map: brickT, roughness: .92 }), roof: S({ map: roofT }), roofR: S({ map: roofTR }), hang: S({ map: hangT }),
  plaster: S({ color: 0xebe6dd, roughness: .95 }), party: S({ color: 0xd8d3ca, roughness: .95 }),
  frame: S({ color: 0xf3f3ef, roughness: .4 }), sill: S({ color: 0xd9d6cf, roughness: .7 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x9ec3d8, transparent: true, opacity: .32, roughness: .05, metalness: .3, depthWrite: false }),
  door: S({ color: 0x2d4a58, roughness: .5 }), epdm: S({ color: 0x2a2d30, roughness: .7 }), gutter: S({ color: 0x2f3236, roughness: .5 }),
  timber: S({ color: 0xb48a5a, roughness: .7 }), san: S({ color: 0xf2f2ee, roughness: .25 }), units: S({ color: 0xd9d3c7 }), top: S({ color: 0x3b4045, roughness: .4 }),
  sofa: S({ color: 0x6c7b8b }), linen: S({ color: 0xe9e5dc }), bedf: S({ color: 0x86684b }), dark: S({ color: 0x222426, roughness: .4 }),
  rl: S({ color: 0x3f5866, roughness: .15, metalness: .4 }), paving: S({ color: 0x8f897f }), drive: S({ color: 0x6f6c68 }),
  grass: S({ color: 0x3f5236, roughness: 1 }), steel: S({ color: 0xc9ccce, roughness: .35, metalness: .5 }),
  blind: S({ color: 0xc9c2b4, roughness: 1, side: THREE.DoubleSide }),
};
const lamT = tex(256, 256, (x, w, h) => { const n = 7, pw = w / n;  // laminate: even planks ~19 cm by 1.3 m, staggered
  for (let i = 0; i < n; i++) { const off = (i * 0.37 % 1) * h; for (let y = -off; y < h; y += h) { x.fillStyle = rgb([196, 170, 132], (rnd() - .5) * 18); x.fillRect(i * pw, y, pw - 1, h - 2); } }
  x.globalAlpha = .06; x.strokeStyle = "#5a3a1a"; for (let k = 0; k < 90; k++) { const px = rnd() * w; x.beginPath(); x.moveTo(px, 0); x.lineTo(px + (rnd() - .5) * 3, h); x.stroke(); } x.globalAlpha = 1; }, 1 / 1.33, 1 / 1.33);
const FLOOR = { wood: S({ map: woodT, roughness: .6 }), tile: S({ map: tileFT, roughness: .5 }), boards: S({ map: boardT }), carpet: S({ roughness: 1 }),
  laminate: S({ map: lamT, roughness: .45 }) };

/* ---------- geometry helpers ---------- */
function mbox(w, h, d) { const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv, F = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let i = 0; i < 24; i++) { const f = F[i >> 2]; uv.setXY(i, uv.getX(i) * f[0], uv.getY(i) * f[1]); } return g; }
function box(g, x0, x1, y0, y1, d0, d1, mat, ud) { if (x1 < x0) [x0, x1] = [x1, x0]; if (d1 < d0) [d0, d1] = [d1, d0];
  const m = new THREE.Mesh(mbox(x1 - x0, y1 - y0, d1 - d0), mat); m.position.set((x0 + x1) / 2 - CX, (y0 + y1) / 2, CD - (d0 + d1) / 2); if (ud) Object.assign(m.userData, ud); g.add(m); return m; }
function segs(a0, a1, h, op) { const out = []; let c = a0; [...op].sort((p, q) => p.a - q.a).forEach((o) => { if (o.a > c + 1e-4) out.push([c, o.a, 0, h]); if (o.s > 1e-4) out.push([o.a, o.b, 0, o.s]); if (o.t < h - 1e-4) out.push([o.a, o.b, o.t, h]); c = o.b; }); if (a1 > c + 1e-4) out.push([c, a1, 0, h]); return out; }
function wall(g, axis, pos, dir, a0, a1, y0, h, op, layers) { op = op || []; let off = 0; const n0 = g.children.length;
  layers.forEach((L) => { const p0 = pos + dir * off, p1 = pos + dir * (off + L.t); segs(L.a0 ?? a0, L.a1 ?? a1, h, op).forEach(([s0, s1, z0, z1]) => { axis === "x" ? box(g, s0, s1, y0 + z0, y0 + z1, p0, p1, L.mat) : box(g, p0, p1, y0 + z0, y0 + z1, s0, s1, L.mat); }); off += L.t; });
  const pm = pos + dir * Math.min(.13, off * .5);
  const B = (s0, s1, ya, yb, dd, mat, ud) => axis === "x" ? box(g, s0, s1, ya, yb, pm - dd / 2, pm + dd / 2, mat, ud) : box(g, pm - dd / 2, pm + dd / 2, ya, yb, s0, s1, mat, ud);
  op.forEach((o) => { if (o.k === "gap") return; const ys = y0 + o.s, yt = y0 + o.t, f = .06, fd = .09;
    B(o.a, o.b, yt - f, yt, fd, M.frame); B(o.a, o.a + f, ys, yt, fd, M.frame); B(o.b - f, o.b, ys, yt, fd, M.frame);
    if (o.k === "win") B(o.a, o.b, ys, ys + f, fd, M.frame);
    if (o.k === "door") B(o.a + f, o.b - f, ys, yt - f, .05, M.door);
    else { B(o.a + f, o.b - f, ys + (o.k === "win" ? f : 0), yt - f, .02, M.glass, { noPick: 1 }); const w = o.b - o.a, n = w > 2.2 ? 3 : w > 1.1 ? 2 : 1; for (let i = 1; i < n; i++) { const m = o.a + w * i / n; B(m - f / 2, m + f / 2, ys, yt, fd, M.frame); } if (n === 3 && o.k === "win") { const ym = (ys + yt) / 2; B(o.a + w / 3, o.b - w / 3, ym - f / 2, ym + f / 2, fd, M.frame); } }
    if (o.k === "win") { const a = pos - dir * .05, b = pos + dir * .06; axis === "x" ? box(g, o.a - .04, o.b + .04, ys - .05, ys, a, b, M.sill) : box(g, a, b, ys - .05, ys, o.a - .04, o.b + .04, M.sill); }
  });
  for (let i = n0; i < g.children.length; i++) g.children[i].userData.n = axis === "x" ? "z" : "x"; }  // the way the wall faces
function prof(g, x0, t, pts, mat, holes, ud) { const sh = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  (holes || []).forEach((h) => sh.holes.push(new THREE.Path([new THREE.Vector2(h[0], h[2]), new THREE.Vector2(h[1], h[2]), new THREE.Vector2(h[1], h[3]), new THREE.Vector2(h[0], h[3])])));
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false }), mat); m.rotation.y = Math.PI / 2; m.position.set(x0 - CX, 0, CD); if (ud) Object.assign(m.userData, ud); g.add(m); return m; }
function profX(g, dFrom, t, pts, mat) { const sh = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0] - CX, p[1])));
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false }), mat); m.position.set(0, 0, CD - dFrom - t); g.add(m); return m; }
const roofY = (d) => d <= 2.92 ? 4.88 + 1.04 * d : 4.88 + 1.04 * (5.84 - d);
function slope(g, x0, x1, dR, dE, mat, t, lift, yfn) { t = t || .12; lift = lift || 0; yfn = yfn || roofY;
  const A = new THREE.Vector3(0, yfn(dR), CD - dR), B = new THREE.Vector3(0, yfn(dE), CD - dE), dir = B.clone().sub(A), L = dir.length(); dir.normalize();
  const xa = new THREE.Vector3(dir.z > 0 ? 1 : -1, 0, 0), ya = new THREE.Vector3().crossVectors(dir, xa);
  const m = new THREE.Mesh(mbox(x1 - x0, t, L), mat); m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xa, ya, dir));
  const c = A.add(B).multiplyScalar(.5).addScaledVector(ya, t / 2 + lift); m.position.set((x0 + x1) / 2 - CX, c.y, c.z); g.add(m); return m; }
function bar(g, p, q, r, mat) { const a = new THREE.Vector3(p[0] - CX, p[1], CD - p[2]), b = new THREE.Vector3(q[0] - CX, q[1], CD - q[2]);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 8), mat); m.position.copy(a).add(b).multiplyScalar(.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); g.add(m); return m; }

/* ---------- groups: G[0] ground, G[1] first, G[2] loft, G[3] main roof, g0r single-storey roofs ---------- */
const house = new THREE.Group(); scene.add(house);
const G = [0, 1, 2, 3].map(() => { const g = new THREE.Group(); house.add(g); return g; });
const g0r = new THREE.Group(); house.add(g0r);
const IN = [{ t: .1, mat: M.plaster }], PL = [{ t: .26, mat: M.plaster }];
const W = (a, b, s, t) => ({ a, b, s, t, k: "win" }), D = (a, b) => ({ a, b, s: .15, t: 2.32, k: "door" }), gap = (a, b) => ({ a, b, s: 0, t: 2.05, k: "gap" });
const IH = [2.39, 2.25, 2.36];
const iw = (l, axis, pos, a0, a1, ops) => wall(G[l], axis, pos - .05, 1, a0, a1, LV[l], IH[l], ops || [], IN);
const MW = 5.84, MX = 8.65, SX = 11.3;
const EXTm = [{ t: .1, mat: M.brick }, { t: .16, mat: M.plaster, a1: 8.39 }], EXTs = [{ t: .1, mat: M.brick }, { t: .16, mat: M.plaster, a1: 11.04 }];

/* The outside of the house (walls, windows, porch, roof) is marked as it's built, so the neighbour can be drawn as just that */
const EXT = new Set();
const markExt = () => { const before = new Set(G.flatMap((g) => g.children)); return () => G.forEach((g) => g.children.forEach((o) => { if (!before.has(o)) EXT.add(o); })); };
let extDone = markExt();
/* Ground floor shell */
const gF = (a, b) => W(a, b, 1.34, 2.27), gR = (a, b) => W(a, b, 1.02, 2.27);
wall(G[0], "x", 0, 1, .14, MX, -.15, 2.69, [gF(.37, .97), D(3.45, 4.36), gF(5.0, 5.56), gF(5.84, 6.41), gF(6.68, 7.24)], EXTm);
wall(G[0], "x", MW, -1, .14, MX, -.15, 2.69, [gR(.73, 2.43), gR(3.64, 4.78), gR(6.21, 7.62)], EXTm);
box(G[0], 0, .14, -.15, 2.54, 0, MW, M.party);
wall(G[0], "d", MX, -1, .1, .51, -.15, 2.69, [], [{ t: .1, mat: M.brick }, { t: .16, mat: M.plaster, a0: .26 }]);
wall(G[0], "d", MX, -1, .51, 5.58, -.15, 2.69, [{ a: 1.01, b: 1.77, s: .15, t: 2.27, k: "gap" }], PL);
wall(G[0], "x", .51, 1, MX, SX, -.15, 2.65, [W(8.78, 9.88, 1.51, 2.1)], EXTs);
wall(G[0], "d", SX, -1, .61, 5.74, -.15, 2.65, [W(1.32, 1.93, 1.67, 2.32), D(2.4, 3.3)], [{ t: .1, mat: M.brick }, { t: .16, mat: M.plaster, a0: .77, a1: 5.58 }]);
wall(G[0], "x", MW, -1, MX, SX, -.15, 2.65, [{ a: 9.09, b: 10.72, s: .15, t: 2.32, k: "gdoor" }], EXTs);
extDone();
iw(0, "x", 2.265, .14, 4.41, [gap(2.36, 3.04), gap(3.5, 4.36)]);
iw(0, "x", 2.165, 4.46, 8.39, [gap(5.73, 6.44)]);
iw(0, "d", 3.22, 2.33, 5.58); iw(0, "d", 4.46, .26, 2.2); iw(0, "x", 1.275, 1.04, 3.13);
iw(0, "d", 10.07, .77, 2.15); iw(0, "x", 2.15, 10.07, 11.04, [gap(10.42, 11.0)]);
box(G[0], 7.84, 8.39, 0, 2.39, 3.15, 4.56, M.plaster); box(G[0], .14, .51, 0, 2.39, 3.26, 4.24, M.plaster);

/* First floor shell */
extDone = markExt();
const fF = (a, b) => W(a, b, 1.09, 1.9), fR = (a, b) => W(a, b, 1.04, 1.93);
wall(G[1], "x", 0, 1, .13, MX, 2.54, 2.21, [fF(2.77, 3.34), fF(3.62, 4.18), fF(4.45, 5.0)], EXTm);
wall(G[1], "x", MW, -1, .13, MX, 2.54, 2.21, [fR(.78, 2.47), fR(3.67, 4.8), fR(6.06, 7.75)], EXTm);
wall(G[1], "d", MX, -1, .1, 5.74, 2.54, 2.21, [W(.92, 1.45, 1.14, 2.0)], [{ t: .1, mat: M.brick }, { t: .16, mat: M.plaster, a0: .26, a1: 5.58 }]);
box(G[1], 0, .13, 2.54, 4.75, 0, MW, M.party);
extDone();
iw(1, "x", 2.17, 1.58, 8.38, [gap(2.45, 3.1), gap(3.36, 4.02), gap(5.5, 6.17)]);
iw(1, "d", 3.23, 2.22, 5.58); iw(1, "d", 5.37, 2.22, 5.58);
iw(1, "x", 1.245, .13, 2.02); box(G[1], 2.02, 3.18, 2.54, 3.44, 1.18, 1.31, M.plaster);
iw(1, "d", .97, .26, 1.18); iw(1, "d", 1.97, .26, 1.18);
iw(1, "d", 5.25, .26, 1.13); iw(1, "d", 5.86, .26, 1.13); iw(1, "x", 1.185, 5.2, 6.46); iw(1, "d", 6.41, 1.18, 2.12, [gap(1.3, 2.0)]);
iw(1, "d", 1.53, 1.97, 2.83);
box(G[1], 8.05, 8.38, 2.54, 4.79, 2.25, 3.77, M.plaster);
box(G[2], 8.18, 8.39, LV[2], 7.39, 2.25, 3.74, M.plaster, { rm: "ensuite" });
box(G[1], .13, .46, 2.54, 4.79, 2.6, 3.52, M.plaster);
/* The loft stair climbs over the front corner of bedroom 2: its underside is that corner's sloping ceiling */
const LOFT1 = new Set(); let lo0 = G[1].children.length;   // first-floor parts of the loft conversion (not mirrored next door)
const sof = (d) => 2.64 + (d - 1.31) * .872;
box(G[1], .46, 1.58, 2.54, sof(2.83), 2.78, 2.88, M.plaster);
slope(G[1], .13, 1.58, 3.77, 2.83, M.plaster, .04, -.05, sof);
prof(G[1], 1.48, .1, [[2.83, sof(2.83)], [3.77, 4.79], [2.83, 4.79]], M.plaster);
for (let i = lo0; i < G[1].children.length; i++) LOFT1.add(G[1].children[i]);

/* Loft: full-width box dormer from the ridge to the rear wall line, one wide window */
function loftProf(d0, d1) { const cap = 2.36, dc = (cap + .38) / 1.04, h = (d) => Math.max(.02, Math.min(cap, 1.04 * d - .38)), p = [[d0, 0], [d1, 0], [d1, h(d1)]]; if (d0 < dc && dc < d1) p.push([dc, cap]); p.push([d0, h(d0)]); return p.map((q) => [q[0], q[1] + LV[2]]); }
const lh = (d) => LV[2] + Math.min(2.36, 1.04 * d - .38);
extDone = markExt();
wall(G[2], "x", 5.76, -1, .29, 8.57, 4.91, 2.56, [W(2.64, 5.64, 1.01, 2.39)], [{ t: .1, mat: M.hang }, { t: .22, mat: M.plaster, a1: 8.33 }]);
const dorBot = (d) => 7.55 - (d - 2.86) * .025, rY = (d) => 4.88 + 1.04 * (5.84 - d);
prof(G[2], 0, .29, [[0, 4.75], [2.92, 7.92], [2.92, dorBot(2.92)], [5.84, dorBot(5.84)], [5.84, 4.75]], M.party);
prof(G[2], 8.39, .26, [[0, 4.75], [5.84, 4.75], [2.92, 7.92]], M.brick);
prof(G[2], 8.33, .24, [[4.34, rY(4.34) - .05], [5.76, rY(5.76) - .05], [5.76, dorBot(5.76)], [4.34, dorBot(4.34)]], M.hang);
box(G[2], 8.05, 8.57, rY(4.34) - .05, dorBot(4.34), 4.29, 4.39, M.hang);
prof(G[2], 8.05, .11, [[3.4, rY(3.4) - .05], [4.34, rY(4.34) - .05], [4.34, dorBot(4.34)], [3.4, dorBot(3.4)]], M.hang);
extDone();
box(G[2], .2, 1.58, 4.79, lh(1.28), 1.19, 1.28, M.plaster);
box(G[2], 1.58, 5.57, LV[2], lh(1.27), 1.18, 1.27, M.plaster);
[[1.76, 2.42], [4.68, 5.35]].forEach(([a, b]) => box(G[2], a, b, LV[2] + .05, LV[2] + .8, 1.27, 1.29, M.frame));
prof(G[2], 5.47, .1, loftProf(.39, 1.18), M.plaster);
/* Stair wall, with two built-in bookshelf bays opening into bedroom 1 */
prof(G[2], 1.49, .1, loftProf(.39, 2.2), M.plaster);
prof(G[2], 1.49, .1, loftProf(3.97, 5.52), M.plaster, [[4.08, 4.73, 5.05, 7.05]]);
prof(G[2], 1.21, .1, loftProf(2.2, 3.97), M.plaster);
{ const SX0 = 1.31, SX1 = 1.58;
  const infill = (d0, d1, yb) => prof(G[2], SX0, SX1 - SX0, loftProf(d0, d1).map((p) => [p[0], p[1] <= LV[2] + 1e-6 ? yb : Math.max(yb, p[1])]), M.plaster);
  const bay = (d0, d1) => { const top = Math.min(lh(d0) - .12, LV[2] + 2.1);
    box(G[2], SX0, SX1, LV[2], LV[2] + .09, d0, d1, M.timber);
    for (let y = LV[2] + .09 + .33; y < top - .15; y += .34) box(G[2], SX0, SX1 - .01, y, y + .025, d0, d1, M.timber);
    box(G[2], SX0, SX1, top - .03, top, d0, d1, M.timber);
    box(G[2], SX0, SX1, LV[2], top, d0, d0 + .02, M.timber); box(G[2], SX0, SX1, LV[2], top, d1 - .02, d1, M.timber);
    infill(d0, d1, top); };
  bay(2.23, 2.89); bay(2.98, 3.89);
  prof(G[2], SX0, SX1 - SX0, loftProf(2.89, 2.98), M.plaster);
  prof(G[2], SX0, SX1 - SX0, loftProf(2.2, 2.23), M.plaster);
  prof(G[2], SX0, SX1 - SX0, loftProf(3.89, 3.97), M.plaster); }
prof(G[2], 6.47, .1, loftProf(.39, 5.52), M.plaster, [[3.05, 3.75, 5.05, 7.05], [.95, 1.6, 5.05, 5.58]]);
box(G[2], 6.57, 8.39, LV[2], lh(1.66), 1.66, 1.74, M.plaster);
/* plaster linings inside the north gable and the dormer cheeks (ensuite and tank space: white walls) */
prof(G[2], 8.31, .08, loftProf(.39, 3.4), M.plaster);
prof(G[2], 7.97, .08, loftProf(3.4, 4.34), M.plaster);
prof(G[2], 8.25, .08, loftProf(4.34, 5.52), M.plaster);
box(G[2], 8.05, 8.31, LV[2], LV[2] + 2.36, 4.39, 4.42, M.plaster); box(G[2], 8.05, 8.31, LV[2], LV[2] + 2.36, 3.37, 3.4, M.plaster);
[[6.8, 7.4], [7.45, 8.05]].forEach(([a, b]) => box(G[2], a, b, LV[2] + .6, LV[2] + 1.25, 1.74, 1.76, M.frame));

/* Roof, with the four front rooflights: stairwell, bedroom 1 left and right, ensuite */
slope(G[3], 0, 8.9, 2.92, -.3, M.roof);
const ROOFLIGHTS = { "blind-stairs-roof": [.3, 1.15], "blind-roof-l": [1.76, 2.94], "blind-roof-r": [4.93, 6.12], "blind-ensuite-roof": [6.95, 7.83] };
Object.values(ROOFLIGHTS).forEach(([a, b]) => slope(G[3], a, b, 2.51, 1.77, M.rl, .1, .04));
const rearY = (d) => 4.88 + 1.04 * (5.84 - d);
slope(G[3], 0, 8.9, 5.66, 6.14, M.roof, .1, 0, rearY);
slope(G[3], 8.16, 8.9, 3.4, 4.34, M.roof, .12, 0, rearY); slope(G[3], 8.57, 8.9, 4.34, 5.66, M.roof, .12, 0, rearY);
{ const fY = (d) => 4.88 + 1.04 * d, top = [[-.3, fY(-.3)], [2.92, 7.92], [6.14, rearY(6.14)]];
  prof(G[3], 8.88, .03, [...top.map(([d, y]) => [d, y + .15]), ...top.slice().reverse().map(([d, y]) => [d, y - .08])], M.frame); }
slope(G[3], -.03, 8.2, 2.86, 5.9, M.epdm, .22, 0, dorBot); slope(G[3], 8.2, 8.63, 4.27, 5.9, M.epdm, .22, 0, dorBot);
box(G[3], -.03, 8.63, dorBot(5.9) - .1, dorBot(5.9) + .24, 5.9, 5.96, M.gutter);
box(G[3], 8.6, 8.66, dorBot(4.3) - .1, dorBot(4.3) + .24, 4.27, 5.96, M.gutter); box(G[3], 8.18, 8.63, dorBot(4.3) - .1, dorBot(4.3) + .24, 4.24, 4.3, M.gutter); box(G[3], 8.18, 8.24, dorBot(2.9) - .1, dorBot(2.9) + .24, 2.86, 4.3, M.gutter);
box(G[3], 0, 8.9, 7.86, 7.96, 2.84, 2.98, M.gutter);
// chimney stack with a brick oversailing course at the top (it stands proud of the stack, so no two faces share a plane)
box(G[3], 7.84, 8.65, 6.9, 9.22, 2.6, 3.4, M.brick); box(G[3], 7.79, 8.7, 9.16, 9.34, 2.55, 3.45, M.brick);
[8.05, 8.45].forEach((x) => { const p = new THREE.Mesh(new THREE.CylinderGeometry(.09, .11, .35, 12), S({ color: 0xa9583c })); p.position.set(x - CX, 9.52, CD - 3.0); G[3].add(p); });
box(G[3], 0, 8.9, 4.45, 4.6, -.42, -.3, M.gutter); box(G[3], 0, 8.9, 4.45, 4.6, 6.14, 6.26, M.gutter);

/* Side extension: pitched roof, ridge parallel to the main ridge, gable to the side */
const sideY = (d) => d <= 3.17 ? 2.5 + 1.015 * (d - .51) : 2.5 + 1.015 * (5.84 - d);
slope(g0r, MX, SX + .25, 3.17, .21, M.roof, .12, 0, sideY); slope(g0r, MX, SX + .25, 3.17, 6.14, M.roof, .12, 0, sideY);
prof(g0r, SX - .26, .26, [[.51, 2.5], [5.84, 2.5], [3.17, 5.2]], M.brick);
box(g0r, MX, SX + .25, 2.06, 2.2, .07, .21, M.gutter);

/* Conservatory: glazed walls on brick dwarf walls, solid tiled hipped roof with Velux rooflights */
const C = { x0: 7.35, x1: SX, d0: MW, d1: 10.04, e: 2.31 }; const apex = [(C.x0 + C.x1) / 2, 3.2, (C.d0 + C.d1) / 2];
{ const V = (p) => new THREE.Vector3(p[0] - CX, p[1], CD - p[2]), c = [[C.x0, C.e, C.d0], [C.x1, C.e, C.d0], [C.x1, C.e, C.d1], [C.x0, C.e, C.d1]];
  const roofMat = M.roof.clone(); roofMat.side = THREE.DoubleSide; const pos = [], uv = [];
  for (let i = 0; i < 4; i++) { const A = V(c[i]), B = V(c[(i + 1) % 4]), P = V(apex), u = B.clone().sub(A), L = u.length(); u.normalize();
    const mid = A.clone().add(B).multiplyScalar(.5), h = P.clone().sub(mid); const up = h.clone().sub(u.clone().multiplyScalar(h.dot(u))).length();
    [[A, 0, 0], [B, L, 0], [P, L / 2 + u.dot(P.clone().sub(mid)), up]].forEach(([q, a, b]) => { pos.push(q.x, q.y + .06, q.z); uv.push(a, b); }); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); geo.computeVertexNormals();
  g0r.add(new THREE.Mesh(geo, roofMat));
  c.forEach((p) => bar(g0r, [p[0], p[1] + .08, p[2]], [apex[0], apex[1] + .08, apex[2]], .06, M.gutter));
  for (let i = 0; i < 4; i++) { const a = c[i], b = c[(i + 1) % 4]; bar(g0r, [a[0], a[1] - .02, a[2]], [b[0], b[1] - .02, b[2]], .07, M.gutter); }
  const velux = (i, t, w, l) => { const A = V(c[i]), B = V(c[(i + 1) % 4]), P = V(apex), u = B.clone().sub(A).normalize(), mid = A.clone().add(B).multiplyScalar(.5), up = P.clone().sub(mid);
    let n = new THREE.Vector3().crossVectors(B.clone().sub(A), up).normalize(); if (n.y < 0) { n.negate(); u.negate(); } const z = new THREE.Vector3().crossVectors(u, n);
    const m = new THREE.Mesh(mbox(w, .09, l), M.rl); m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, n, z)); m.position.copy(mid.addScaledVector(up, t)).addScaledVector(n, .1); g0r.add(m); };
  velux(1, .42, .55, .78); velux(3, .42, .55, .78); }
box(G[0], C.x0, C.x1, -.15, .6, 9.78, C.d1, M.brick); box(G[0], C.x1 - .26, C.x1, -.15, .6, C.d0, C.d1, M.brick);
box(G[0], C.x0, C.x0 + .26, -.15, .6, C.d0, 6.88, M.brick); box(G[0], C.x0, C.x0 + .26, -.15, .6, 7.88, C.d1, M.brick);
box(G[0], C.x0, C.x1, .6, 2.28, 9.9, 9.92, M.glass, { noPick: 1 }); box(G[0], C.x1 - .14, C.x1 - .12, .6, 2.28, C.d0, C.d1, M.glass, { noPick: 1 });
box(G[0], C.x0 + .12, C.x0 + .14, .6, 2.28, C.d0, 6.88, M.glass, { noPick: 1 }); box(G[0], C.x0 + .12, C.x0 + .14, .6, 2.28, 7.88, C.d1, M.glass, { noPick: 1 });
box(G[0], C.x0 + .12, C.x0 + .14, 0, 2.1, 6.92, 7.84, M.glass, { noPick: 1 }); box(G[0], C.x0 + .08, C.x0 + .18, 2.1, 2.16, 6.88, 7.88, M.frame);
for (let i = 0; i <= 4; i++) { const x = C.x0 + (C.x1 - C.x0) * i / 4; box(G[0], x - .035, x + .035, .6, 2.31, 9.87, 9.95, M.frame); }
[C.d0, 6.88, 7.88, 8.96, C.d1].forEach((d) => { box(G[0], C.x0 + .09, C.x0 + .17, d < 7 || d > 7.9 ? .6 : 0, 2.31, d - .035, d + .035, M.frame); });
for (let i = 0; i <= 4; i++) { const d = C.d0 + (C.d1 - C.d0) * i / 4; box(G[0], C.x1 - .17, C.x1 - .09, .6, 2.31, d - .035, d + .035, M.frame); }

/* Porch canopy over the front door */
extDone = markExt(); const porchFrom = G[0].children.length;
{ const xl = 2.93, xr = 4.69, xm = 3.81, ye = 2.24, yr = 3.19, d0 = -1.0, d1 = .02, run = xm - xl, L = Math.hypot(run, yr - ye), a = Math.atan2(yr - ye, run);
  [[(xl + xm) / 2, a], [(xm + xr) / 2, -a]].forEach(([x, ang]) => { const m = new THREE.Mesh(mbox(L + .06, .08, d1 - d0), M.roofR); m.rotation.z = ang; m.position.set(x - CX, (ye + yr) / 2 + .05, CD - (d0 + d1) / 2); G[0].add(m); });
  profX(G[0], -1.0, .04, [[xl + .05, ye], [xr - .05, ye], [xm, yr - .03]], M.frame);
  box(G[0], 3.0, 3.08, 1.8, 2.24, -.9, 0, M.timber); box(G[0], 4.54, 4.62, 1.8, 2.24, -.9, 0, M.timber); }

extDone();
for (let i = porchFrom; i < G[0].children.length; i++) Object.assign(G[0].children[i].userData, { n: "z", probe: 1.4 });  // the porch goes when the front wall does
/* Stairs: the main flight rises along the front wall; the loft flight rises front to back over bedroom 2 */
for (let i = 0; i < 13; i++) { const x0 = .37 + i * .2208; box(G[0], x0, x0 + .2208, 0, (i + 1) * .1954, .28, 1.2, M.timber, { rm: "hall" }); }
lo0 = G[1].children.length;
{ const top = (k) => 2.54 + (k + 1) * .2075, bot = (k, d) => Math.max(2.54, Math.min(top(k) - .2, sof(d)));
  box(G[1], 1.21, 1.48, 2.54, top(0), 1.26, 2.2, M.timber, { rm: "landing" });
  const P = [1.21, 2.2], wedges = [[[1.21, 1.26], [.667, 1.26]], [[.667, 1.26], [.2, 1.26], [.2, 1.617]], [[.2, 1.617], [.2, 2.2]]];
  wedges.forEach((pts, k) => { const sh = new THREE.Shape([P, ...pts].map((q) => new THREE.Vector2(q[0] - CX, q[1] - CD))); const y0 = Math.max(2.54, top(k + 1) - .3);
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: top(k + 1) - y0, bevelEnabled: false }), M.timber); m.rotation.x = -Math.PI / 2; m.position.y = y0; m.userData.rm = "landing"; G[1].add(m); });
  for (let k = 4; k < 12; k++) { const d = 2.2 + (k - 4) * .211; box(G[1], d < 2.58 ? .2 : .46, 1.21, bot(k, d), top(k), d, d + .211, M.timber, { rm: "landing" }); } }
for (let i = lo0; i < G[1].children.length; i++) LOFT1.add(G[1].children[i]);

/* ---------- rooms; rid is the dashboard's room id (server/layout.json) ---------- */
const ROOMS = [
  { id: "hall", rid: "hallway", lvl: 0, fl: "wood", slabs: [[.14, 4.41, .26, 2.2]], lp: [3.7, 1.75] },
  { id: "study", rid: "study", lvl: 0, fl: "wood", slabs: [[.14, 3.17, 2.33, 5.58]] },
  { id: "lounge", rid: "lounge", lvl: 0, fl: "wood", slabs: [[3.27, 8.39, 2.23, 5.58]] },
  { id: "kitchen", rid: "kitchen", lvl: 0, fl: "tile", slabs: [[4.51, 8.39, .26, 2.1]], lp: [6.4, 1.3] },
  { id: "utility", rid: "utility", lvl: 0, fl: "laminate", slabs: [[8.65, 11.04, 2.1, 5.58], [8.39, 10.07, .77, 2.1]], lp: [9.7, 3.9] },  // the side extension, apart from the WC
  { id: "wc", rid: "wc", lvl: 0, fl: "tile", slabs: [[10.12, 11.04, .77, 2.1]] },
  { id: "cons", rid: "conservatory", lvl: 0, fl: "laminate", slabs: [[7.61, 11.04, 5.84, 9.78]] },
  { id: "landing", rid: "landing", lvl: 1, fl: "carpet", col: 0xb8b0a2, slabs: [[1.48, 6.36, 1.24, 2.12], [3.22, 5.25, .26, 1.24], [.13, 1.48, 1.18, 1.31]], lp: [4.2, 1.5] },
  { id: "cpd", rid: null, lvl: 1, fl: "boards", slabs: [[.13, .92, .26, 1.18], [1.02, 1.92, .26, 1.18], [5.3, 5.81, .26, 1.13]] },
  { id: "bed2", rid: "bed2", lvl: 1, fl: "carpet", col: 0x9aa6a0, slabs: [[1.58, 3.18, 2.22, 5.58], [.13, 1.58, 2.88, 5.58]], lp: [2.4, 4.4] },
  { id: "bed3", rid: "bed3", lvl: 1, fl: "carpet", col: 0xa8a08e, slabs: [[3.28, 5.32, 2.22, 5.58]] },
  { id: "bed4", rid: "bed4", lvl: 1, fl: "carpet", col: 0x98a2ad, slabs: [[5.42, 8.38, 2.22, 5.58]] },
  { id: "bath", rid: "bathroom", lvl: 1, fl: "tile", slabs: [[5.91, 8.38, .26, 1.13], [6.46, 8.38, 1.13, 2.12]], lp: [7.3, 1.3] },
  { id: "bed1", rid: "bed1", lvl: 2, fl: "carpet", col: 0xa49a88, slabs: [[1.58, 6.47, 1.27, 5.52], [5.57, 6.47, .39, 1.27]], lp: [4.0, 3.4] },
  { id: "ensuite", rid: "ensuite1", lvl: 2, fl: "tile", slabs: [[6.57, 8.39, 1.74, 5.52]] },
  { id: "tank", rid: "tank", lvl: 2, fl: "boards", slabs: [[6.57, 8.39, .39, 1.66]], lp: [7.48, 1.0] },
  { id: "eaves", rid: "storage", lvl: 2, fl: "boards", slabs: [[1.58, 5.47, .39, 1.18]] },
  { id: "llanding", rid: "loft-stairs", lvl: 2, fl: "carpet", col: 0xb8b0a2, slabs: [[.29, 1.48, 3.89, 5.52]] },
];
// a soft round pool of light, laid on a room's own floor: unlike a point light it can't reach the next room
const glowT = (() => { const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d"), g = x.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(.6, "rgba(255,255,255,.5)"); g.addColorStop(1, "rgba(255,255,255,.08)");
  x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
/* Room cards: name, temperature and a dot per light, painted on a card that floats a metre above the
   room's biggest floor area and is cut to fit inside it, so nothing spills into the next room. */
const CARD_PX = 160;  // canvas pixels per metre
function makeCard(r) {
  const s = r.slabs.reduce((m, q) => (q[1] - q[0]) * (q[3] - q[2]) > (m[1] - m[0]) * (m[3] - m[2]) ? q : m);
  const w = Math.min(s[1] - s[0] - .16, 3.0), h = Math.min(s[3] - s[2] - .16, 1.25);
  const c = document.createElement("canvas"); c.width = Math.round(w * CARD_PX); c.height = Math.round(h * CARD_PX);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = aniso;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2;  // lies flat; drawn on top so stairs or a tall fridge can't hide it, text reading upright with the back of the house at the top
  m.position.set((s[0] + s[1]) / 2 - CX, LV[r.lvl] + 1.0, CD - (s[2] + s[3]) / 2); m.renderOrder = 5;
  m.userData.room = r; m.userData.card = 1; G[r.lvl].add(m);
  r.card = { mesh: m, canvas: c, tex: t };
}
// The card: name, temperature now, a "− Set 20.0° +" row for rooms with heating, and a dot per light.
// Where each control lands is kept in r.card.hits, so a tap on the card can work it (see pointerup).
function drawCard(r, name, temp, heat, lights, sel, sp) {
  const { canvas: c, tex } = r.card, x = c.getContext("2d"), W = c.width, H = c.height, hits = r.card.hits = [];
  x.clearRect(0, 0, W, H);
  const sub = temp == null ? "" : temp.toFixed(1) + "°" + (heat ? " · heating" : "");
  const rows = 1 + (sub ? .85 : 0) + (sp != null ? 1.15 : 0) + (lights.length ? 1 : 0);
  let fs = Math.min(H / (rows * 1.1 + .7), 46);
  const F = (w, k) => `${w} ${fs * k}px Inter, system-ui, sans-serif`;
  const width = () => { x.font = F(600, 1); const a = x.measureText(name).width; x.font = F(500, .74);
    return Math.max(a, x.measureText(sub).width, sp != null ? fs * 5.9 : 0, lights.length * fs); };
  while (width() > W * .88 && fs > 9) fs -= 1;
  const lh = [fs * 1.15, sub ? fs * .92 : 0, sp != null ? fs * 1.3 : 0, lights.length ? fs * 1.1 : 0];
  const th = lh.reduce((a, b) => a + b, 0), cw = Math.min(W - 4, width() + fs * 1.1), ch = Math.min(H - 4, th + fs * .6), cx = W / 2, top = (H - ch) / 2;
  x.fillStyle = "rgba(11,14,18,.8)"; x.strokeStyle = sel ? "#4cc9f0" : lights.some((l) => l.on) ? "rgba(255,181,71,.8)" : "rgba(255,255,255,.18)";
  x.lineWidth = Math.max(2, fs * .07); x.beginPath();
  if (x.roundRect) x.roundRect((W - cw) / 2, top, cw, ch, Math.min(ch / 2, fs * .6)); else x.rect((W - cw) / 2, top, cw, ch);
  x.fill(); x.stroke();
  x.textAlign = "center"; x.textBaseline = "middle"; let y = top + fs * .3;
  x.font = F(600, 1); x.fillStyle = "#eef1f5"; x.fillText(name, cx, y + lh[0] / 2); y += lh[0];
  if (sub) { x.font = F(500, .74); x.fillStyle = heat ? "#ff6b4a" : "#a8b1bd"; x.fillText(sub, cx, y + lh[1] / 2); y += lh[1]; }
  if (sp != null) {
    const yc = y + lh[2] / 2, br = fs * .46, gap = fs * 2.35;
    [[-1, "−"], [1, "+"]].forEach(([s, g]) => { const bx = cx + s * gap;
      x.beginPath(); x.arc(bx, yc, br, 0, 7); x.fillStyle = "rgba(255,255,255,.12)"; x.fill();
      x.font = F(600, .8); x.fillStyle = "#eef1f5"; x.fillText(g, bx, yc + fs * .02);
      hits.push({ kind: "sp", to: Math.round((sp + s * .5) * 2) / 2, x: bx, y: yc, r: br * 1.5 }); });
    x.font = F(600, .72); x.fillStyle = "#ffb08f"; x.fillText(`Set ${sp.toFixed(1)}°`, cx, yc);
    y += lh[2];
  }
  if (lights.length) { const g = fs, x0 = cx - (lights.length - 1) * g / 2, yc = y + lh[3] / 2;
    lights.forEach((l, i) => { const bx = x0 + i * g; x.beginPath(); x.arc(bx, yc, fs * .26, 0, 7);
      x.fillStyle = l.on ? "#ffb547" : "#3a4552"; x.shadowColor = l.on ? "#ffb547" : "transparent"; x.shadowBlur = l.on ? fs * .45 : 0; x.fill(); x.shadowBlur = 0;
      x.lineWidth = Math.max(1.5, fs * .05); x.strokeStyle = "rgba(255,255,255,.35)"; x.stroke();
      hits.push({ kind: "light", id: l.id, on: l.on, x: bx, y: yc, r: g * .55 }); }); }
  tex.needsUpdate = true;
}
const byId = {}, byRid = {};
ROOMS.forEach((r) => {
  byId[r.id] = r; if (r.rid) byRid[r.rid] = r;
  r.mat = FLOOR[r.fl].clone(); if (r.col) r.mat.color.set(r.col);
  const top = LV[r.lvl], y0 = r.lvl === 0 ? -.12 : top - .15; r.meshes = [];
  r.slabs.forEach((s) => r.meshes.push(box(G[r.lvl], s[0], s[1], y0, top, s[2], s[3], r.mat, { room: r })));
  const s = r.slabs[0], lp = r.lp || [(s[0] + s[1]) / 2, (s[2] + s[3]) / 2]; r.c = lp;
  if (!r.rid) return;
  if (r.rid !== "storage") makeCard(r);  // no label for storage spaces
  if (r.rid !== "tank" && r.rid !== "storage") {  // the room's light: a warm pool on each part of its floor; brightness follows its lamps
    r.glow = new THREE.MeshBasicMaterial({ map: glowT, color: 0xffa860, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    r.slabs.forEach((q) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(q[1] - q[0] - .04, q[3] - q[2] - .04), r.glow); m.rotation.x = -Math.PI / 2;
      m.position.set((q[0] + q[1]) / 2 - CX, top + .012, CD - (q[2] + q[3]) / 2); m.renderOrder = 2; m.userData.noPick = 1; G[r.lvl].add(m); });
  }
});
house.traverse((o) => { if (o.isMesh && o.userData.rm) o.userData.room = byId[o.userData.rm]; });

/* ---------- fixtures (positions as drawn on the plans) ---------- */
function F(id, x0, x1, h0, h1, d0, d1, mat) { const r = byId[id]; return box(G[r.lvl], x0, x1, LV[r.lvl] + h0, LV[r.lvl] + h1, d0, d1, mat, { room: r }); }
F("kitchen", 4.51, 8.39, 0, .86, .26, .88, M.units); F("kitchen", 4.51, 8.39, .86, .9, .26, .9, M.top);
F("kitchen", 5.15, 6.2, .9, .91, .34, .82, M.steel); F("kitchen", 7.24, 7.76, .9, .915, .34, .82, M.dark);
F("utility", 8.66, 9.27, 0, 1.85, 3.37, 3.98, M.steel);
F("utility", 10.42, 11.04, 0, .86, 2.4, 4.4, M.units); F("utility", 10.4, 11.04, .86, .9, 2.4, 4.4, M.top);
F("lounge", 4.4, 6.4, 0, .42, 2.4, 3.2, M.sofa); F("lounge", 4.4, 6.4, .42, .85, 2.36, 2.6, M.sofa); F("lounge", 5.0, 5.9, 0, .4, 3.6, 4.2, M.timber);
F("study", .73, 2.43, .72, .76, 5.05, 5.58, M.timber); F("study", .73, .78, 0, .72, 5.05, 5.58, M.timber); F("study", 2.38, 2.43, 0, .72, 5.05, 5.58, M.timber);
F("wc", 10.4, 10.78, 0, .4, .98, 1.45, M.san); F("wc", 10.35, 10.83, .4, .8, .8, .98, M.san); F("wc", 10.12, 10.48, .8, .88, 1.59, 1.97, M.san);
F("cons", 8.1, 8.8, 0, .75, 8.6, 9.3, M.sofa); F("cons", 9.9, 10.6, 0, .75, 8.6, 9.3, M.sofa); F("cons", 9.1, 9.6, 0, .45, 8.8, 9.3, M.timber);
const bed = (id, x0, x1, dh, df, flip) => { const a = Math.min(dh, df), b = Math.max(dh, df); F(id, x0, x1, 0, .45, a, b, M.linen); F(id, x0, x1, 0, .25, a, b, M.bedf);
  const hb = flip ? [a, a + .08] : [b - .08, b], pw = flip ? [a + .15, a + .55] : [b - .55, b - .15]; F(id, x0, x1, .25, .95, hb[0], hb[1], M.bedf); F(id, x0 + .1, x1 - .1, .45, .55, pw[0], pw[1], M.san); };
bed("bed3", 3.55, 4.45, 3.6, 5.55); bed("bed4", 6.2, 7.6, 3.6, 5.55); bed("bed1", 3.15, 4.95, 2.05, 4.05, true);
F("bed2", .46, 2.36, 0, .25, 2.92, 4.27, M.bedf); F("bed2", .46, 2.36, .25, .45, 2.92, 4.27, M.linen); F("bed2", .46, .54, .25, .95, 2.92, 4.27, M.bedf); F("bed2", .6, 1.0, .45, .55, 3.02, 4.17, M.san);
F("bath", 7.65, 8.31, 0, .55, .3, 1.72, M.san); F("bath", 7.0, 7.4, 0, .4, .48, .97, M.san); F("bath", 7.0, 7.4, .4, .8, .3, .48, M.san); F("bath", 5.92, 6.26, .8, .88, .48, .89, M.san);
F("ensuite", 6.7, 8.3, 0, .06, 4.61, 5.51, M.san); F("ensuite", 6.6, 8.06, 0, .55, 1.76, 2.45, M.san); F("ensuite", 8.06, 8.39, 0, .9, 1.76, 2.45, M.timber);
F("ensuite", 7.38, 7.88, 0, .4, 3.06, 3.39, M.san); F("ensuite", 7.88, 8.1, .0, .8, 3.0, 3.45, M.san); F("ensuite", 7.95, 8.39, .8, .88, 3.95, 4.45, M.san);
box(G[2], 6.7, 7.6, LV[2] + .06, LV[2] + 2.0, 4.6, 4.62, M.glass, { noPick: 1 });

/* Hot-water cylinder: its colour follows the tank temperature */
const tankMat = S({ color: 0xd8dcde, roughness: .35, metalness: .3 });
{ const cyl = new THREE.Mesh(new THREE.CylinderGeometry(.25, .25, 1.3, 20), tankMat); cyl.rotation.z = Math.PI / 2;
  cyl.position.set(7.48 - CX, LV[2] + .27, CD - 1.25); cyl.userData.room = byId.tank; G[2].add(cyl); }

/* Under the 3 m dormer window (sill 0.89 m up): the Panasonic RAC Solo under its left half, the radiator under
   its right half. The aircon's strip shows heat or cool; the radiator glows when the room is calling for heat. */
const acStrip = S({ color: 0x3a4552, roughness: .3 }), radMat = S({ color: 0xf2f2ee, roughness: .45 });
F("bed1", 2.95, 3.85, .12, .67, 5.27, 5.44, S({ color: 0xf4f5f3, roughness: .3 }));   // ~900 × 550 × 170 mm
F("bed1", 3.03, 3.77, .6, .63, 5.25, 5.27, acStrip);
F("bed1", 4.55, 5.55, .15, .75, 5.34, 5.44, radMat);                                    // ~1000 × 600 panel radiator
[4.6, 5.5].forEach((x) => F("bed1", x, x + .03, .05, .15, 5.36, 5.39, M.steel));          // valves

/* Blinds: closing panels over the rooflights and inside the dormer window, sized by position (0 open … 100 closed) */
const blinds = {};
function setBlind(id, pos) {
  const f = Math.max(0, Math.min(100, pos || 0)) / 100, b = blinds[id];
  if (b && Math.abs(b.f - f) < .005) return false;
  if (b && b.mesh) { b.mesh.parent.remove(b.mesh); b.mesh.geometry.dispose(); forgetWall(b.mesh); }
  let mesh = null;
  if (f > .01) {
    if (ROOFLIGHTS[id]) { const [a, c] = ROOFLIGHTS[id]; mesh = slope(G[3], a + .03, c - .03, 2.51, 2.51 - .74 * f, M.blind, .012, .142); }
    else if (id === "blind-dormer") { const top = 4.91 + 2.39 - .06; mesh = box(G[2], 2.7, 5.58, top - 1.26 * f, top, 5.4, 5.42, M.blind, { room: byId.bed1 });
      measureWall(mesh, 2); }
  }
  blinds[id] = { f, mesh }; return true;
}

/* ---------- surroundings ---------- */
const ground = new THREE.Mesh(new THREE.CircleGeometry(48, 72), M.grass); ground.rotation.x = -Math.PI / 2; ground.position.y = -.16; ground.receiveShadow = true; scene.add(ground);
/* Grounds, measured from Google's satellite view (about 20 px a metre, checked against the house's own
   size) and Street View (June 2025); good to about a metre. Same (x, d) as the house. */
const yard = new THREE.Group(); scene.add(yard);
{
  const lin = (h) => new THREE.Color(h).convertSRGBToLinear();
  const gravelT = tex(256, 256, (x, w, h) => { x.fillStyle = "#a8936d"; x.fillRect(0, 0, w, h);
    for (let k = 0; k < 6000; k++) { const s = 1 + rnd() * 2.5; x.fillStyle = rgb([176, 158, 124], (rnd() - .5) * 80); x.fillRect(rnd() * w, rnd() * h, s, s); } }, 1 / 1.5, 1 / 1.5);
  const lawnT = tex(256, 256, (x, w, h) => { x.fillStyle = "#56763f"; x.fillRect(0, 0, w / 2, h); x.fillStyle = "#4c6b37"; x.fillRect(w / 2, 0, w / 2, h);  // mowing stripes
    for (let k = 0; k < 4000; k++) { x.fillStyle = rgb([84, 114, 60], (rnd() - .5) * 46); x.fillRect(rnd() * w, rnd() * h, 1, 3); } }, 1 / 2.4, 1 / 2.4);
  const slabT = tex(256, 256, (x, w, h) => { x.fillStyle = "#837d70"; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { x.fillStyle = rgb([186, 178, 160], (rnd() - .5) * 20); x.fillRect(i * 128 + 3, j * 128 + 3, 122, 122); } }, 1 / 1.2, 1 / 1.2);
  const tarT = tex(256, 256, (x, w, h) => { x.fillStyle = "#3d3f42"; x.fillRect(0, 0, w, h);
    for (let k = 0; k < 5000; k++) { x.fillStyle = rgb([66, 68, 71], (rnd() - .5) * 34); x.fillRect(rnd() * w, rnd() * h, 1.5, 1.5); } }, 1 / 2, 1 / 2);
  const paveT = tex(256, 256, (x, w, h) => { x.fillStyle = "#6d6e70"; x.fillRect(0, 0, w, h);
    for (let k = 0; k < 4000; k++) { x.fillStyle = rgb([112, 113, 115], (rnd() - .5) * 30); x.fillRect(rnd() * w, rnd() * h, 1.5, 1.5); } }, 1 / 2, 1 / 2);
  const boardT = tex(256, 256, (x, w, h) => { const n = 10, bw = w / n;  // close-board fence: ten boards a metre
    for (let i = 0; i < n; i++) { x.fillStyle = rgb([118, 88, 58], (rnd() - .5) * 26); x.fillRect(i * bw, 0, bw, h); x.fillStyle = "rgba(0,0,0,.28)"; x.fillRect(i * bw + bw - 3, 0, 2, h); } }, 1, 1);
  const ribT = tex(128, 128, (x, w, h) => { x.fillStyle = "#2c4f37"; x.fillRect(0, 0, w, h); x.fillStyle = "#3a6547"; for (let i = 0; i < 4; i++) x.fillRect(i * 32 + 4, 0, 10, h); }, 1 / .5, 1);
  const Y = {
    gravel: S({ map: gravelT, roughness: 1 }), lawn: S({ map: lawnT, roughness: 1 }), slabs: S({ map: slabT, roughness: .9 }),
    tarmac: S({ map: tarT, roughness: .95, side: THREE.DoubleSide }), pave: S({ map: paveT, roughness: .95, side: THREE.DoubleSide }),
    path: S({ map: gravelT, roughness: 1, side: THREE.DoubleSide }), boards: S({ map: boardT, roughness: .9 }), green: S({ map: ribT, roughness: .55, metalness: .2 }),
    post: S({ color: lin(0x5b4330), roughness: .9 }), picket: S({ color: lin(0xb88d5a), roughness: .8 }), shed: S({ map: boardT, color: 0x8a8f86, roughness: .9 }),
    felt: S({ color: lin(0x2b2e31), roughness: .8 }), trunk: S({ color: lin(0x4a3a2a), roughness: 1 }), lamp: S({ color: lin(0x6e7377), roughness: .5, metalness: .4 }),
    leaf: [0x3d5a2c, 0x46632f, 0x355226, 0x4f6b33].map((c) => S({ color: lin(c), roughness: 1, flatShading: true })),
    birch: S({ color: lin(0x8a9a3c), roughness: 1, flatShading: true }),
  };
  const V2 = (x, d) => new THREE.Vector2(x - CX, d - CD);  // shape coords; rotated flat, shape y becomes −Z
  const flat = (pts, y, mat) => { const m = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, d]) => V2(x, d)))), mat);
    m.rotation.x = -Math.PI / 2; m.position.y = y; m.receiveShadow = true; yard.add(m); return m; };
  // a flat band along a polyline, from offset o0 to o1 (metres, + = towards the road / east)
  const ribbon = (pts, o0, o1, y, mat) => {
    const pos = [], uv = [], idx = []; let run = 0;
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b[0] - a[0], td = b[1] - a[1]; const L = Math.hypot(tx, td); tx /= L; td /= L;
      if (i) run += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      [o0, o1].forEach((o) => { pos.push(p[0] + td * o - CX, y, CD - (p[1] - tx * o)); uv.push(run, o); });
      if (i) { const k = 2 * i; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    });
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; yard.add(m); return m;
  };
  // a box running from a to b (each [x, d]), y0..y1 high, t thick
  const seg = (a, b, y0, y1, t, mat) => {
    const dx = b[0] - a[0], dd = b[1] - a[1], L = Math.hypot(dx, dd);
    const m = new THREE.Mesh(mbox(L, y1 - y0, t), mat); m.position.set((a[0] + b[0]) / 2 - CX, (y0 + y1) / 2, CD - (a[1] + b[1]) / 2);
    m.rotation.y = Math.atan2(dd, dx); m.castShadow = m.receiveShadow = true; yard.add(m); return m;
  };
  const along = (a, b, step, fn) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / step));
    for (let i = 0; i <= n; i++) fn([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], i, n); };
  const nudge = (p, a, b, s) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]); return [p[0] + (b[0] - a[0]) / L * s, p[1] + (b[1] - a[1]) / L * s]; };
  const G0 = -.16;
  const closeBoard = (pts, h = 1.8, mat = Y.boards) => { for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i];
    seg(a, b, G0 + .15, G0 + h, .04, mat); seg(a, b, G0, G0 + .15, .05, Y.post);
    along(a, b, 1.83, (p) => seg(nudge(p, a, b, -.05), nudge(p, a, b, .05), G0, G0 + h + .08, .1, Y.post)); } };
  const picket = (pts, h = 1.0) => { for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i];
    [.25, .75].forEach((r) => seg(a, b, G0 + h * r, G0 + h * r + .07, .03, Y.picket));
    along(a, b, .13, (p) => seg(nudge(p, a, b, -.037), nudge(p, a, b, .037), G0, G0 + h, .02, Y.picket)); } };
  const brickWall = (a, b, h = .9) => { seg(a, b, G0, G0 + h, .23, M.brick); seg(a, b, G0 + h, G0 + h + .06, .3, M.sill);
    along(a, b, 2.5, (p) => { seg(nudge(p, a, b, -.17), nudge(p, a, b, .17), G0, G0 + h + .12, .34, M.brick);
      seg(nudge(p, a, b, -.2), nudge(p, a, b, .2), G0 + h + .12, G0 + h + .18, .4, M.sill); }); };
  const tree = (x, d, r, h, mat) => {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(.09 + r * .04, .14 + r * .05, h * .55, 7), Y.trunk); t.position.set(x - CX, G0 + h * .275, CD - d);
    const c = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat); c.position.set(x - CX, G0 + h - r * .8, CD - d); c.scale.y = .85;
    c.rotation.set(rnd() * 3, rnd() * 3, 0); [t, c].forEach((m) => { m.castShadow = m.receiveShadow = true; yard.add(m); });
  };

  /* the road curves round past the front; property line at the back of the pavement */
  const front = [[-17, -7.0], [-8.65, -8.5], [-.15, -10.2], [6.14, -11.6], [12.2, -14.4], [17.2, -18.2], [21, -22.8], [23.5, -28]];
  ribbon(front, 0, 1.7, G0 + .07, Y.pave);          // pavement, a kerb's height up
  ribbon(front, 1.7, 7.4, G0 + .01, Y.tarmac);      // road
  { const l = new THREE.Mesh(new THREE.CylinderGeometry(.06, .08, 5.6, 8), Y.lamp); l.position.set(6.7 - CX, G0 + 2.8, CD + 12.4); l.castShadow = true; yard.add(l);
    const hd = new THREE.Mesh(new THREE.BoxGeometry(.5, .12, .22), Y.lamp); hd.position.set(6.7 - CX, G0 + 5.6, CD + 12.2); hd.castShadow = true; yard.add(hd); }

  /* the line between us and number 33: brick wall with piers along the drive, side gate, green
     panels beside the side passage, close-board fence to the back. One straight line on the satellite view. */
  const nb = (d) => [13.7 + (d - 2.2) * .548, d];
  const F2 = nb(-11.6), W1 = nb(.8), N1 = nb(6.4), NW = nb(24.5), SW = [1.1, 24.5], SH = [0, MW];

  /* front: gravel drive to the pavement; 33's tarmac drive and 31's parking for context */
  flat([[-.15, 0], [MX, 0], [MX, .51], [SX, .51], W1, F2, [-.15, -10.2]], G0 + .02, Y.gravel);
  flat([F2, W1, [19.5, -2.6], [12.2, -14.4]], G0 + .015, Y.tarmac);
  brickWall(F2, W1);
  closeBoard([[SX, .55], W1]);                                   // side gate
  closeBoard([W1, N1], 1.8, Y.green);
  closeBoard([N1, NW, SW, SH]);                                  // to the back, across, and back along 31's side
  picket([[-.15, -.15], [-.15, -10.1]]);                          // timber fence between us and 31, house to road

  /* back garden: lawn, patio behind the house and round the conservatory, side passage, curved gravel path to the shed */
  flat([SH, SW, NW, W1, [SX, .55], [SX, MW]], G0 + .01, Y.lawn);
  { const deckT = tex(256, 256, (x, w, h) => { const n = 8, bw = w / n; for (let i = 0; i < n; i++) { x.fillStyle = rgb([150, 138, 120], (rnd() - .5) * 22); x.fillRect(i * bw, 0, bw - 3, h);
      x.fillStyle = "rgba(0,0,0,.18)"; for (let k = 0; k < 18; k++) x.fillRect(i * bw + rnd() * bw, rnd() * h, 1, 6 + rnd() * 20); } }, 1 / 1.16, 1 / 2);
    const deck = S({ map: deckT, roughness: .9 });
    box(yard, .3, 7.35, G0, -.03, MW, 10.04, deck).receiveShadow = true;  // to the back of the conservatory; top just below the floor
    seg([.3, 10.04], [7.35, 10.04], G0, -.03, .03, Y.post); seg([.3, MW], [.3, 10.04], G0, -.03, .03, Y.post); }
  flat([[SX, .6], [12.9, .8], [12.9, 10.04], [SX, 10.04]], G0 + .025, Y.slabs);
  { const c = new THREE.CatmullRomCurve3([[12.1, 10.0], [13.6, 12.6], [15.7, 16.5], [17.1, 19.4], [18.3, 20.6]].map(([x, d]) => new THREE.Vector3(x, 0, d)));
    ribbon(c.getPoints(24).map((v) => [v.x, v.z]), -.55, .55, G0 + .02, Y.path); }
  { const ang = Math.atan2(.548, 1), u = [Math.sin(ang), Math.cos(ang)];  // sheds sit square to the boundary
    const shed = (cx, cd, len, wid, h, mat) => {
      const a = [cx - u[0] * len / 2, cd - u[1] * len / 2], b = [cx + u[0] * len / 2, cd + u[1] * len / 2];
      seg(a, b, G0, G0 + h, wid, mat); seg(nudge(a, a, b, -.12), nudge(b, a, b, .12), G0 + h, G0 + h + .1, wid + .25, Y.felt); };
    shed(20.8, 20.4, 3.6, 2.6, 2.2, Y.shed);                     // the outbuilding in the north-west corner
    shed(17.6, 22.6, 2.4, 1.8, 1.8, Y.boards); }
  tree(14.6, 21.6, 1.8, 4.6, Y.birch);

  /* trees: the wooded strip along the A34 beyond the back fence, and in 31's back garden */
  for (let i = 0; i < 16; i++) for (let row = 0; row < 2; row++) {
    const x = -14 + i * 2.9 + (rnd() - .5) * 1.6, d = 26.2 + row * 3.6 + (rnd() - .5) * 1.4;
    tree(x, d, 1.8 + rnd() * 1.4, 6 + rnd() * 5, Y.leaf[(i + row) % 4]);
  }
  [[-6.5, 19.5], [-3.2, 22.4], [-8.4, 23.6], [-2.4, 17.2]].forEach(([x, d], i) => tree(x, d, 1.6 + rnd(), 4.5 + rnd() * 2.5, Y.leaf[i % 4]));
}
/* Number 31: the other half of the pair, drawn as a greyed-out mirror of the main house (not the side
   extension or conservatory), solid rather than see-through. Floors and walls only, no furniture. */
const WALLMATS = new Set([M.brick, M.plaster, M.party, M.hang, M.frame, M.glass, M.door, M.sill, M.roofR, M.blind]);
// walls, windows and wall-mounted things; timber that isn't furniture (stairs, built-in shelves) is cut too, like stairs on a plan
const cuttable = (o) => o.userData.nbr ? !!o.userData.cut : !!(o.userData.mount || WALLMATS.has(o.material) || (o.material === M.timber && (!o.userData.room || o.userData.rm)));
const NG = [];
{
  const nbr = new THREE.Group(); nbr.scale.x = -1; nbr.position.x = -2 * CX; nbrScene.add(nbr);  // x → −x about the party wall
  for (let l = 0; l < 4; l++) { NG[l] = new THREE.Group(); nbr.add(NG[l]); }
  house.traverse((o) => { if (o.isMesh && o.userData.rm) o.userData.room = byId[o.userData.rm]; });
  scene.updateMatrixWorld(true);
  const cache = new Map(), bb = new THREE.Box3(), roomMats = new Set(ROOMS.map((r) => r.mat)), owned = new Map();
  const own = (m) => { if (!owned.has(m)) owned.set(m, m.clone()); return owned.get(m); };  // their floors don't light up with ours
  // blurred: shrink each texture and blow it back up, then drain the colour and wash it towards grey
  const soften = (img) => { const w = img.width, h = img.height, t = document.createElement("canvas"); t.width = Math.max(4, w >> 3); t.height = Math.max(4, h >> 3);
    t.getContext("2d").drawImage(img, 0, 0, t.width, t.height);
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(t, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h), p = d.data;
    for (let i = 0; i < p.length; i += 4) { const l = .3 * p[i] + .59 * p[i + 1] + .11 * p[i + 2];
      for (let k = 0; k < 3; k++) p[i + k] = (l + (p[i + k] - l) * .15) * .6 + 168 * .4; }
    x.putImageData(d, 0, 0); return c; };
  const grey = (m) => {
    if (!cache.has(m)) {
      let g;
      if (m === M.glass) g = S({ color: 0x8a9097, roughness: .9 });
      else if (m.map) { const t = m.map.clone(); t.source = new THREE.Source(soften(m.map.image)); t.needsUpdate = true; g = S({ map: t, roughness: 1 }); }  // own image: clones share theirs
      else { const c = m.color.clone(), hsl = {}; c.getHSL(hsl); c.setHSL(hsl.h, hsl.s * .12, hsl.l * .7 + .2); g = S({ color: c, roughness: 1 }); }
      cache.set(m, g);
    }
    return cache.get(m);
  };
  G.forEach((g, l) => g.children.forEach((o) => {
    // the outside walls of the two storeys only: nothing inside, no window frames or sills, none of our loft or roof
    // ground and first floors: everything of ours, mirrored (rooms, stairs, furniture), apart from the loft conversion's
    // stair, our room labels and light pools; the outside shell soft and grey, without window frames or sills
    if (!o.isMesh || l > 1 || LOFT1.has(o) || o.userData.card || o.material.blending === THREE.AdditiveBlending) return;
    if (EXT.has(o) && (o.material === M.frame || o.material === M.sill)) return;
    bb.setFromObject(o);   // the main house only: not the side extension or the conservatory (which sits behind it)
    if (bb.min.x < -CX - .05 || bb.max.x > MX + .3 - CX || bb.min.z < CD - (MW + .45) || bb.max.z > CD + 1.1) return;
    const ud = o.userData; o.userData = {};   // clone() deep-copies userData as JSON, and ours holds room objects
    const c = o.clone(); o.userData = ud;
    c.material = EXT.has(o) ? grey(o.material) : roomMats.has(o.material) ? own(o.material) : o.material;
    const stair = o.material === M.timber && !!ud.rm;   // their stairs stay up, so you can see what the wagon is riding down
    c.userData = { nbr: 1, cut: cuttable(o) && !stair, n: ud.n, probe: ud.probe }; NG[l].add(c);
  }));
  // their roof: plain pitched front and back with the end gable and chimney (they have no loft conversion)
  const roofG = grey(M.roof), brickG = grey(M.brick), gutG = grey(M.gutter);
  slope(NG[3], 0, 8.9, 2.92, -.3, roofG); slope(NG[3], 0, 8.9, 2.92, 6.14, roofG);
  prof(NG[2], 8.39, .26, [[0, 4.75], [5.84, 4.75], [2.92, 7.92]], brickG);
  box(NG[3], 7.84, 8.65, 6.9, 9.28, 2.6, 3.4, brickG);
  box(NG[3], 0, 8.9, 4.45, 4.6, -.42, -.3, gutG); box(NG[3], 0, 8.9, 4.45, 4.6, 6.14, 6.26, gutG);
  const shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  nbrProxy = new THREE.Group(); scene.add(nbrProxy);
  [box(nbrProxy, -MX, 0, -.15, 4.75, 0, MW, shadowOnly), prof(nbrProxy, -8.9, 8.9, [[-.3, 4.57], [6.14, 4.57], [2.92, 7.92]], shadowOnly)]
    .forEach((m) => { m.castShadow = true; m.receiveShadow = false; });
}

/* ---------- Meanwhile, at number 31 ----------
   A joke, kept blurred (see draw(); five clicks on the house name lifts it). Everything is placed in our own room
   coordinates and the mirror puts it on their side. Ground and first floors are our rooms mirrored; the loft is just a loft. */
{
  const lin = (h) => new THREE.Color(h).convertSRGBToLinear(), mk = (c, r = .8) => S({ color: lin(c), roughness: r });
  const glowM = (c) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
  const add = (g, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m; };
  const cyl = (g, r0, r1, h, mat, x, y, z, rx, rz) => add(g, new THREE.CylinderGeometry(r0, r1, h, 10), mat, x, y, z, rx || 0, 0, rz || 0);
  const ball = (g, r, mat, x, y, z) => add(g, new THREE.SphereGeometry(r, 14, 10), mat, x, y, z);
  const cube = (g, w, h, d, mat, x, y, z, ry) => add(g, new THREE.BoxGeometry(w, h, d), mat, x, y, z, 0, ry || 0);
  const place = (obj, l, x, d, y, fx, fd) => { obj.position.set(x - CX, y, CD - d); if (fx != null) obj.rotation.y = Math.atan2(fx, -fd); NG[l].add(obj); return obj; };
  const BONE = mk(0xe8e2d0, .6);

  // a stylised person (or skeleton), feet at y=0, facing +z. pose: stand | sit | lie. armsUp: true, 1 or -1 (one arm)
  function figure(o = {}) {
    const g = new THREE.Group(), sk = o.skeleton, k = sk ? .55 : 1, sit = o.pose === "sit";
    const skin = sk ? BONE : mk(o.skin || 0xe0b49a), top = sk ? BONE : mk(o.top || 0x3b6ea8), legs = sk ? BONE : mk(o.legs || 0x2b2f3a);
    if (sit) [-.1, .1].forEach((x) => { cyl(g, .075 * k, .07 * k, .42, legs, x, .45, .2, Math.PI / 2); cyl(g, .07 * k, .06 * k, .45, legs, x, .22, .41); });
    else [-.1, .1].forEach((x) => cyl(g, .075 * k, .065 * k, .85, legs, x, .425, 0));
    const hip = sit ? .45 : .85;
    if (sk) { cyl(g, .025, .025, .6, BONE, 0, hip + .3, 0); [0, 1, 2, 3].forEach((i) => add(g, new THREE.TorusGeometry(.13 - i * .015, .014, 6, 14), BONE, 0, hip + .32 + i * .08, 0, Math.PI / 2)); }
    else cyl(g, .19, .16, .6, top, 0, hip + .3, 0);
    ball(g, sk ? .11 : .13, skin, 0, hip + .78, 0);
    if (!sk) ball(g, .135, mk(o.hair || 0x3a2a1e), 0, hip + .82, -.025).scale.set(1, .72, 1);
    const sh = hip + .55;
    [-1, 1].forEach((sd) => {
      const up = o.armsUp === true || o.armsUp === sd, fwd = o.armsForward;
      const a = cyl(g, .055 * k, .05 * k, .6, top, sd * .25, up ? sh + .27 : sh - .28, 0, 0, up ? -sd * .35 : sd * .12);
      if (fwd && !up) { a.rotation.set(-Math.PI / 2.4, 0, 0); a.position.set(sd * .2, sh - .1, .24); }
    });
    if (o.pose === "lie") { const w = new THREE.Group(); g.rotation.x = -Math.PI / 2; w.add(g); return w; }  // head towards −z… see bed()
    return g;
  }
  // a speech bubble: always faces you, text the right way round (sprites ignore the mirror)
  function bubble(l, x, d, y, text, col) {
    const c = document.createElement("canvas"), x2 = c.getContext("2d"), fs = 44; x2.font = `700 ${fs}px Inter, system-ui, sans-serif`;
    const w = Math.ceil(x2.measureText(text).width + fs * 1.2), h = Math.ceil(fs * 1.9); c.width = w; c.height = h + 18;
    const g = c.getContext("2d"); g.fillStyle = col || "#ffffff"; g.beginPath(); if (g.roundRect) g.roundRect(2, 2, w - 4, h - 4, h / 2.4); else g.rect(2, 2, w - 4, h - 4); g.fill();
    g.beginPath(); g.moveTo(w * .3, h - 6); g.lineTo(w * .26, h + 16); g.lineTo(w * .42, h - 6); g.fill();
    g.font = `700 ${fs}px Inter, system-ui, sans-serif`; g.fillStyle = "#14171c"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, w / 2, h / 2);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, toneMapped: false })); sp.scale.set(c.width * .0045, c.height * .0045, 1);
    sp.position.set(x - CX, y, CD - d); sp.renderOrder = 9; NG[l].add(sp); nbrBubbles[l].push(sp); return sp;
  }
  const L1 = LV[1];
  // in bed: lying on their back with the head on the pillow (towards the headboard, d+), feet 1.72 m back, duvet up to the chest
  function bed(l, x, dHead, y, o, duvetCol, dLen) {
    const p = figure({ ...o, pose: "lie" }); place(p, l, x, dHead - 1.72, y + .28);
    cube(NG[l], .64, .16, dLen || 1.25, mk(duvetCol, 1), x - CX, y + .45, CD - (dHead - .5 - (dLen || 1.25) / 2));
  }

  /* ground floor: the row in the sitting room, the TV left on, a wagon down the stairs, the dog, the drummer, the kitchen */
  place(figure({ top: 0xc0392b, legs: 0x2c3e50, hair: 0x6b3e1f, armsUp: true }), 0, 4.75, 4.75, 0, 1, 0);
  place(figure({ top: 0x16a085, legs: 0x34495e, hair: 0x1b1b1b, armsUp: 1, skin: 0xb07a55 }), 0, 6.15, 4.75, 0, -1, 0);
  bubble(0, 4.6, 4.75, 2.25, "It was YOUR turn!"); bubble(0, 6.3, 4.75, 2.45, "#@%&!!", "#ffd0c8");
  cube(NG[0], 1.1, .62, .06, glowM(0x7fc8ff), 5.35 - CX, .85, CD - 5.47);                          // the telly, on, to nobody
  [[3.6, 3.0, 0xd35400], [7.4, 4.9, 0x8e44ad], [2.0, 1.7, 0x2980b9], [4.3, 2.6, 0x27ae60]].forEach(([x, d, c]) => {   // laundry, everywhere
    const m = ball(NG[0], .28, mk(c, 1), x - CX, .08, CD - d); m.scale.set(1.3, .35, 1); });
  { // a child riding a red wagon down the stairs (they rise from x 0.37 to 3.24, 41.5° pitch)
    const a = Math.atan(.1954 / .2208), x = 1.8, y = (x - .37) / .2208 * .1954 + .1, wg = new THREE.Group();
    const red = mk(0xc0392b, .5), blk = mk(0x15171a);
    cube(wg, .95, .22, .48, red, 0, .26, 0); cube(wg, .9, .05, .44, mk(0x7f1d1d), 0, .15, 0);
    [[-.32, .24], [-.32, -.24], [.32, .24], [.32, -.24]].forEach(([wx, wz]) => cyl(wg, .1, .1, .05, blk, wx, .1, wz, Math.PI / 2));
    cyl(wg, .015, .015, .8, blk, -.75, .32, 0, 0, Math.PI / 2.6);                                  // the handle, flying
    const kid = figure({ top: 0xf1c40f, legs: 0x2e86de, hair: 0xd4a017, armsUp: true, pose: "sit" }); kid.scale.setScalar(.6); kid.position.set(.05, .2, 0); kid.rotation.y = -Math.PI / 2; wg.add(kid);
    wg.rotation.z = a; place(wg, 0, x, .74, y); bubble(0, 1.6, .74, y + 1.25, "WHEEEE!", "#fff3b0");
    const dog = new THREE.Group(), fur = mk(0x8d6e63); cube(dog, .6, .28, .26, fur, 0, .38, 0); cube(dog, .24, .22, .2, fur, .38, .55, 0);
    [[-.22, .1], [-.22, -.1], [.22, .1], [.22, -.1]].forEach(([lx, lz]) => cyl(dog, .04, .04, .26, fur, lx, .13, lz)); cyl(dog, .025, .02, .3, fur, -.38, .5, 0, 0, -.8);
    place(dog, 0, 1.0, 1.75, 0); dog.rotation.y = Math.PI; bubble(0, 1.0, 1.75, 1.2, "WOOF!");
  }
  { // the drummer in the study, at 3 a.m.
    const d = figure({ top: 0x2c2c2c, legs: 0x1f3a5f, hair: 0x9b59b6, pose: "sit", armsForward: true }); place(d, 0, 1.6, 4.6, 0, 0, -1);
    cyl(NG[0], .28, .28, .25, mk(0xb03a2e, .4), 1.6 - CX, .3, CD - 3.95, Math.PI / 2);              // bass drum
    [[1.25, 4.1, .62], [1.95, 4.1, .62]].forEach(([x, dd, h]) => cyl(NG[0], .17, .17, .14, mk(0xdddddd, .4), x - CX, h, CD - dd));
    [[1.05, 4.0, 1.05], [2.2, 4.0, 1.1]].forEach(([x, dd, h]) => { cyl(NG[0], .2, .2, .01, mk(0xd4ac0d, .3), x - CX, h, CD - dd); cyl(NG[0], .01, .01, h, mk(0x888888), x - CX, h / 2, CD - dd); });
    bubble(0, 1.6, 4.4, 1.85, "BA-DUM-TSS");
  }
  { // the kitchen: something on the hob is very much on fire; the cat is unbothered
    cyl(NG[0], .16, .14, .08, mk(0x2b2b2b, .4), 7.5 - CX, .95, CD - .58);
    [[0, 0, .32], [.07, .04, .22], [-.06, -.03, .25]].forEach(([dx, dd, h]) => add(NG[0], new THREE.ConeGeometry(.07, h, 8), glowM(0xff7a1a), 7.5 + dx - CX, 1.0 + h / 2, CD - .58 - dd));
    [0, 1, 2].forEach((i) => { const m = ball(NG[0], .16 + i * .06, new THREE.MeshStandardMaterial({ color: 0x777777, transparent: true, opacity: .45 }), 7.45 + i * .1 - CX, 1.5 + i * .3, CD - .65); m.scale.y = .8; });
    const cat = new THREE.Group(), cf = mk(0x2b2b2b); cube(cat, .32, .16, .14, cf, 0, .12, 0); cube(cat, .13, .12, .12, cf, .2, .22, 0);
    cyl(cat, .015, .012, .3, cf, -.2, .25, 0, 0, .6); place(cat, 0, 6.2, .55, .9); bubble(0, 6.2, .55, 1.55, "not my fault");
  }

  /* first floor: on the loo, the bath overflowing, asleep (one snoring), someone bouncing on the guest bed, balloons */
  { const p = figure({ pose: "sit", top: 0x95a5a6, legs: 0xecf0f1, hair: 0x7f8c8d, armsForward: true }); place(p, 1, 7.2, .7, L1 + .03, 0, 1);
    cube(NG[1], .5, .36, .02, mk(0xf4f1e8, 1), 7.2 - CX, L1 + 1.0, CD - 1.02); bubble(1, 7.2, .8, L1 + 1.8, "Occupied!"); }
  { const water = new THREE.MeshStandardMaterial({ color: 0x5dade2, transparent: true, opacity: .6, roughness: .1 });
    cube(NG[1], .6, .04, 1.36, water, 7.98 - CX, L1 + .56, CD - 1.01);                                 // brim-full bath…
    [[5.91, 8.38, .26, 1.13], [6.46, 8.38, 1.13, 2.12], [4.6, 6.4, 1.3, 2.1]].forEach(([x0, x1, d0, d1]) =>  // …and the rest of it on the floor
      cube(NG[1], x1 - x0, .012, d1 - d0, water, (x0 + x1) / 2 - CX, L1 + .012, CD - (d0 + d1) / 2));
    const duck = new THREE.Group(), yel = mk(0xf7dc6f, .4); ball(duck, .07, yel, 0, .06, 0); ball(duck, .045, yel, .05, .13, 0); place(duck, 1, 6.9, 1.6, L1 + .02);
    // …because someone's in it: sat back against the far end in a shower cap, a duck on their head, singing
    const bather = figure({ pose: "sit", skin: 0xf0c8a8, top: 0xf0c8a8, hair: 0x5d4037, armsUp: -1 }); place(bather, 1, 7.98, 1.45, L1 - .25, 0, -1);
    const capY = L1 - .25 + .45 + .86; ball(NG[1], .15, mk(0xf8a5c2, .6), 7.98 - CX, capY, CD - 1.47).scale.set(1, .7, 1);
    const hat = new THREE.Group(); ball(hat, .06, yel, 0, .05, 0); ball(hat, .04, yel, .04, .11, 0); place(hat, 1, 7.98, 1.47, capY + .08);
    [[7.78, .62], [8.15, .78], [7.85, 1.05], [8.12, 1.25], [7.75, 1.3], [8.18, .45]].forEach(([x, d], i) =>
      ball(NG[1], .07 + (i % 3) * .025, mk(0xffffff, .3), x - CX, L1 + .58, CD - d));          // foam
    bubble(1, 7.98, 1.3, L1 + 1.95, "♪ La la laaaa ♪", "#e8f6ff"); }
  bed(1, 6.55, 5.35, L1 + .3, { top: 0xf5b7b1, hair: 0x8e5a2b }, 0x5dade2, 1.3); bed(1, 7.25, 5.35, L1 + .3, { top: 0xaed6f1, hair: 0x2c2c2c }, 0x5dade2, 1.3);
  bubble(1, 6.55, 5.1, L1 + 1.0, "zzz"); bubble(1, 7.3, 5.0, L1 + 1.25, "SNNNOOORRRE", "#e8e0ff");
  bed(1, 4.0, 5.35, L1 + .3, { top: 0xa9dfbf, hair: 0xd4a017 }, 0xf1948a, 1.3); bubble(1, 4.0, 5.1, L1 + 1.0, "zzz…");
  place(figure({ top: 0xe67e22, legs: 0x1abc9c, hair: 0xf1c40f, armsUp: true }), 1, 1.4, 3.6, L1 + .62, 1, 0); bubble(1, 1.4, 3.6, L1 + 2.75, "BOING!");
  [[4.0, 1.6, 0xe74c3c], [4.3, 1.75, 0xf1c40f], [4.55, 1.55, 0x3498db], [4.2, 1.45, 0x2ecc71], [4.45, 1.85, 0x9b59b6]].forEach(([x, d, c], i) => {
    const y = L1 + 1.65 + (i % 3) * .14; ball(NG[1], .14, mk(c, .3), x - CX, y, CD - d).scale.y = 1.2; cyl(NG[1], .004, .004, y - L1 - .9, mk(0xffffff), x - CX, (y + L1 + .9) / 2, CD - d); });

  /* the loft: just a loft (boarded in the middle), boxes, a Christmas tree, an old bike, a trunk, and some skeletons */
  const LF = 4.82, boards = mk(0xb38b59, 1), card = mk(0xb5895a, 1);
  cube(NG[2], 8.05, .05, 5.2, mk(0xe9d27a, 1), 4.33 - CX, LF - .06, CD - 2.9);   // loft insulation over the whole ceiling…
  cube(NG[2], 7.4, .04, 3.3, boards, 4.35 - CX, LF - .02, CD - 2.9);             // …boarded down the middle
  [[1.2, 1.7, .5, .45, .4], [1.25, 1.7, .5, .35, .85], [1.8, 1.55, .6, .5, .5], [6.9, 3.8, .5, .45, .45], [6.4, 4.1, .55, .4, .4],
   [5.9, 1.6, .45, .45, .4], [3.1, 1.5, .6, .45, .45], [7.3, 2.6, .45, .5, .5]].forEach(([x, d, w, h, y0]) => cube(NG[2], w, h, w * .9, card, x - CX, LF + y0 - h / 2 + .02, CD - d, x * 1.7));
  add(NG[2], new THREE.ConeGeometry(.42, 1.4, 9), mk(0x1e5631, 1), 6.7 - CX, LF + .78, CD - 2.4); ball(NG[2], .07, glowM(0xffd54a), 6.7 - CX, LF + 1.52, CD - 2.4);
  { const bk = new THREE.Group(), steel = mk(0x7f8c8d, .4); [-.5, .5].forEach((x) => add(bk, new THREE.TorusGeometry(.32, .025, 6, 18), mk(0x1b1b1b), x, .34, 0));
    cyl(bk, .02, .02, 1.0, steel, 0, .55, 0, 0, Math.PI / 2); cyl(bk, .02, .02, .5, steel, -.2, .5, 0, 0, .7); place(bk, 2, 1.8, 2.8, LF, 1, 0); }
  cube(NG[2], .8, .45, .5, mk(0x6e2c00, .8), 3.0 - CX, LF + .225, CD - 3.9);                      // the trunk
  place(figure({ skeleton: true, pose: "sit" }), 2, 3.0, 3.75, LF, 0, -1);                          // …with a skeleton sitting on it
  { const s = figure({ skeleton: true, pose: "lie" }); place(s, 2, 6.0, 3.6, LF + .5); s.rotation.y = Math.PI / 2; }   // one having a lie-down along the boxes
  cube(NG[2], 1.6, .45, .6, card, 5.2 - CX, LF + .22, CD - 3.6);
  place(figure({ skeleton: true, armsUp: 1 }), 2, 4.1, 2.9, LF, 1, .3); bubble(2, 4.1, 2.9, LF + 2.1, "Are they gone?");
}

/* Solar panels (Infinity Energy quote, 28 Oct): 8 × 490 W in landscape on the front (east) roof, 2 high by 4
   wide, set well below the rooflights with a band of tiles between, and 3 on the dormer, tilted 10° to face
   west. 5.39 kWp. Drawn 1760 × 1050 mm. They glow with what the system is generating. */
const PV = { w: 1.76, h: 1.05, kwp: 5.39, below: .4 };   // below: tiles between the rooflights and the top row, along the slope
const pvT = tex(392, 227, (x, w, h) => { x.fillStyle = "#c9ccd0"; x.fillRect(0, 0, w, h); x.fillStyle = "#16233b"; x.fillRect(4, 4, w - 8, h - 8);
  x.strokeStyle = "#4b5d7d"; x.lineWidth = 1.2; for (let i = 1; i < 12; i++) { x.beginPath(); x.moveTo(4 + i * (w - 8) / 12, 4); x.lineTo(4 + i * (w - 8) / 12, h - 4); x.stroke(); }
  for (let j = 1; j < 6; j++) { x.beginPath(); x.moveTo(4, 4 + j * (h - 8) / 6); x.lineTo(w - 4, 4 + j * (h - 8) / 6); x.stroke(); } }, 1 / PV.w, 1 / PV.h);
const pvGlowT = tex(392, 227, (x, w, h) => { x.fillStyle = "#000"; x.fillRect(0, 0, w, h); for (let i = 0; i < 12; i++) for (let j = 0; j < 6; j++) {
  x.fillStyle = "#fff"; x.fillRect(6 + i * (w - 8) / 12, 6 + j * (h - 8) / 6, (w - 8) / 12 - 4, (h - 8) / 6 - 4); } }, 1 / PV.w, 1 / PV.h);
const pvMat = S({ map: pvT, roughness: .3, metalness: .4, emissive: 0xffc94a, emissiveMap: pvGlowT, emissiveIntensity: 0 });
{ const gap = .02, x0 = (8.9 - (4 * PV.w + 3 * gap)) / 2, dh = PV.h / Math.hypot(1, 1.04);  // a panel's height in plan (45° roof)
  for (let row = 0; row < 2; row++) for (let i = 0; i < 4; i++) {
    const top = 1.77 - PV.below / Math.hypot(1, 1.04) - row * (dh + gap / 1.44), xa = x0 + i * (PV.w + gap);  // rooflights start at d 1.77
    slope(G[3], xa, xa + PV.w, top, top - dh, pvMat, .04, .16);
  }
  const tilt = 10 * Math.PI / 180, dLow = 5.02, dHigh = dLow - PV.h * Math.cos(tilt), base = (d) => dorBot(d) + .22;
  const yfn = (d) => base(dLow) + .1 + (dLow - d) * Math.tan(tilt);
  for (let i = 0; i < 3; i++) { const xa = 1.1 + i * (PV.w + gap);
    slope(G[3], xa, xa + PV.w, dHigh, dLow, pvMat, .04, 0, yfn);
    [[xa + .1, dHigh + .08], [xa + PV.w - .14, dHigh + .08], [xa + .1, dLow - .12], [xa + PV.w - .14, dLow - .12]].forEach(([x, d]) => box(G[3], x, x + .04, base(d), yfn(d), d - .02, d + .02, M.steel)); }
}
/* Roof plan: a card over each rooflight, and one for the dormer window, to work its solar blind */
const roofCards = {};
[["blind-stairs-roof", "Stairwell", .725, 2.14, 1.5], ["blind-roof-l", "Master left", 2.35, 2.14, 1.5],
 ["blind-roof-r", "Master right", 5.525, 2.14, 1.5], ["blind-ensuite-roof", "Ensuite", 7.39, 2.14, 1.5],
 ["blind-dormer", "Dormer window", 4.1, 5.38, 2.6]].forEach(([id, label, x, d, w]) => {
  const h = id === "blind-dormer" ? 1.1 : 1.3, c = document.createElement("canvas"); c.width = Math.round(w * CARD_PX * 1.5); c.height = Math.round(h * CARD_PX * 1.5);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = aniso;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(x - CX, 8.3, CD - d); m.renderOrder = 6; m.visible = false; m.userData.roofCard = id; G[3].add(m);
  roofCards[id] = { mesh: m, canvas: c, tex: t, label, hits: [], pos: null };
});
function drawRoofCard(rc, pos) {   // name; how far it's closed; a bar to tap along; Open and Close
  const c = rc.canvas, x = c.getContext("2d"), W = c.width, H = c.height, hits = rc.hits = [], fs = Math.min(H * .15, W * .105), pad = fs * .55;
  const rr = (x0, y0, w, h, r) => { x.beginPath(); if (x.roundRect) x.roundRect(x0, y0, w, h, r); else x.rect(x0, y0, w, h); };
  x.clearRect(0, 0, W, H);
  x.fillStyle = "rgba(11,14,18,.86)"; x.strokeStyle = pos > 0 ? "rgba(76,201,240,.75)" : "rgba(255,255,255,.22)"; x.lineWidth = Math.max(2, fs * .08);
  rr(2, 2, W - 4, H - 4, fs * .6); x.fill(); x.stroke();
  x.textBaseline = "middle"; x.textAlign = "left";
  x.font = `600 ${fs}px Inter, system-ui, sans-serif`; x.fillStyle = "#eef1f5"; x.fillText(rc.label, pad, H * .15);
  x.font = `500 ${fs * .78}px Inter, system-ui, sans-serif`; x.fillStyle = pos > 0 ? "#7fd8f5" : "#a8b1bd";
  x.fillText(pos == null ? "–" : pos === 0 ? "Open" : pos >= 100 ? "Closed" : `${pos}% closed`, pad, H * .33);
  const bx0 = pad, bx1 = W - pad, by = H * .5, bh = fs * .5;   // tap along the bar to set how far it's closed
  x.fillStyle = "rgba(255,255,255,.1)"; rr(bx0, by - bh / 2, bx1 - bx0, bh, bh / 2); x.fill();
  if (pos > 0) { x.fillStyle = "#4cc9f0"; rr(bx0, by - bh / 2, Math.max(bh, (bx1 - bx0) * pos / 100), bh, bh / 2); x.fill(); }
  hits.push({ kind: "bar", x0: bx0, x1: bx1, y0: by - bh * 1.3, y1: by + bh * 1.3 });
  [["Open", 0, 0], ["Close", 100, 1]].forEach(([t, to, k]) => {
    const w = (W - pad * 3) / 2, x0 = pad + k * (w + pad), y0 = H * .64, y1 = H - pad;
    x.fillStyle = (to === 0 ? pos === 0 : pos >= 100) ? "rgba(76,201,240,.38)" : "rgba(255,255,255,.13)"; rr(x0, y0, w, y1 - y0, fs * .45); x.fill();
    x.textAlign = "center"; x.font = `600 ${fs * .85}px Inter, system-ui, sans-serif`; x.fillStyle = "#eef1f5"; x.fillText(t, x0 + w / 2, (y0 + y1) / 2);
    hits.push({ kind: "btn", to, x0, x1: x0 + w, y0, y1 }); });
  rc.tex.needsUpdate = true;
}

const solarEl = document.createElement("div"); solarEl.className = "h3l solar"; solarEl.innerHTML = "<span><i></i><b></b><small></small></span>";
const solarLbl = new THREE.CSS2DObject(solarEl); solarLbl.position.set(4.45 - CX, 8.6, CD - 1.0); G[3].add(solarLbl);

/* The Tesla, parked on the left as you look from the road (by the timber fence), backed in with its nose to the
   road. Its charge port (rear left) is then at the house end, beside the wall charger, which is on the front wall
   on that side of the door. Cable when plugged in; port light blue when ready, green when charging. */
const car = new THREE.Group(); car.position.set(1.55 - CX, -.16, CD + 3.11); car.rotation.y = -Math.PI / 2; yard.add(car);
// unplugged: no car; plugged in: the car; charging: an eerie green light inside (more X-Files than lamp), pouring out of
// the windows in shafts down to the ground, pulsing and now and then flickering
const carPaint = S({ color: new THREE.Color(0x1d3159).convertSRGBToLinear(), roughness: .3, metalness: .65 });
// clear, darkly tinted glass you can see the cabin through; the light comes from inside, not from the glass
const carGlass = new THREE.MeshStandardMaterial({ color: 0x0f1d17, roughness: .05, metalness: .4, transparent: true, opacity: .42, depthWrite: false });
const carTrim = S({ color: 0x2a2c30, roughness: .75, emissive: 0x2bff7a, emissiveIntensity: 0 });   // dark charcoal interior
const carDash = S({ color: 0x1c1e21, roughness: .6, emissive: 0x2bff7a, emissiveIntensity: 0 });

const alien = new THREE.Group(); alien.visible = false; car.add(alien);   // the light shafts and the pools they make
{
  const shaftT = (() => { const W = 64, H = 128, c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d"), d = x.createImageData(W, H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const v = j / (H - 1), u = i / (W - 1);
      const a = Math.pow(1 - v, 1.6) * Math.pow(Math.sin(Math.PI * u), .9); const k = (j * W + i) * 4; d.data[k] = d.data[k + 1] = d.data[k + 2] = 255; d.data[k + 3] = 255 * a; }
    x.putImageData(d, 0, 0); return new THREE.CanvasTexture(c); })();
  const shaftMat = new THREE.MeshBasicMaterial({ map: shaftT, color: 0x5dff96, transparent: true, opacity: .38, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const poolMat = new THREE.MeshBasicMaterial({ map: glowT, color: 0x3dff7a, transparent: true, opacity: .45, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  // a quad from the window (top two corners, v=0) out to the ground (bottom two, v=1)
  const quad = (a, b, c, d) => { const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b, ...c, ...d], 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]); const m = new THREE.Mesh(g, shaftMat); m.renderOrder = 7; alien.add(m); return m; };
  [1, -1].forEach((sd) => {        // both sides: two shafts each, through the front and rear side windows
    [[-1.25, -.15], [.05, 1.1]].forEach(([x0, x1]) => {
      quad([x0, 1.32, sd * .9], [x1, 1.32, sd * .9], [x1 + .5, .09, sd * 2.7], [x0 - .5, .09, sd * 2.7]);
      quad([x0, 1.02, sd * .9], [x1, 1.02, sd * .9], [x1 + .35, .09, sd * 1.9], [x0 - .35, .09, sd * 1.9]);
    });
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.2), poolMat); pool.rotation.x = -Math.PI / 2; pool.position.set(-.05, .08, sd * 2.1); pool.renderOrder = 6; alien.add(pool);
  });
  quad([1.25, 1.0, -.7], [1.25, 1.0, .7], [3.6, .09, 1.3], [3.6, .09, -1.3]);        // out of the windscreen
  quad([-1.4, 1.0, -.7], [-1.4, 1.0, .7], [-3.3, .09, 1.2], [-3.3, .09, -1.2]);     // and the rear window
  alien.userData.mats = [shaftMat, poolMat];
}
let alienTimer = 0;
let alienDip = 1, alienDipGoal = 1;
function alienPulse() {   // a slow throb, and now and then a smooth dip
  if (alienDipGoal < 1 ? Math.random() < .25 : Math.random() < .015) alienDipGoal = alienDipGoal < 1 ? 1 : .5;
  alienDip += (alienDipGoal - alienDip) * .3;
  const t = performance.now() / 1000, k = (.74 + .26 * Math.sin(t * 2.3) * Math.sin(t * .7 + 1)) * alienDip;
  carTrim.emissiveIntensity = .55 * k; carDash.emissiveIntensity = .4 * k;
  const [sm, pm] = alien.userData.mats; sm.opacity = .38 * k; pm.opacity = .45 * k; kick();
}
const carParts = [];
const portMat = new THREE.MeshBasicMaterial({ color: 0x223040 });
const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[2.43, 1.0, -.12], [2.45, .34, -.42], [2.48, .26, -.78], [2.5, .84, -1.06]]
  .map(([x, y, d]) => new THREE.Vector3(x - CX, y - .16, CD - d))), 24, .016, 6), S({ color: 0x15171a, roughness: .5 }));
{
  const L = 4.72, Wd = 1.85, lin = (h) => new THREE.Color(h).convertSRGBToLinear();
  const paint = carPaint, glass = carGlass,
    tyre = S({ color: 0x141518, roughness: .9 }), rim = S({ color: 0x8a9096, roughness: .35, metalness: .7 });
  const ext = (pts, depth, mat, z0, bevel) => { const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b))),
    { depth, bevelEnabled: !!bevel, bevelThickness: bevel || 0, bevelSize: bevel || 0, bevelSegments: 3, curveSegments: 6 });
    const m = new THREE.Mesh(g, mat); m.position.set(-L / 2, 0, z0); car.add(m); carParts.push(m); return m; };
  ext([[.05, .34], [0, .7], [.22, .94], [1.0, 1.0], [3.55, 1.02], [4.52, .86], [4.72, .62], [4.68, .34]], Wd - .12, paint, -(Wd - .12) / 2, .06);
  ext([[.98, .98], [1.72, 1.4], [2.92, 1.42], [3.56, 1.0]], Wd - .2, glass, -(Wd - .2) / 2, .05);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.4, .09, Wd - .02), paint); roof.position.set(2.32 - L / 2, 1.465, 0); car.add(roof); carParts.push(roof);
  { const cb = (w, h, dd, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), mat); m.position.set(x, y, z); car.add(m); return m; };
    [.38, -.38].forEach((z) => { cb(.13, .44, .5, carTrim, .05, 1.1, z); cb(.1, .1, .28, carTrim, .05, 1.36, z); });          // front seats and headrests
    cb(.14, .38, 1.36, carTrim, -.98, 1.08, 0); [.42, -.42, 0].forEach((z) => cb(.1, .08, .26, carTrim, -.98, 1.31, z));   // rear bench
    cb(.42, .12, 1.6, carDash, .95, 1.06, 0);                                                                                 // dashboard
    const sw = new THREE.Mesh(new THREE.TorusGeometry(.17, .025, 8, 20), carDash); sw.position.set(.62, 1.16, .38); sw.rotation.set(0, Math.PI / 2, -.35); car.add(sw);
    const scr = cb(.02, .2, .34, new THREE.MeshBasicMaterial({ color: 0x0c1218 }), .74, 1.22, 0); scr.rotation.z = -.25;   // the big centre screen
  }
  [1, -1].forEach((sd) => { const b = new THREE.Mesh(new THREE.BoxGeometry(.1, .46, .05), paint); b.position.set(2.33 - L / 2, 1.2, sd * (Wd / 2 - .04)); car.add(b); carParts.push(b);
    const z = sd * (Wd / 2 - .06);
    [[[3.56, 1.0], [2.9, 1.43]], [[.98, .98], [1.74, 1.41]]].forEach(([[x0, y0], [x1, y1]]) => {   // A and C pillars
      const a = new THREE.Vector3(x0 - L / 2, y0, z), c = new THREE.Vector3(x1 - L / 2, y1, z);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, a.distanceTo(c), 8), paint);
      m.position.copy(a).add(c).multiplyScalar(.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize()); car.add(m); carParts.push(m); });
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.2, .05, .05), paint); rail.position.set(2.32 - L / 2, 1.41, z); car.add(rail); carParts.push(rail); });
  [[.86, 1], [.86, -1], [3.76, 1], [3.76, -1]].forEach(([x, s]) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, .24, 22), tyre); w.rotation.x = Math.PI / 2; w.position.set(x - L / 2, .34, s * (Wd / 2 - .08)); car.add(w); carParts.push(w);
    const h = new THREE.Mesh(new THREE.CylinderGeometry(.22, .22, .25, 18), rim); h.rotation.x = Math.PI / 2; h.position.copy(w.position); car.add(h); carParts.push(h); });
  const lamp = (x, y, z, w, col) => { const m = new THREE.Mesh(new THREE.BoxGeometry(.04, .05, w), new THREE.MeshBasicMaterial({ color: col })); m.position.set(x - L / 2, y, z); car.add(m); };
  lamp(4.7, .66, .55, .32, 0xdfe8f5); lamp(4.7, .66, -.55, .32, 0xdfe8f5); lamp(.02, .74, .6, .36, 0x9a1620); lamp(.02, .74, -.6, .36, 0x9a1620);
  const port = new THREE.Mesh(new THREE.BoxGeometry(.12, .07, .02), portMat); port.position.set(.32 - L / 2, .86, -Wd / 2 - .02); car.add(port);
  carParts.forEach((m) => { m.castShadow = m.receiveShadow = m.material !== carGlass; m.userData.car = 1; });   // light gets in through the glass
  // wall charger on the front wall, the far side of the door from the kitchen (between the hall window and the porch)
  const wc = box(yard, 2.3, 2.56, .78, 1.22, -.13, -.01, S({ color: 0x2a2d31, roughness: .4 })); wc.castShadow = true;
  box(yard, 2.38, 2.48, 1.1, 1.12, -.14, -.13, portMat);
  cable.castShadow = true; yard.add(cable);
}
const carEl = document.createElement("div"); carEl.className = "h3l car"; carEl.innerHTML = "<span><i></i><b></b><small></small></span>";
carEl.addEventListener("click", (e) => { e.stopPropagation(); opts.onCar && opts.onCar(); });
const carLbl = new THREE.CSS2DObject(carEl); carLbl.position.set(0, 2.0, 0); car.add(carLbl);

house.traverse((o) => { if (o.isMesh) { const glass = o.material.transparent; o.castShadow = !glass; o.receiveShadow = !glass; } });
const pickables = []; house.traverse((o) => { if (o.isMesh) pickables.push(o); }); pickables.push(...carParts);
NG.forEach((g) => g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; }));

/* ---------- views, and the animation between them ----------
   "house": the whole house from outside. A floor ("ground", "first", "loft"): the floors above lift away, and on
   that floor every wall that stands between you and a room drops to about a foot, while outside walls on the
   far side stay up, windows and all, like a doll's house. They swap over as you turn it. Mode "plan": the same
   floor from straight above (back of the house at the top, north to the right) with every wall down.
   Camera, zoom, floors and walls all ease to their new places in about a quarter of a second. */
let view = null, mode = "3d", selected = null, goal = null, goalCam = null, cutAt = null, fovGoal = 38, planLock = true, camLock = false;
const TOP = { house: -1, roof: 3, loft: 2, first: 1, ground: 0 };
const CUT = .3;     // metres of wall left standing when it's in the way
const EASE = .16;   // share of the remaining distance covered each frame
const LIFT = 4.5;   // how far a floor rises as it goes
const shown = (o) => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };

// every wall-like piece on the three floors, measured once at rest
const walls = [[], [], []], cutInfo = new Map(), wb = new THREE.Box3();
function measureWall(o, l) {
  o.updateMatrixWorld(true); o.geometry.computeBoundingBox(); const g = o.geometry.boundingBox, q = o.quaternion;
  const sloped = Math.abs(q.x) > 1e-3 || Math.abs(q.z) > 1e-3; wb.setFromObject(o);
  const lift = o.parent ? o.parent.position.y : 0;  // measure as if the floor were in place
  let a = o.position.y + g.min.y, b = o.position.y + g.max.y;
  if (sloped) { a = wb.min.y - lift; b = wb.max.y - lift; }
  const i = { py: o.position.y, sy: o.scale.y, vis: o.visible, a, b, ga: g.min.y, sloped, lvl: l,
    cx: (wb.min.x + wb.max.x) / 2, cz: (wb.min.z + wb.max.z) / 2, sx: wb.max.x - wb.min.x, sz: wb.max.z - wb.min.z,
    n: o.userData.n, probe: o.userData.probe || .55, nbr: !!o.userData.nbr, stair: !!o.userData.rm, hk: 1, tk: 1 };
  cutInfo.set(o, i); walls[l].push(o);
  if (cutAt === l) { i.tk = i.hk = target(i); setHeight(o, i); }
  return i;
}
function forgetWall(o) { const i = cutInfo.get(o); if (!i) return; cutInfo.delete(o); const w = walls[i.lvl], k = w.indexOf(o); if (k >= 0) w.splice(k, 1); }
function setHeight(o, i) {  // i.hk: 1 = full height, 0 = cut down to a foot
  const h = LV[i.lvl] + CUT + (i.b - LV[i.lvl] - CUT) * i.hk;
  if (i.hk >= .999 || i.b <= h + 1e-3) { o.visible = i.vis; o.scale.y = i.sy; o.position.y = i.py; return; }
  if (i.a >= h - 1e-3 || i.sloped) { o.visible = false; return; }
  const k = (h - i.a) / (i.b - i.a); o.visible = i.vis; o.scale.y = i.sy * k; o.position.y = i.py + i.ga * (1 - k);
}
// Is this piece in the way? Look just past it, on the far side from the camera: if that's inside a room, yes.
const NBR = [.14, MX - .26, .26, MW - .26];
// "inside" is the floor's whole outline, not just its rooms: stairwells and landings count, so a window over the
// stairs drops with the wall around it
const OUTLINE = [
  [[.14, 8.39, .26, 5.58], [8.39, 11.04, .77, 5.58], [7.61, 11.04, 5.84, 9.78]],   // ground: main house, side extension, conservatory
  [[.13, 8.38, .26, 5.58]],                                                        // first
  [[.29, 8.33, .39, 5.52]],                                                        // loft
];
const inRoom = (l, x, d) => OUTLINE[l].some((q) => x > q[0] && x < q[1] && d > q[2] && d < q[3]);
function inTheWay(i) {
  if (i.stair) return true;
  const c = camera.position, axes = i.n ? [i.n] : i.sx < i.sz * .5 ? ["x"] : i.sz < i.sx * .5 ? ["z"] : ["x", "z"];
  for (const ax of axes) {
    const sgn = ax === "x" ? Math.sign(c.x - i.cx) || 1 : Math.sign(c.z - i.cz) || 1;
    const X = ax === "x" ? i.cx - sgn * i.probe : i.cx, d = CD - (ax === "z" ? i.cz - sgn * i.probe : i.cz);
    if (i.nbr) { const x = -(X + CX); if (x > NBR[0] && x < NBR[1] && d > NBR[2] && d < NBR[3]) return true; }
    if (inRoom(i.lvl, X + CX, d)) return true;  // the neighbour's walls give way for our rooms too
  }
  return false;
}
const target = (i) => i.lvl !== cutAt ? 1 : mode === "plan" || inTheWay(i) ? 0 : 1;
function stepWalls(k) {
  let moving = false;
  for (const w of walls) for (const o of w) {
    const i = cutInfo.get(o); i.tk = target(i);
    if (i.hk === i.tk) continue;
    i.hk += (i.tk - i.hk) * k; if (Math.abs(i.tk - i.hk) < .01) i.hk = i.tk;
    setHeight(o, i); moving = true;
  }
  return moving;
}
// floors (and the single-storey roofs) rise away as they're hidden and settle back as they return
// Floors (and the single-storey roofs, and the neighbour's roof) slide down into place as they arrive, and fade
// out, drifting up a little, as they leave. While fading they wear see-through copies of their materials.
const lift = { cur: [0, 0, 0, 0, 0, 0, 0], goal: [0, 0, 0, 0, 0, 0, 0], op: [1, 1, 1, 1, 1, 1, 1] };   // ground, first, loft, main roof, single-storey roofs, their loft, their roof
const liftGroups = (j) => j < 2 ? [G[j], NG[j]] : j < 4 ? [G[j]] : j === 4 ? [g0r] : j === 5 ? [NG[2]] : [NG[3]];
const DRIFT = .8, fadeCopies = [0, 1, 2, 3, 4, 5, 6].map(() => new Map());
function fadeMaterials(j, on) {
  liftGroups(j).forEach((g) => g.traverse((o) => {
    if (!o.isMesh) return;
    if (on && !o.userData.mat0) {
      const m = o.material, cache = fadeCopies[j];
      if (!cache.has(m)) { const f = m.clone(); f.transparent = true; cache.set(m, f); }
      o.userData.mat0 = m; o.material = cache.get(m);
    } else if (!on && o.userData.mat0) { o.material = o.userData.mat0; delete o.userData.mat0; }
  }));
}
function stepLevels(k) {
  let moving = false;
  for (let j = 0; j < 7; j++) {
    const groups = liftGroups(j), showing = lift.goal[j] === 0, hidden = !groups[0].visible;
    let c = lift.cur[j], op = lift.op[j];
    if (showing) {
      if (hidden) { c = LIFT; op = 1; fadeMaterials(j, false); groups.forEach((g) => { g.visible = true; }); }
      else if (c === 0 && op === 1) continue;
      if (op < 1) { op += (1 - op) * k * 1.5; if (op > .985) { op = 1; fadeMaterials(j, false); } }   // a fade cut short: bring it back
      c += -c * k; if (Math.abs(c) < .02) c = 0;
    } else {
      if (hidden) continue;
      if (op === 1 && !groups[0].children.some((o) => o.userData.mat0)) fadeMaterials(j, true);
      op += -op * k * 1.3; c += (DRIFT - c) * k;
      if (op < .03) { op = 1; c = LIFT; fadeMaterials(j, false); groups.forEach((g) => { g.visible = false; }); }
    }
    lift.cur[j] = c; lift.op[j] = op; moving = true;
    groups.forEach((g) => { g.position.y = c; });
    fadeCopies[j].forEach((f, m) => { f.opacity = (m.opacity ?? 1) * op; });
  }
  return moving;
}
/* What each view frames, in (x, d): the ground floor takes in the side extension and conservatory; the first
   floor and loft are just the main house, so they come in closer. [centre x, centre d, half-width, half-depth] */
const FRAME = { roof: [4.4, 3.1, 4.9, 3.7], ground: [5.6, 4.2, 6.4, 6.2], first: [4.32, 2.9, 4.7, 3.6], loft: [4.32, 2.95, 4.7, 3.5] };
function planGoal(t) {
  const [cx, cd, hw, hh] = FRAME[view], tgt = new THREE.Vector3(cx - CX, view === "roof" ? 7.6 : LV[t], CD - cd), tan = Math.tan(30 * Math.PI / 360);
  const a = container.clientWidth / Math.max(1, container.clientHeight), h = Math.max(hh / tan, hw / (tan * a)) * 1.04;
  return { tgt, pos: new THREE.Vector3(tgt.x, tgt.y + h, tgt.z + .001) };
}
const freeControls = () => { controls.minPolarAngle = 0; controls.maxPolarAngle = Math.PI * .495; controls.minAzimuthAngle = -Infinity; controls.maxAzimuthAngle = Infinity; };
function setView(v, m) {
  m = m === "plan" ? "plan" : "3d";
  if (m === "plan" && (TOP[v] === undefined || v === "house")) v = "ground";
  if (m === "3d" && v === "roof") v = "house";   // the roof is a plan; in 3D the whole house shows it
  const was = mode; view = TOP[v] === undefined ? "house" : v; mode = m;
  // ground, single-storey roofs, first, loft, main roof
  const vis = { house: [1, 1, 1, 1, 1], roof: [1, 1, 1, 1, 1], loft: [1, 0, 1, 1, 0], first: [1, 0, 1, 0, 0], ground: [1, 0, 0, 0, 0] }[view];
  lift.goal = [vis[0], vis[2], vis[3], vis[4], vis[1], view === "house" || view === "roof" || view === "loft", view === "house" || view === "roof"].map((x) => x ? 0 : LIFT);
  const t = TOP[view];
  cutAt = t >= 0 && t < 3 ? t : null;
  Object.values(roofCards).forEach((rc) => { rc.mesh.visible = view === "roof"; });
  ROOMS.forEach((r) => { if (r.card) r.card.mesh.visible = t >= 0 && r.lvl === t; });
  if (nbrProxy) nbrProxy.visible = view === "house" || view === "roof";
  nbrBubbles.forEach((list, l) => list.forEach((sp) => { sp.visible = l === t; }));  // their full-height shadow, only while they're full height
  solarLbl.visible = view === "house" || view === "roof"; carLabel();
  freeControls();
  if (mode === "plan") {
    controls.enableRotate = false; planLock = false; fovGoal = 30;
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN; controls.touches.ONE = THREE.TOUCH.PAN;      // in a plan, a drag moves it about
    const p = planGoal(t); goal = p.tgt; goalCam = p.pos;
  } else {
    controls.enableRotate = true; planLock = true; fovGoal = 38;
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; controls.touches.ONE = THREE.TOUCH.ROTATE;
    // keep looking from the same direction (from the plan: the usual corner), centred on this floor, near enough to fit it
    const f = FRAME[view], tgt = f ? new THREE.Vector3(f[0] - CX, LV[t] + .6, CD - f[1]) : HOME.tgt.clone();
    const dist = homePos().distanceTo(HOME.tgt) * (view === "house" ? 1 : view === "ground" ? .8 : .62);
    const dir = was === "plan" ? HOME.pos.clone().sub(HOME.tgt).normalize() : camera.position.clone().sub(controls.target).normalize();
    goal = tgt; goalCam = tgt.clone().add(dir.multiplyScalar(dist));
  }
  if (camLock) goal = goalCam = null;
  hint.textContent = view === "roof" ? "Tap Open or Close, or along a bar, to set a blind" :
    mode === "plan" ? "Tap a light or − / + on a card · scroll or pinch to zoom · drag to move" : "Drag to turn · scroll or pinch to zoom · tap a card's lights or − / +";
  kick();
}
function carLabel() { carLbl.visible = car.visible && mode === "3d" && (view === "house" || view === "ground"); }
function focus(rid) {
  if (mode === "plan") return;  // the plan already shows every room on the floor
  const r = byRid[rid]; if (!r) return;
  goal = new THREE.Vector3(r.c[0] - CX, LV[r.lvl] + .6, CD - r.c[1]); goalCam = null; kick();
}

/* picking */
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
  const rc = renderer.domElement.getBoundingClientRect();
  ptr.set((e.clientX - rc.left) / rc.width * 2 - 1, -(e.clientY - rc.top) / rc.height * 2 + 1); ray.setFromCamera(ptr, camera);
  const all = ray.intersectObjects(pickables, false).filter((h) => !h.object.userData.noPick && shown(h.object));
  const ch = all.find((h) => h.object.userData.card || h.object.userData.roofCard);  // cards draw on top, so they win
  if (ch && cardTap(ch)) return;
  const hit = all[0];
  if (hit && hit.object.userData.car) return opts.onCar && opts.onCar();
  const r = hit && hit.object.userData.room;
  if (r && r.rid && opts.onRoom) opts.onRoom(r.rid);
});

function cardTap(h) {
  const o = h.object, c = o.material.map.image, px = h.uv.x * c.width, py = (1 - h.uv.y) * c.height;
  const list = o.userData.roofCard ? roofCards[o.userData.roofCard].hits : o.userData.room.card.hits;
  const q = list.find((q) => q.r ? (px - q.x) ** 2 + (py - q.y) ** 2 <= q.r ** 2 : px >= q.x0 && px <= q.x1 && py >= q.y0 && py <= q.y1);
  if (o.userData.roofCard) {
    if (!q) return true;
    const pos = q.kind === "bar" ? Math.round(Math.max(0, Math.min(1, (px - q.x0) / (q.x1 - q.x0))) * 10) * 10 : q.to;
    opts.onBlind && opts.onBlind(o.userData.roofCard, pos); return true;
  }
  const r = o.userData.room;
  if (q && q.kind === "light") { opts.onLight && opts.onLight(q.id, !q.on); return true; }
  if (q && q.kind === "sp") { opts.onSetpoint && opts.onSetpoint(r.rid, q.to); return true; }
  if (r && r.rid && opts.onRoom) opts.onRoom(r.rid);
  return true;
}

/* ---------- daylight from the real sun position ---------- */
const C3 = (h) => new THREE.Color(h);
const C3L = (h) => new THREE.Color(h).convertSRGBToLinear();  // so the ground really is as dark as its hex
const DAY = { hemi: C3(0xf2f5f7), hemiG: C3(0x5c6650), sun: C3(0xfff1de), low: C3(0xffb27a), grass: C3L(0x3f5236) };
const NIGHT = { hemi: C3(0x5d6f96), hemiG: C3(0x1d2228), sun: C3(0x9fb4ff), grass: C3L(0x1f2a22) };
let sunAt = 0;
const sunHour = parseFloat(new URLSearchParams(location.search).get("sun"));  // ?sun=13 previews 1 pm today
function daylight() {
  const now = new Date(); if (now - sunAt < 60000) return false; sunAt = now;
  const when = isNaN(sunHour) ? now : new Date(new Date(now).setHours(Math.floor(sunHour), (sunHour % 1) * 60, 0, 0));
  const { alt, az } = sunPos(when), deg = alt * 180 / Math.PI;
  const k = Math.max(0, Math.min(1, (deg + 4) / 14));          // 0 = night, 1 = sun above ~10°
  const warm = Math.max(0, Math.min(1, 1 - (deg - 2) / 18));   // low sun is warmer
  const a = k > 0 ? alt : 0.9, z = k > 0 ? az : 2.4;            // at night: a dim moon-ish light from high in the south-east
  sun.position.set(Math.cos(a) * Math.cos(z) * 30, Math.max(2, Math.sin(a) * 30), Math.cos(a) * Math.sin(z) * 30);
  sun.intensity = .3 + 1.25 * k;
  sun.color.copy(NIGHT.sun).lerp(DAY.sun.clone().lerp(DAY.low, warm * .8), k);
  hemi.intensity = .34 + .4 * k;
  hemi.color.copy(NIGHT.hemi).lerp(DAY.hemi, k); hemi.groundColor.copy(NIGHT.hemiG).lerp(DAY.hemiG, k);
  M.grass.color.copy(NIGHT.grass).lerp(DAY.grass, k);
  hemiN.color.copy(hemi.color); hemiN.groundColor.copy(hemi.groundColor); hemiN.intensity = hemi.intensity;
  sunN.color.copy(sun.color); sunN.intensity = sun.intensity; sunN.position.copy(sun.position);
  return true;
}

/* ---------- drawing: our house as normal, then number 31 blurred over it ----------
   The neighbour goes into a half-size buffer that first gets our scene's depth (colour switched off), so
   wherever our house or garden is in front, it stays hidden; that buffer is blurred twice each way and laid
   over the picture, tone-mapped like everything else. */
const halfFloat = renderer.capabilities.isWebGL2 && (renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float"));
const rtOpts = { type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType };
const rtA = new THREE.WebGLRenderTarget(2, 2, rtOpts), rtB = new THREE.WebGLRenderTarget(2, 2, { ...rtOpts, depthBuffer: false });
const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), fsScene = new THREE.Scene();
const fsVert = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
const blurMat = new THREE.ShaderMaterial({ uniforms: { tMap: { value: null }, step: { value: new THREE.Vector2() } }, vertexShader: fsVert, depthTest: false, depthWrite: false,
  fragmentShader: `uniform sampler2D tMap; uniform vec2 step; varying vec2 vUv;
    void main() { vec4 c = texture2D(tMap, vUv) * .2270270270;
      c += (texture2D(tMap, vUv + step * 1.3846153846) + texture2D(tMap, vUv - step * 1.3846153846)) * .3162162162;
      c += (texture2D(tMap, vUv + step * 3.2307692308) + texture2D(tMap, vUv - step * 3.2307692308)) * .0702702703;
      gl_FragColor = c; }` });
const overMat = new THREE.ShaderMaterial({ uniforms: { tMap: { value: null } }, vertexShader: fsVert, depthTest: false, depthWrite: false, transparent: true,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  fragmentShader: `uniform sampler2D tMap; varying vec2 vUv;
    void main() { vec4 c = texture2D(tMap, vUv); if (c.a < .004) discard;
      gl_FragColor = vec4(c.rgb / c.a, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
      gl_FragColor = vec4(gl_FragColor.rgb * c.a, c.a); }` });
const fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat); fsQuad.frustumCulled = false; fsScene.add(fsQuad);
renderer.shadowMap.autoUpdate = false;
function sizeBlur() { const v = renderer.getDrawingBufferSize(new THREE.Vector2()); const w = Math.max(2, v.x >> 1), h = Math.max(2, v.y >> 1); rtA.setSize(w, h); rtB.setSize(w, h); }
let peek = false;   // five clicks on the house name: number 31, unblurred
function draw() {
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
  if (peek) { const ac = renderer.autoClear; renderer.autoClear = false; renderer.render(nbrScene, camera); renderer.autoClear = ac; labelR.render(scene, camera); return; }
  const ac = renderer.autoClear; renderer.autoClear = false;
  renderer.setRenderTarget(rtA); renderer.clear(true, true, true);
  const pv = nbrProxy && nbrProxy.visible; if (nbrProxy) nbrProxy.visible = false;
  scene.overrideMaterial = depthOnly; renderer.render(scene, camera); scene.overrideMaterial = null;   // our depth only
  if (nbrProxy) nbrProxy.visible = pv;
  renderer.render(nbrScene, camera);                                                                   // the neighbour, behind us where it should be
  fsQuad.material = blurMat; const w = rtA.width, h = rtA.height, r = 1.6;
  for (let i = 0; i < 2; i++) {
    blurMat.uniforms.tMap.value = rtA.texture; blurMat.uniforms.step.value.set(r / w, 0); renderer.setRenderTarget(rtB); renderer.clear(true, false, false); renderer.render(fsScene, fsCam);
    blurMat.uniforms.tMap.value = rtB.texture; blurMat.uniforms.step.value.set(0, r / h); renderer.setRenderTarget(rtA); renderer.clear(true, false, false); renderer.render(fsScene, fsCam);
  }
  renderer.setRenderTarget(null); fsQuad.material = overMat; overMat.uniforms.tMap.value = rtA.texture; renderer.render(fsScene, fsCam);
  renderer.autoClear = ac;
  labelR.render(scene, camera);
}

/* ---------- render on demand ---------- */
let raf = 0, alive = true;
function kick() { if (!raf && alive) raf = requestAnimationFrame(frame); }
function frame() {
  raf = 0;
  if (!container.clientWidth) return;
  const k = reduce ? 1 : EASE;
  let moving = controls.update();
  if (goal) {
    const tmp = goal.clone().sub(controls.target).multiplyScalar(k);
    controls.target.add(tmp);
    if (goalCam) camera.position.lerp(goalCam, k); else camera.position.add(tmp);
    if (tmp.lengthSq() < 1e-7 && (!goalCam || camera.position.distanceToSquared(goalCam) < 1e-5)) goal = goalCam = null; else moving = true;
  }
  if (camera.fov !== fovGoal) {
    camera.fov += (fovGoal - camera.fov) * k; if (Math.abs(fovGoal - camera.fov) < .05) camera.fov = fovGoal;
    camera.updateProjectionMatrix(); moving = true;
  }
  if (stepLevels(k)) moving = true;
  if (stepWalls(k)) moving = true;
  if (mode === "plan" && !goal && !planLock) {  // arrived: hold it straight down, back of the house at the top
    controls.minPolarAngle = controls.maxPolarAngle = .0005; controls.minAzimuthAngle = controls.maxAzimuthAngle = 0; planLock = true;
  }
  draw();
  if (moving) kick();
}
controls.addEventListener("change", kick);
controls.addEventListener("start", kick);

function homePos() { const a = container.clientWidth / Math.max(1, container.clientHeight); return HOME.pos.clone().multiplyScalar(a < .6 ? 2 : a < .8 ? 1.6 : a < 1.2 ? 1.25 : 1); }
function resize() {
  const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h); labelR.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); sizeBlur(); kick();
}
new ResizeObserver(resize).observe(container); resize(); camera.position.copy(homePos());
setInterval(() => { if (daylight()) kick(); }, 60000);
scene.updateMatrixWorld(true); nbrScene.updateMatrixWorld(true);
for (let l = 0; l < 3; l++) (l < 2 ? [G[l], NG[l]] : [G[l]]).forEach((g) => g.children.forEach((o) => { if (o.isMesh && cuttable(o)) measureWall(o, l); }));
daylight(); setView("house", "3d"); goal = goalCam = null; camera.fov = fovGoal; camera.updateProjectionMatrix();
const camQ = (new URLSearchParams(location.search).get("cam") || "").split(",").map(Number);   // ?cam=x,y,z,tx,ty,tz (for checking views)
if (camQ.length === 6 && camQ.every(isFinite)) { camera.position.set(camQ[0], camQ[1], camQ[2]); controls.target.set(camQ[3], camQ[4], camQ[5]); camLock = true; }

/* ---------- live state ---------- */
const lerpHex = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), Math.max(0, Math.min(1, t)));
const SEL = new THREE.Color(0x2e6fb8), WARM = new THREE.Color(0xff9a3c);
let names = null, last = {};
const kwTxt = (w) => w >= 1000 ? (w / 1000).toFixed(1) + " kW" : Math.round(w) + " W";
function update(st, ui) {
  if (!alive) return;
  let dirty = false;
  const want = ui.mode === "plan" ? "plan" : "3d";
  if ((ui.floor || "house") !== view || want !== mode) { setView(ui.floor || "house", want); dirty = true; }
  if (ui.selected !== selected) { selected = ui.selected; if (selected) focus(selected); dirty = true; }
  if (!names) { names = {}; st.layout.floors.forEach((f) => f.rooms.forEach((r) => { names[r.id] = r.name; })); }
  const byRoom = {};
  for (const l of Object.values(st.lights)) (byRoom[l.room] = byRoom[l.room] || []).push(l);
  for (const r of ROOMS) {
    if (!r.rid) continue;
    const ls = byRoom[r.rid] || [];
    const lvl = ls.reduce((m, l) => l.on ? Math.max(m, l.dimmable ? (l.level || 100) : 100) : m, 0);
    const t = r.rid === "tank" ? (st.hotwater || {}).temperature : ui.temp ? ui.temp(r.rid) : null;
    const z = st.zones[r.rid], heat = !!(z && z.demand > 0);
    const sp = z && r.rid !== "tank" ? z.setpoint : null;
    const key = [names[r.rid], ls.map((l) => +l.on).join(""), lvl, t == null ? "" : t.toFixed(1), heat, sp, selected === r.rid].join("|");
    if (key === r.key) continue;
    r.key = key; dirty = true;
    if (r.card) drawCard(r, r.rid === "tank" ? "Hot water" : names[r.rid] || r.rid, t, heat, ls, selected === r.rid, sp);
    if (r.glow) r.glow.opacity = lvl > 0 ? .3 + .5 * lvl / 100 : 0;
    if (selected === r.rid) { r.mat.emissive.copy(SEL); r.mat.emissiveIntensity = .35; }
    else if (lvl > 0) { r.mat.emissive.copy(WARM); r.mat.emissiveIntensity = .1 + .2 * lvl / 100; }
    else { r.mat.emissive.set(0x000000); r.mat.emissiveIntensity = 0; }
  }
  // hot-water cylinder: blue when cold, through to orange-red when hot; glows while heating
  const hw = st.hotwater || {}, tt = hw.temperature, heating = !!(hw.heating || hw.boost);
  const tk = [tt == null ? "" : Math.round(tt), heating].join("|");
  if (tk !== last.tank) {
    last.tank = tk; dirty = true;
    tankMat.color.copy(tt == null ? new THREE.Color(0xd8dcde) : lerpHex(0x4cc9f0, 0xff6b4a, (tt - 20) / 35));
    tankMat.emissive.copy(tankMat.color); tankMat.emissiveIntensity = heating ? .45 : .12;
  }
  const z1 = (st.zones || {}).bed1, rk = !!(z1 && z1.demand > 0);
  if (rk !== last.rad) { last.rad = rk; dirty = true; radMat.emissive.set(rk ? 0xff6b3a : 0x000000); radMat.emissiveIntensity = rk ? .35 : 0; }
  const a = st.aircon || {}, ak = [a.power, a.mode].join("|");
  if (ak !== last.ac) {
    last.ac = ak; dirty = true;
    const col = !a.power ? 0x3a4552 : a.mode === "heat" ? 0xff6b4a : a.mode === "cool" ? 0x4cc9f0 : 0xc4b5fd;
    acStrip.color.set(col); acStrip.emissive.set(a.power ? col : 0x000000); acStrip.emissiveIntensity = a.power ? .9 : 0;
  }
  for (const [id, b] of Object.entries(st.blinds || {})) {
    if (setBlind(id, b.position)) dirty = true;
    const rc = roofCards[id]; if (rc && rc.pos !== b.position) { rc.pos = b.position; drawRoofCard(rc, b.position); dirty = true; }
  }
  // solar: the panels glow with the share of their 5.39 kWp they're producing
  const sw = Math.max(0, (st.energy || {}).solar_w || 0), sim = (st.integrations || {}).fox?.mode !== "live";
  const sk = [Math.round(sw / 50), sim].join("|");
  if (sk !== last.solar) {
    last.solar = sk; dirty = true;
    pvMat.emissiveIntensity = Math.min(1, sw / (PV.kwp * 1000)) * 1.1;
    solarEl.querySelector("b").textContent = "☀ " + kwTxt(sw);
    solarEl.querySelector("small").textContent = sim ? "simulated, not installed yet" : `of ${PV.kwp} kWp`;
    solarEl.classList.toggle("lit", sw > 50);
  }
  // the Tesla (Intelligent Octopus): cable when plugged in, port blue when ready and green when charging
  const ev = st.ev || {}, ek = [ev.plugged, ev.charging, ev.soc == null ? "" : Math.round(ev.soc), ev.state, Math.round((ev.power_w || 0) / 100)].join("|");
  if (ek !== last.ev) {
    last.ev = ek; dirty = true;
    car.visible = cable.visible = !!ev.plugged;   // not plugged in means unplugged or away: Octopus can't say which, so no car
    alien.visible = !!ev.charging; carLabel();
    if (ev.charging && !alienTimer) alienTimer = setInterval(alienPulse, 66);
    if (!ev.charging && alienTimer) { clearInterval(alienTimer); alienTimer = 0; carTrim.emissiveIntensity = carDash.emissiveIntensity = 0; }
    portMat.color.set(ev.charging ? 0x4ade80 : ev.plugged ? 0x60a5fa : 0x223040);
    carEl.querySelector("b").textContent = "Tesla" + (ev.soc != null ? ` ${Math.round(ev.soc)}%` : "");
    carEl.querySelector("small").textContent = ev.charging ? `charging${ev.power_w ? " " + kwTxt(ev.power_w) : ""}` : ev.plugged ? "plugged in" : "not plugged in";
    carEl.classList.toggle("lit", !!ev.charging); carEl.classList.toggle("nolights", !ev.plugged);
  }
  if (daylight()) dirty = true;
  if (dirty) kick();
}

return { update, resize, peek(on) { peek = !!on; kick(); }, home() { camera.position.copy(homePos()); controls.target.copy(HOME.tgt); goal = null; kick(); } };
}

window.House3D = { load, mount, sunPos };
})();
