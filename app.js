import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  FORM_CLASSES, PUMPS, pumpByKey, initPressure, pressurePass, press,
  cellPsf, cellUtil, clearPressure, burstNeighbors, advisory, pumpModel,
} from './pressure.js';
import {
  fetchMixData, normalizeImport, fitCurve, fallbackCurve, evalCurve,
  solveAge, drawMixChart, parseAggIn, entryPoints, TEST_FIXTURE,
} from './mixdata.js';
import { createSurface } from './surface.js';
import { enhanceSelect } from './fancy.js';
import { analyzeElement, fillState, validateElement } from './elements.js';

/* ============================================================
   OpenPour — Concrete Pour Simulator
   Voxel grid: 1 cell = 1 ft. CPU-friendly: instanced meshes,
   no shadows, 10 Hz sim tick, capped pixel ratio.
   ============================================================ */

// ---------- Grid (variable — see reinitWorld) ----------
let GX = 64, GY = 24, GZ = 64;
let N = GX * GY * GZ;
const EMPTY = 0, FORM = 1, CONC = 2;

let grid = new Uint8Array(N);
let born = new Float32Array(N);            // sim time the concrete cell was placed
let hmap = new Uint8Array(GX * GZ);        // top of concrete per column (y+1)
let formClass = new Uint8Array(N);         // form class index (valid where grid===FORM)
const formSet = new Set();                 // indices of all FORM cells

const idx = (x, y, z) => x + z * GX + y * GX * GZ;
const cellOf = (i) => {
  const y = (i / (GX * GZ)) | 0;
  const r = i - y * GX * GZ;
  const z = (r / GX) | 0;
  return [r - z * GX, y, z];
};
const inB = (x, y, z) => x >= 0 && x < GX && y >= 0 && y < GY && z >= 0 && z < GZ;

// swappable RNG so the selftest can run deterministically
let rand = Math.random;
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Settings / state ----------
const S = {
  tool: 'form',          // form | erase | pump | pour | select | place
  wallH: 4,
  formClassIdx: 0,
  pump: 's32x',
  throttle: 1,           // 0.1 .. 1 of pump max output
  slump: 5,              // inches
  psi: 4000,
  aggIn: 1,              // nominal max aggregate, inches
  unitWt: 150,           // pcf
  setMin: 90,            // initial set, minutes (sim time)
  speed: 5,              // sim speed multiplier
  renderMode: 'blocks',  // 'blocks' | 'real'
  blowoutsOn: true,
  showGrid: true,
  mix: null,             // selected mix object from mixdata, or null = manual
  tipMode: 'auto',       // 'auto' (operator rides ~3 ft above surface) | 'manual'
  tipY: 12,              // manual boom tip elevation, ft
};

let simTime = 0;
let simStarted = false;    // the sim clock only runs once a pour has begun
let pouring = false;
let spawnAcc = 0;
let placedFt3 = 0;                 // UI net volume (decrements on erase)
let spawnedFt3Total = 0;           // audit: every cell ever pumped
let erasedFt3Total = 0;            // audit: every CONC cell removed by hand/clear
let ft3OverDrop = 0;               // cells placed with > 5 ft free fall (segregation risk)
let blowouts = 0;
let pumpPos = null;                // {x,z} world coords (continuous)
let pourPt = null;                 // {x,z} integer column
let active = new Map();            // cell idx -> stuck counter
let concDirty = true, formDirty = true, surfDirty = true;
let cMin = [GX, GY, GZ], cMax = [-1, -1, -1];
const undoStack = [];
let grossSF = 0, minRatingPsf = FORM_CLASSES[0].psf;
let pumpState = { rateCYhr: 0, reqPsi: 0, effCYhr: 0, derated: false, maxPsi: 1 };
let pour = null;                   // manual-pour report data

// pour elements (footings etc.)
let elements = [];
let nextElemId = 1;
let activeElem = null;             // element currently being poured (auto or manual)
let autoPour = null;               // sequencer state
let boomTip = null;                // {x,y,z} visual tip override during travel
let sceneName = 'Standard';

const setSec = () => S.setMin * 60;
const slumpP = () => Math.min(0.98, Math.pow((S.slump - 1) / 8, 1.6));
const settleLimit = () => 10 + S.slump * 3;
const markConc = () => { concDirty = true; surfDirty = true; };

// 24 permutations of the 4 lateral dirs, precomputed (no per-tick GC)
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRPERMS = (() => {
  const out = [];
  const perm = (arr, pre) => {
    if (!arr.length) { out.push(pre); return; }
    arr.forEach((d, i) => perm(arr.filter((_, j) => j !== i), [...pre, d]));
  };
  perm(DIRS4, []);
  return out;
})();

// shared context for the helper modules — MUTATED IN PLACE by reinitWorld,
// never replaced (pressure.js keeps a reference)
const ctx = {
  GX, GY, GZ, N, EMPTY, FORM, CONC,
  grid, born, hmap, formClass, formSet,
  idx, cellOf, inB,
  rand: () => rand(),
};
initPressure(ctx);

// ---------- Three.js setup ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
{
  // dusk gradient sky
  const c = document.createElement('canvas');
  c.width = 2; c.height = 512;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, '#2c3d5c');
  gr.addColorStop(0.45, '#6d87a8');
  gr.addColorStop(0.72, '#c2a182');
  gr.addColorStop(1, '#d9b48a');
  g.fillStyle = gr;
  g.fillRect(0, 0, 2, 512);
  const sky = new THREE.CanvasTexture(c);
  sky.colorSpace = THREE.SRGBColorSpace;
  scene.background = sky;
}
scene.fog = new THREE.Fog(0xb39a7f, 200, 470);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 900);
camera.position.set(GX * 0.5 - 50, 55, GZ * 0.5 + 70);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(GX / 2, 2, GZ / 2);
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.minDistance = 8;
controls.maxDistance = 420;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
// Left button is reserved for tools; rotate with right, zoom with wheel.
controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

scene.add(new THREE.HemisphereLight(0xbcd2ec, 0x5e5446, 1.05));
const sun = new THREE.DirectionalLight(0xffdfae, 1.6);
sun.position.set(60, 110, 30);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x7a9cd4, 0.35);
rim.position.set(-70, 40, -60);
scene.add(rim);

// ---------- Procedural textures ----------
function makeNoiseCanvas(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function speckle(g, size, count, alpha) {
  for (let i = 0; i < count; i++) {
    const v = (Math.random() * 36 - 18) | 0;
    g.fillStyle = `rgba(${128 + v},${128 + v},${128 + v},${alpha})`;
    g.fillRect((Math.random() * size) | 0, (Math.random() * size) | 0, 3, 3);
  }
}

// ground: dirt with blotches + faint tire arcs
const groundTex = makeNoiseCanvas(256, (g, s) => {
  g.fillStyle = '#6f6450';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 26; i++) {
    const v = Math.random() * 26 - 13;
    g.fillStyle = `rgba(${111 + v},${100 + v},${80 + v},0.5)`;
    g.beginPath();
    g.ellipse(Math.random() * s, Math.random() * s, 12 + Math.random() * 34, 8 + Math.random() * 22, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  speckle(g, s, 900, 0.10);
  g.strokeStyle = 'rgba(60,52,40,0.18)';
  g.lineWidth = 3;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.arc(Math.random() * s, Math.random() * s, 40 + Math.random() * 80, Math.random() * 6, Math.random() * 2 + 1);
    g.stroke();
  }
});
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;

// pad: compacted gravel + roller lines
const padTex = makeNoiseCanvas(256, (g, s) => {
  g.fillStyle = '#847762';
  g.fillRect(0, 0, s, s);
  speckle(g, s, 1400, 0.14);
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 6;
  for (let y = 14; y < s; y += 28) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
  }
});
padTex.wrapS = padTex.wrapT = THREE.RepeatWrapping;

// Ground / pad / grid / overlay (geometry replaced by resizeStatics on reinit)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 10),
  new THREE.MeshLambertMaterial({ map: groundTex })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const pad = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 10),
  new THREE.MeshLambertMaterial({ map: padTex })
);
pad.rotation.x = -Math.PI / 2;
scene.add(pad);

let gridHelper = null;

const overlayMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false });
const overlay = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), overlayMat);
overlay.rotation.x = -Math.PI / 2;
overlay.visible = false;
scene.add(overlay);

function resizeStatics() {
  const gw = Math.max(500, GX * 8), gd = Math.max(500, GZ * 8);
  ground.geometry.dispose();
  ground.geometry = new THREE.PlaneGeometry(gw, gd);
  ground.position.set(GX / 2, -0.01, GZ / 2);
  groundTex.repeat.set(gw / 24, gd / 24);
  pad.geometry.dispose();
  pad.geometry = new THREE.PlaneGeometry(GX, GZ);
  pad.position.set(GX / 2, 0.0, GZ / 2);
  padTex.repeat.set(GX / 10, GZ / 10);
  if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose(); }
  const gs = Math.max(GX, GZ);
  gridHelper = new THREE.GridHelper(gs, gs, 0x3c372f, 0x59503f);
  gridHelper.position.set(GX / 2, 0.02, GZ / 2);
  gridHelper.visible = S.showGrid;
  scene.add(gridHelper);
  overlay.geometry.dispose();
  overlay.geometry = new THREE.PlaneGeometry(GX, GZ);
  overlay.position.set(GX / 2, 0.05, GZ / 2);
  scene.fog.far = Math.max(470, GX * 7);
  scene.fog.near = scene.fog.far - 270;
}

// ---------- Block textures / materials ----------
function makeTex({ base, border = false, grain = false, nearest = false, draw = null }) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  speckle(g, 128, 500, 0.12);
  if (grain) {
    g.strokeStyle = 'rgba(90,60,25,0.25)';
    for (let y = 8; y < 128; y += 14 + ((Math.random() * 10) | 0)) {
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(40, y + 4, 88, y - 4, 128, y + 2);
      g.stroke();
    }
  }
  if (draw) draw(g);
  if (border) {
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 7;
    g.strokeRect(0, 0, 128, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// per-form-class texture recipes
const FORM_DRAW = [
  // 0: 3/4" ply — grain + snap-tie dots
  (g) => {
    g.fillStyle = 'rgba(40,28,16,0.55)';
    for (const [x, y] of [[32, 32], [96, 32], [32, 96], [96, 96]]) {
      g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
    }
  },
  // 1: HDO gang — dark overlay sheen streaks
  (g) => {
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 9;
    for (let i = -2; i < 5; i++) {
      g.beginPath(); g.moveTo(i * 38, 128); g.lineTo(i * 38 + 60, 0); g.stroke();
    }
  },
  // 2: steel-ply — panel seams + rivets
  (g) => {
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 3;
    for (const x of [42, 86]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
    g.fillStyle = 'rgba(0,0,0,0.4)';
    for (let y = 14; y < 128; y += 25) {
      for (const x of [8, 50, 94, 120]) { g.beginPath(); g.arc(x, y, 2.4, 0, Math.PI * 2); g.fill(); }
    }
  },
];
const FORM_BASE = ['#c89b5a', '#7a5c3e', '#9aa0a8'];
const FORM_GRAIN = [true, false, false];

const MATS = {
  concMC: new THREE.MeshLambertMaterial({ map: makeTex({ base: '#ffffff', border: true, nearest: true }) }),
  formCls: FORM_BASE.map((base, k) => ({
    mc: new THREE.MeshLambertMaterial({ map: makeTex({ base, border: true, nearest: true, grain: FORM_GRAIN[k], draw: FORM_DRAW[k] }) }),
    sm: new THREE.MeshLambertMaterial({ map: makeTex({ base, grain: FORM_GRAIN[k], draw: FORM_DRAW[k] }) }),
  })),
};

// ---------- Instanced meshes (recreated on reinit) ----------
const box = new THREE.BoxGeometry(1, 1, 1);
let CAP = 0;
let concMesh = null, concCells = null;
let formMeshes = [null, null, null], formCellsArr = [null, null, null];

function createInstanced() {
  if (concMesh) { scene.remove(concMesh); concMesh.dispose(); }
  for (const m of formMeshes) if (m) { scene.remove(m); m.dispose(); }
  CAP = Math.min(90000, Math.max(40000, GX * GZ * 10));
  concMesh = new THREE.InstancedMesh(box, MATS.concMC, CAP);
  concMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  concMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
  concMesh.frustumCulled = false;
  scene.add(concMesh);
  concCells = new Int32Array(CAP);
  const fCap = Math.max(20000, (CAP / 2) | 0);
  formMeshes = FORM_CLASSES.map((_, k) => {
    const m = new THREE.InstancedMesh(box, S.renderMode === 'real' ? MATS.formCls[k].sm : MATS.formCls[k].mc, fCap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(fCap * 3), 3);
    m.frustumCulled = false;
    scene.add(m);
    return m;
  });
  formCellsArr = formMeshes.map(() => new Int32Array(fCap));
}
createInstanced();

// realistic-mode isosurface (recreated on reinit)
let surf = createSurface(ctx);
scene.add(surf.mesh);

const _m = new THREE.Matrix4();
const _colFresh = new THREE.Color(0x6f746c);
const _colCured = new THREE.Color(0xa7a79f);
const _c = new THREE.Color();

let capWarned = false;

function exposed(x, y, z) {
  return (
    x === 0 || grid[idx(x - 1, y, z)] === EMPTY ||
    x === GX - 1 || grid[idx(x + 1, y, z)] === EMPTY ||
    z === 0 || grid[idx(x, y, z - 1)] === EMPTY ||
    z === GZ - 1 || grid[idx(x, y, z + 1)] === EMPTY ||
    y === 0 || grid[idx(x, y - 1, z)] === EMPTY ||
    y === GY - 1 || grid[idx(x, y + 1, z)] === EMPTY
  );
}

function rebuildConc() {
  let n = 0;
  const y0 = Math.max(0, cMin[1]), y1 = Math.min(GY - 1, cMax[1]);
  for (let y = y0; y <= y1 && n < CAP; y++) {
    for (let z = Math.max(0, cMin[2]); z <= Math.min(GZ - 1, cMax[2]); z++) {
      for (let x = Math.max(0, cMin[0]); x <= Math.min(GX - 1, cMax[0]); x++) {
        const i = idx(x, y, z);
        if (grid[i] !== CONC || !exposed(x, y, z)) continue;
        if (n >= CAP) break;
        _m.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
        concMesh.setMatrixAt(n, _m);
        const a = Math.min(1, (simTime - born[i]) / setSec());
        _c.copy(_colFresh).lerp(_colCured, a);
        concMesh.setColorAt(n, _c);
        concCells[n] = i;
        n++;
      }
    }
  }
  if (n >= CAP && !capWarned) { capWarned = true; toast('Render cap reached — some blocks may not draw'); }
  concMesh.count = n;
  concMesh.instanceMatrix.needsUpdate = true;
  if (concMesh.instanceColor) concMesh.instanceColor.needsUpdate = true;
  concDirty = false;
}

// utilization tint ramp: natural texture → green → yellow → red
function utilColor(out, u) {
  if (u < 0.3) out.setRGB(1, 1, 1);
  else if (u < 0.6) out.setRGB(1 - 0.45 * ((u - 0.3) / 0.3), 1, 1 - 0.55 * ((u - 0.3) / 0.3));
  else if (u < 0.9) out.setRGB(0.55 + 0.45 * ((u - 0.6) / 0.3), 1 - 0.25 * ((u - 0.6) / 0.3), 0.45 - 0.25 * ((u - 0.6) / 0.3));
  else out.setRGB(1, Math.max(0.15, 0.75 - (u - 0.9) * 1.2), 0.2);
  return out;
}

function rebuildForms() {
  const counts = [0, 0, 0];
  const fCap = formCellsArr[0].length;
  let gross = 0, minR = Infinity;
  for (let y = 0; y < GY; y++)
    for (let z = 0; z < GZ; z++)
      for (let x = 0; x < GX; x++) {
        const i = idx(x, y, z);
        if (grid[i] !== FORM) continue;
        const cl = formClass[i];
        const r = FORM_CLASSES[cl].psf;
        if (r < minR) minR = r;
        // gross panel SF: faces not against another form block
        for (const [dx, , dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (!inB(nx, y, nz) || grid[idx(nx, y, nz)] !== FORM) gross++;
        }
        if (!exposed(x, y, z)) continue;
        const n = counts[cl];
        if (n >= fCap) continue;
        _m.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
        formMeshes[cl].setMatrixAt(n, _m);
        if (selection.has(i)) _c.setRGB(0.55, 0.75, 1.5);   // selected: blue glow
        else utilColor(_c, cellUtil(i, cl));
        formMeshes[cl].setColorAt(n, _c);
        formCellsArr[cl][n] = i;
        counts[cl] = n + 1;
      }
  grossSF = gross;
  minRatingPsf = minR < Infinity ? minR : FORM_CLASSES[S.formClassIdx].psf;
  formMeshes.forEach((m, k) => {
    m.count = counts[k];
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  formDirty = false;
}

// ---------- Pump / boom visuals ----------
const truck = new THREE.Group();
{
  const steel = new THREE.MeshLambertMaterial({ color: 0xd8d8dc });
  const red = new THREE.MeshLambertMaterial({ color: 0xb33a2f });
  const dark = new THREE.MeshLambertMaterial({ color: 0x333338 });
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(24, 2.5, 8), steel);
  chassis.position.y = 3.2;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 8), red);
  cab.position.set(-10, 5.5, 0);
  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(5, 4, 5), red);
  pedestal.position.set(6, 6.5, 0);
  truck.add(chassis, cab, pedestal);
  for (const [ox, oz] of [[-8, 5.5], [-8, -5.5], [9, 5.5], [9, -5.5]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3.5, 1.2), dark);
    leg.position.set(ox, 1.75, oz);
    truck.add(leg);
  }
  for (const ox of [-7, 0, 7]) {
    for (const oz of [4.2, -4.2]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 1.4, 10), dark);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(ox, 1.7, oz);
      truck.add(wheel);
    }
  }
}
truck.visible = false;
scene.add(truck);

const reachRing = new THREE.Mesh(
  new THREE.RingGeometry(1, 1.012, 64),
  new THREE.MeshBasicMaterial({ color: 0x2f7fd4, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
);
reachRing.rotation.x = -Math.PI / 2;
reachRing.position.y = 0.08;
reachRing.visible = false;
scene.add(reachRing);

let boomMesh = null;
const boomMat = new THREE.MeshLambertMaterial({ color: 0xb33a2f });

const pourMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.55, 0.85, 24),
  new THREE.MeshBasicMaterial({ color: 0xffaa22, side: THREE.DoubleSide })
);
pourMarker.rotation.x = -Math.PI / 2;
pourMarker.visible = false;
scene.add(pourMarker);

const stream = new THREE.Mesh(
  new THREE.CylinderGeometry(0.28, 0.34, 1, 8),
  new THREE.MeshLambertMaterial({ color: 0x70756d })
);
stream.visible = false;
scene.add(stream);

// blowout debris pool
const debris = [];
{
  const mat = MATS.formCls[0].sm;
  for (let k = 0; k < 16; k++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1, 1), mat);
    m.visible = false;
    scene.add(m);
    debris.push({ m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
  }
}

function spawnDebris(x, y, z) {
  for (let k = 0; k < 10; k++) {
    const d = debris[(Math.random() * debris.length) | 0];
    d.m.position.set(x + 0.5, y + 0.5 + Math.random() * 2, z + 0.5);
    d.vel.set((Math.random() - 0.5) * 14, 7 + Math.random() * 7, (Math.random() - 0.5) * 14);
    d.spin.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    d.life = 2.2;
    d.m.visible = true;
  }
}

function updateDebris(dt) {
  for (const d of debris) {
    if (d.life <= 0) continue;
    d.life -= dt;
    d.vel.y -= 32 * dt;
    d.m.position.addScaledVector(d.vel, dt);
    d.m.rotation.x += d.spin.x * dt;
    d.m.rotation.y += d.spin.y * dt;
    if (d.m.position.y < 0.2 || d.life <= 0) { d.life = 0; d.m.visible = false; }
  }
}

// settled surface near a column — neighbor average, capped by the column's
// own top. The spawn column itself carries the in-flight backlog, so reading
// hmap there directly would inflate the surface (and kill the free-fall calc).
function settledTop(x, z) {
  let nb = 0;
  for (const [dx, dz] of DIRS4) {
    const nx = x + dx, nz = z + dz;
    if (nx < 0 || nx >= GX || nz < 0 || nz >= GZ) continue;
    const h = hmap[nx + nz * GX];
    if (h > nb) nb = h;
  }
  return Math.min(hmap[x + z * GX], nb + 2);
}

// boom tip elevation for a pour column (operator behavior)
function tipYFor(col) {
  if (S.tipMode === 'manual') return Math.max(2, Math.min(GY + 2, S.tipY));
  return Math.max(4, Math.min(GY + 2, settledTop(col.x, col.z) + 3));
}

function updateBoom() {
  if (boomMesh) { scene.remove(boomMesh); boomMesh.geometry.dispose(); boomMesh = null; }
  if (!pumpPos) return;
  let tx, ty, tz;
  if (boomTip) { tx = boomTip.x; ty = boomTip.y; tz = boomTip.z; }
  else if (pourPt) { tx = pourPt.x + 0.5; tz = pourPt.z + 0.5; ty = tipYFor(pourPt) + 0.5; }
  else return;
  const a = new THREE.Vector3(pumpPos.x, 8.5, pumpPos.z);
  const tip = new THREE.Vector3(tx, ty, tz);
  const isLine = !pumpByKey(S.pump).boom;
  let curve;
  if (isLine) {
    const mid = a.clone().lerp(tip, 0.5); mid.y = 0.6;
    const end = tip.clone();
    curve = new THREE.CatmullRomCurve3([new THREE.Vector3(a.x, 1.2, a.z), mid, new THREE.Vector3(end.x, 0.6, end.z), end]);
  } else {
    const apex = a.clone().lerp(tip, 0.45);
    apex.y = Math.max(a.y, tip.y) + 14;
    curve = new THREE.CatmullRomCurve3([a, apex, tip]);
  }
  boomMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, isLine ? 0.22 : 0.45, 6), boomMat);
  scene.add(boomMesh);
}

function placePump(x, z) {
  pumpPos = { x, z };
  truck.position.set(x, 0, z);
  truck.visible = true;
  const reach = pumpByKey(S.pump).reach;
  if (isFinite(reach)) {
    reachRing.scale.set(reach, reach, 1);
    reachRing.position.set(x, 0.08, z);
    reachRing.visible = true;
  } else {
    reachRing.visible = false;
  }
  if (pourPt) truck.lookAt(pourPt.x + 0.5, 0, pourPt.z + 0.5);
  updateBoom();
}

function setPourPoint(x, z) {
  if (!pumpPos) { toast('Place the pump first (tool 3)'); return; }
  const reach = pumpByKey(S.pump).reach;
  const d = Math.hypot(x + 0.5 - pumpPos.x, z + 0.5 - pumpPos.z);
  if (d > reach) { toast(`Out of reach — ${d.toFixed(0)} ft > ${reach} ft boom`); return; }
  pourPt = { x, z };
  pourMarker.position.set(x + 0.5, 0.1, z + 0.5);
  pourMarker.visible = true;
  truck.lookAt(x + 0.5, 0, z + 0.5);
  updateBoom();
}

// ---------- Pump hydraulics ----------
function pumpHydraulics() {
  const pump = pumpByKey(S.pump);
  let lineLen, rise;
  if (pump.boom) {
    rise = pourPt ? tipYFor(pourPt) : GY + 2;        // live boom tip = static head
    lineLen = pump.reach * 1.15 + rise + 12;         // boom pipe + tip hose
  } else {
    const d = (pumpPos && pourPt)
      ? Math.hypot(pourPt.x + 0.5 - pumpPos.x, pourPt.z + 0.5 - pumpPos.z)
      : 100;
    rise = pourPt ? Math.max(4, hmap[pourPt.x + pourPt.z * GX]) : 6;
    lineLen = d + 40;                                // hose run + slack
  }
  pumpState = pumpModel(S, pump, lineLen, rise);
  return pumpState;
}

// ---------- Simulation ----------
function rescanCol(x, z) {
  const c = x + z * GX;
  for (let y = GY - 1; y >= 0; y--) {
    if (grid[idx(x, y, z)] === CONC) { hmap[c] = y + 1; return; }
  }
  hmap[c] = 0;
}

function expandBBox(x, y, z) {
  if (x < cMin[0]) cMin[0] = x; if (x > cMax[0]) cMax[0] = x;
  if (y < cMin[1]) cMin[1] = y; if (y > cMax[1]) cMax[1] = y;
  if (z < cMin[2]) cMin[2] = z; if (z > cMax[2]) cMax[2] = z;
}

function wake(x, y, z) {
  if (!inB(x, y, z)) return;
  const i = idx(x, y, z);
  if (grid[i] === CONC && simTime - born[i] < setSec()) active.set(i, 0);
}

function wakeAround(x, y, z) {
  wake(x, y + 1, z);
  for (const [dx, dz] of DIRS4) {
    wake(x + dx, y, z + dz);
    wake(x + dx, y + 1, z + dz);
  }
}

function moveConc(from, to) {
  const [fx, fy, fz] = cellOf(from);
  const [tx, ty, tz] = cellOf(to);
  grid[to] = CONC;
  born[to] = born[from];
  grid[from] = EMPTY;
  active.delete(from);
  active.set(to, 0);
  rescanCol(fx, fz);
  if (tx !== fx || tz !== fz) rescanCol(tx, tz);
  expandBBox(tx, ty, tz);
  wakeAround(fx, fy, fz);
  markConc();
}

function tryMove(i, p) {
  const [x, y, z] = cellOf(i);
  if (y > 0) {
    const b = idx(x, y - 1, z);
    if (grid[b] === EMPTY) { moveConc(i, b); return true; }
  }
  const myTop = hmap[x + z * GX];
  const dirs = DIRPERMS[(rand() * 24) | 0];
  for (const [dx, dz] of dirs) {
    const nx = x + dx, nz = z + dz;
    if (nx < 0 || nx >= GX || nz < 0 || nz >= GZ) continue; // grid edge acts as containment
    const ni = idx(nx, y, nz);
    if (grid[ni] !== EMPTY) continue;
    let prob = 0;
    if (y > 0 && grid[idx(nx, y - 1, nz)] === EMPTY) {
      prob = 0.25 + 0.75 * p;                       // can fall over an edge
    } else {
      const diff = myTop - hmap[nx + nz * GX];
      if (diff >= 2) prob = 0.15 + 0.85 * p;        // downhill flow
      else if (diff === 1) prob = 0.4 * p * p;      // only wet mixes self-level flat
    }
    if (prob > 0 && rand() < prob) { moveConc(i, ni); return true; }
  }
  return false;
}

function spawnOne() {
  const { x, z } = pourPt;
  const tip = tipYFor(pourPt);
  const dropH = Math.max(0, tip - settledTop(x, z));
  // free-fall scatter: high discharge splatters off-target, and the radius
  // grows with the drop — a 20 ft free fall throws paste several feet out
  let sx = x, sz = z;
  if (dropH > 6 && rand() < Math.min(0.75, (dropH - 6) * 0.08)) {
    const r = 1 + Math.min(4, (dropH / 6) | 0);
    sx = Math.max(0, Math.min(GX - 1, x + ((rand() * (2 * r + 1)) | 0) - r));
    sz = Math.max(0, Math.min(GZ - 1, z + ((rand() * (2 * r + 1)) | 0) - r));
  }
  const t0 = Math.min(GY - 1, Math.max(1, Math.round(tip)));
  for (const y of [t0, Math.min(GY - 1, t0 + 1), Math.min(GY - 1, t0 + 2)]) {
    const i = idx(sx, y, sz);
    if (grid[i] === EMPTY) {
      grid[i] = CONC;
      born[i] = simTime;
      // impact energy: long drops splash — cell stays mobile longer
      active.set(i, dropH > 4 ? -((dropH / 4) | 0) : 0);
      rescanCol(sx, sz);
      expandBBox(sx, y, sz);
      placedFt3 += 1;
      spawnedFt3Total += 1;
      if (dropH > 5) ft3OverDrop += 1;
      if (activeElem && activeElem.result) {
        activeElem.result.spawned += 1;
        if (dropH > 5) activeElem.result.ft3OverDrop += 1;
      }
      markConc();
      return true;
    }
  }
  return false; // backed up at the boom tip
}

let spawnFails = 0;
let pressAcc = 0;
let elemCheck = 0;

function flowPass() {
  const p = slumpP();
  const limit = settleLimit();
  const cure = setSec();
  for (const [i, stuck] of [...active.entries()]) {
    if (grid[i] !== CONC) { active.delete(i); continue; }
    if (simTime - born[i] > cure) { active.delete(i); markConc(); continue; }
    if (!tryMove(i, p)) {
      if (stuck + 1 > limit) active.delete(i);
      else active.set(i, stuck + 1);
    }
  }
}

function burst(i) {
  const [x, y, z] = cellOf(i);
  const psf = Math.round(cellPsf(i));
  const rating = FORM_CLASSES[formClass[i]].psf;
  const name = FORM_CLASSES[formClass[i]].name;
  const targets = [i, ...burstNeighbors(i)];
  for (const j of targets) {
    if (grid[j] !== FORM) continue;
    grid[j] = EMPTY;
    formSet.delete(j);
    clearPressure(j);
  }
  // wake the plastic concrete nearby so it spills out the hole
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const cx = x + dx, cz = z + dz;
      if (cx < 0 || cx >= GX || cz < 0 || cz >= GZ) continue;
      const top = hmap[cx + cz * GX];
      for (let yy = Math.max(0, y - 1); yy < top; yy++) {
        const j = idx(cx, yy, cz);
        if (grid[j] === CONC && simTime - born[j] < setSec()) active.set(j, 0);
      }
    }
  }
  blowouts++;
  formDirty = true;
  markConc();
  spawnDebris(x, y, z);
  toast(`💥 BLOWOUT at (${x}, ${z}) — ${psf} psf vs ${rating} psf ${name}`);
}

// ---------- Auto-pour sequencer ----------
const elemById = (id) => elements.find((e) => e.id === id);

function cancelAutoPour() {
  if (!autoPour) return;
  pouring = false;
  for (const id of autoPour.order.slice(autoPour.k)) {
    const el = elemById(id);
    if (el && el.status !== 'done') el.status = 'pending';
  }
  autoPour = null;
  activeElem = null;
  boomTip = null;
  updateBoom();
  updateStartBtns();
}

function startAutoPour() {
  if (autoPour) { cancelAutoPour(); toast('Auto pour cancelled'); return; }
  if (!pumpPos) { toast('Place the pump first (tool 3)'); return; }
  if (pouring) { toast('Stop the manual pour first'); return; }
  const pump = pumpByKey(S.pump);
  if (S.aggIn > pump.maxAgg) {
    toast(`${S.aggIn}" aggregate won't pump through the ${pump.name} — ${pump.maxAgg}" max`);
    return;
  }
  const pending = [];
  for (const el of elements) {
    if (el.status === 'done') continue;
    el.analysis = analyzeElement(ctx, el);
    if (!el.analysis.valid) { el.status = 'skipped'; continue; }
    const [px, pz] = el.analysis.pourCol;
    if (Math.hypot(px + 0.5 - pumpPos.x, pz + 0.5 - pumpPos.z) > pump.reach) {
      el.status = 'skipped';
      toast(`${el.name} is out of boom reach — skipped`);
      continue;
    }
    el.status = 'pending';
    pending.push(el);
  }
  if (!pending.length) { toast('No reachable pour elements — stamp footings with the PLACE tool first'); return; }
  // nearest-first greedy ordering (minimize boom travel)
  const order = [];
  let cur = { x: pumpPos.x, z: pumpPos.z };
  while (pending.length) {
    let bi = 0, bd = Infinity;
    pending.forEach((el, i) => {
      const [px, pz] = el.analysis.pourCol;
      const d = Math.hypot(px + 0.5 - cur.x, pz + 0.5 - cur.z);
      if (d < bd) { bd = d; bi = i; }
    });
    const el = pending.splice(bi, 1)[0];
    order.push(el.id);
    cur = { x: el.analysis.pourCol[0] + 0.5, z: el.analysis.pourCol[1] + 0.5 };
  }
  autoPour = { order, k: -1, phase: 'travel', travelT: 0, travelDur: 0, from: null, to: null, startSim: simTime };
  simStarted = true;
  beginTravelToNext();
  toast(`Auto pour — ${order.length} element${order.length > 1 ? 's' : ''}, nearest first`);
  updateStartBtns();
}

function beginTravelToNext() {
  const ap = autoPour;
  ap.k++;
  if (ap.k >= ap.order.length) { finishAutoPour(); return; }
  const el = elemById(ap.order[ap.k]);
  const [px, pz] = el.analysis.pourCol;
  const from = boomTip
    || (pourPt ? { x: pourPt.x + 0.5, y: tipYFor(pourPt) + 0.5, z: pourPt.z + 0.5 }
               : { x: pumpPos.x, y: 10, z: pumpPos.z });
  const to = { x: px + 0.5, y: Math.min(GY + 2, el.analysis.targetTop + 4), z: pz + 0.5 };
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  ap.phase = 'travel';
  ap.travelT = 0;
  ap.travelDur = Math.max(2, dist / 12);  // sim seconds — boom slews ~12 ft/s
  ap.from = from;
  ap.to = to;
  pouring = false;
  boomTip = { ...from };
}

function beginPourElement(el) {
  pourPt = { x: el.analysis.pourCol[0], z: el.analysis.pourCol[1] };
  pourMarker.position.set(pourPt.x + 0.5, 0.1, pourPt.z + 0.5);
  pourMarker.visible = true;
  boomTip = null;
  pumpHydraulics();
  pouring = true;
  spawnFails = 0;
  activeElem = el;
  el.status = 'pouring';
  el.result = { startSim: simTime, spawned: 0, ft3OverDrop: 0, blowouts0: blowouts, peakUtil: 0, peakPsf: 0 };
  updateBoom();
}

function finishElement(el, reason) {
  pouring = false;
  const r = el.result;
  r.endSim = simTime;
  r.reason = reason;
  r.fillPct = fillState(ctx, el).fillPct;
  r.blowouts = blowouts - r.blowouts0;
  // measure this element's own forms at the moment of fullest load
  pressurePass(0.01, S, simTime, setSec());
  for (const [x, y, z] of el.cells) {
    const i = idx(x, y, z);
    if (grid[i] === FORM) r.peakPsf = Math.max(r.peakPsf, cellPsf(i));
  }
  r.peakUtil = Math.max(r.peakUtil, r.peakPsf / FORM_CLASSES[el.cells[0][3] || 0].psf);
  el.status = 'done';
  el.validation = validateElement(ctx, el, S.unitWt);
  activeElem = null;
  if (autoPour) beginTravelToNext();
}

function finishAutoPour() {
  autoPour = null;
  activeElem = null;
  boomTip = null;
  pourPt = null;
  pourMarker.visible = false;
  updateBoom();
  updateStartBtns();
  toast('Auto pour complete');
  if (!selftesting && $('chkReview').checked) showSeqReview();
}

function stepAutoPour(dt) {
  const ap = autoPour;
  if (ap.phase === 'travel') {
    ap.travelT += dt;
    const t = Math.min(1, ap.travelT / ap.travelDur);
    const s = t * t * (3 - 2 * t);
    boomTip = {
      x: ap.from.x + (ap.to.x - ap.from.x) * s,
      y: ap.from.y + (ap.to.y - ap.from.y) * s,
      z: ap.from.z + (ap.to.z - ap.from.z) * s,
    };
    updateBoom();
    truck.lookAt(boomTip.x, 0, boomTip.z);
    if (t >= 1) {
      ap.phase = 'pour';
      elemCheck = 0;
      beginPourElement(elemById(ap.order[ap.k]));
    }
    return;
  }
  // pour phase: checks at ~1/sim-second (elemCheck accumulated by tick)
  const el = elemById(ap.order[ap.k]);
  updateBoom(); // tip rides the surface via tipYFor
  const fs = fillState(ctx, el);
  if (fs.fillPct >= 0.95) { finishElement(el, 'filled'); return; }
  const effFt3s = Math.max(0.05, pumpState.effCYhr * 27 / 3600);
  const timeout = el.result.startSim + (1.5 * el.analysis.capacityFt3) / effFt3s + 120;
  if (simTime > timeout) finishElement(el, 'timeout');
}

// manual pours inside a registered element also stop at the form top
function checkManualFill() {
  if (!pouring || autoPour || !pourPt) return;
  if (!activeElem) return;
  if (fillState(ctx, activeElem).fillPct >= 0.95) {
    const el = activeElem;
    finishElement(el, 'filled');
    stopPour(`${el.name} full — stopped at form top`);
  }
}

function tick(dt) {
  if (!simStarted) return;   // clock starts with the first pour
  // Sub-step at high sim speeds so flow keeps pace with the spawn rate
  // (concrete drops at most 1 cell per flow pass).
  const sub = Math.max(1, Math.min(8, Math.round(S.speed / 4)));
  const sdt = dt / sub;
  for (let s = 0; s < sub; s++) {
    simTime += sdt;
    if (pouring && pourPt) {
      spawnAcc = Math.min(6, spawnAcc + pumpState.effCYhr * 27 / 3600 * sdt);
      while (spawnAcc >= 1) {
        if (!spawnOne()) {
          // Backed up at the boom tip. Transient clogs clear in a few
          // passes; a long streak means the form is genuinely full.
          if (++spawnFails > 200) stopPour('Form full at the pour point — pour stopped', true);
          break;
        }
        spawnFails = 0;
        spawnAcc -= 1;
      }
    }
    flowPass();
    pressAcc += sdt;
  }
  if (pressAcc >= 5) {
    const bursts = pressurePass(pressAcc, S, simTime, setSec());
    pressAcc = 0;
    formDirty = true;
    if (pour && press.worstUtil > pour.peakUtil) { pour.peakUtil = press.worstUtil; pour.peakPsf = press.peakPsf; }
    for (const i of bursts) burst(i);
  }
  elemCheck += dt;
  if (autoPour) {
    if (autoPour.phase === 'travel') stepAutoPour(dt);
    else if (elemCheck >= 1) { elemCheck = 0; stepAutoPour(dt); }
  } else if (elemCheck >= 1) {
    elemCheck = 0;
    checkManualFill();
  }
}

function startPour() {
  if (autoPour) { toast('Auto pour is running — cancel it first'); return; }
  if (!pumpPos) { toast('Place the pump first (tool 3)'); return; }
  if (!pourPt) { toast('Set a pour point first (tool 4)'); return; }
  const pump = pumpByKey(S.pump);
  if (S.aggIn > pump.maxAgg) {
    toast(`${S.aggIn}" aggregate won't pump through the ${pump.name} — ${pump.maxAgg}" max`);
    return;
  }
  // the pump may have been moved since the pour point was set
  const reachD = Math.hypot(pourPt.x + 0.5 - pumpPos.x, pourPt.z + 0.5 - pumpPos.z);
  if (reachD > pump.reach) {
    toast(`Pour point out of reach — ${reachD.toFixed(0)} ft > ${pump.reach} ft boom`);
    return;
  }
  pumpHydraulics();
  simStarted = true;
  pouring = true;
  spawnFails = 0;
  pour = { startSim: simTime, startVol: placedFt3, peakUtil: 0, peakPsf: 0, blowouts0: blowouts };
  // pouring into a registered element? then fill-to-top applies
  activeElem = null;
  const c = pourPt.x + pourPt.z * GX;
  for (const el of elements) {
    if (el.status === 'done') continue;
    el.analysis = el.analysis && el.analysis.valid ? el.analysis : analyzeElement(ctx, el);
    if (el.analysis.valid && el.analysis.interior.includes(c)) {
      activeElem = el;
      el.status = 'pouring';
      el.result = { startSim: simTime, spawned: 0, ft3OverDrop: 0, blowouts0: blowouts, peakUtil: 0, peakPsf: 0 };
      break;
    }
  }
  document.getElementById('btnStart').textContent = '⏹ Stop Pour';
  document.getElementById('btnStart').classList.add('pouring');
}

function stopPour(msg, fromSim) {
  if (autoPour && fromSim) {
    // "form full" during auto-pour = element done, move on
    const el = elemById(autoPour.order[autoPour.k]);
    if (el && el.status === 'pouring') { finishElement(el, 'formfull'); return; }
  }
  pouring = false;
  if (activeElem && activeElem.status === 'pouring') activeElem.status = 'pending';
  if (!autoPour) activeElem = null;
  document.getElementById('btnStart').textContent = '▶ Start Pour';
  document.getElementById('btnStart').classList.remove('pouring');
  if (msg) toast(msg);
  if (pour && placedFt3 - pour.startVol >= 27 && !selftesting && !autoPour) showReport();
}

// ---------- Editing ----------
let stroke = null; // {cells:[{i,prev,prevBorn,prevClass}]}

function setCell(i, v) {
  if (stroke) stroke.cells.push({ i, prev: grid[i], prevBorn: born[i], prevClass: formClass[i] });
  const [x, y, z] = cellOf(i);
  const was = grid[i];
  grid[i] = v;
  if (was === FORM) { formSet.delete(i); clearPressure(i); }
  if (v === FORM) { formClass[i] = S.formClassIdx; formSet.add(i); }
  if (v === CONC) born[i] = simTime;
  if (was === CONC || v === CONC) { rescanCol(x, z); markConc(); }
  if (was === FORM || v === FORM) { formDirty = true; surfDirty = true; }
  if (v === EMPTY) wakeAround(x, y, z);
  if (v !== EMPTY) expandBBox(x, y, z);
}

function placeFormColumn(x, y, z) {
  let changed = false;
  for (let h = 0; h < S.wallH; h++) {
    const yy = y + h;
    if (!inB(x, yy, z)) break;
    const i = idx(x, yy, z);
    if (grid[i] === EMPTY) { setCell(i, FORM); changed = true; }
  }
  return changed;
}

function eraseCell(x, y, z) {
  const i = idx(x, y, z);
  if (grid[i] === EMPTY) return false;
  if (grid[i] === CONC) {
    placedFt3 = Math.max(0, placedFt3 - 1);
    erasedFt3Total += 1;
  }
  active.delete(i);
  setCell(i, EMPTY);
  return true;
}

function pushUndo() {
  if (stroke && stroke.cells.length) {
    undoStack.push(stroke);
    if (undoStack.length > 60) undoStack.shift();
  }
  stroke = null;
}

function undo() {
  const s = undoStack.pop();
  if (!s) { toast('Nothing to undo'); return; }
  for (let k = s.cells.length - 1; k >= 0; k--) {
    const { i, prev, prevBorn, prevClass } = s.cells[k];
    const [x, , z] = cellOf(i);
    if (grid[i] === FORM && prev !== FORM) { formSet.delete(i); clearPressure(i); }
    if (grid[i] === CONC && prev !== CONC) erasedFt3Total += 1;
    if (grid[i] !== CONC && prev === CONC) spawnedFt3Total += 1; // restored by undo
    grid[i] = prev;
    born[i] = prevBorn;
    formClass[i] = prevClass;
    if (prev === FORM) formSet.add(i);
    rescanCol(x, z);
  }
  markConc();
  formDirty = true;
  saveLocal();
}

// ---------- Picking ----------
const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hover = null;
let painting = false;

const ghost = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.35, depthWrite: false })
);
ghost.visible = false;
scene.add(ghost);

// ---------- Selection & form groups ----------
const selection = new Set();
let selecting = false;
let selAnchor = null;   // {x,z}
const selBox = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x6ea8ff, transparent: true, opacity: 0.16, depthWrite: false })
);
selBox.visible = false;
scene.add(selBox);

let groups = [];        // {name, cells: [[dx,dy,dz,classIdx], ...], preset?}
let activeGroupIdx = 0;
let placeRot = 0;       // 0..3 quarter turns
const groupGhost = new THREE.InstancedMesh(
  box,
  new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.3, depthWrite: false }),
  2048
);
groupGhost.frustumCulled = false;
groupGhost.visible = false;
scene.add(groupGhost);

function rectOutline(w, d, h, cls) {
  const cells = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { cells.push([x, y, 0, cls], [x, y, d - 1, cls]); }
    for (let z = 1; z < d - 1; z++) { cells.push([0, y, z, cls], [w - 1, y, z, cls]); }
  }
  return cells;
}

function presetGroups() {
  return [
    { name: 'Spread footing 6×6×2', cells: rectOutline(6, 6, 2, 0), preset: true },
    { name: 'Spread footing 10×10×3', cells: rectOutline(10, 10, 3, 0), preset: true },
    { name: 'Pile cap 8×8×4', cells: rectOutline(8, 8, 4, 2), preset: true },
    { name: 'Grade beam 16 ft', cells: rectOutline(16, 4, 2, 0), preset: true },
    { name: 'Column form 4×4×10', cells: rectOutline(4, 4, 10, 1), preset: true },
  ];
}

function loadGroups() {
  try {
    const raw = localStorage.getItem('openpour_groups');
    if (raw) groups = JSON.parse(raw);
  } catch (e) { /* ignore */ }
  if (!Array.isArray(groups) || !groups.length) groups = presetGroups();
  renderGroupUI();
}

function saveGroups() {
  try { localStorage.setItem('openpour_groups', JSON.stringify(groups)); } catch (e) { /* full */ }
}

function renderGroupUI() {
  const sel = $('groupSel');
  sel.innerHTML = '';
  groups.forEach((g, k) => {
    const o = document.createElement('option');
    o.value = String(k);
    o.textContent = `${g.name} — ${g.cells.length} blocks${g.preset ? ' · preset' : ''}`;
    sel.appendChild(o);
  });
  activeGroupIdx = Math.min(activeGroupIdx, Math.max(0, groups.length - 1));
  sel.value = String(activeGroupIdx);
  const list = $('groupsList');
  list.innerHTML = '';
  groups.forEach((g, k) => {
    const row = document.createElement('div');
    row.className = 'grow';
    row.innerHTML = `<span>${g.name}</span><small>${g.cells.length} blk</small>`;
    const place = document.createElement('button');
    place.textContent = 'Place';
    place.addEventListener('click', () => {
      activeGroupIdx = k;
      $('groupSel').value = String(k);
      $('bigMenu').classList.remove('open');
      setTool('place');
    });
    const del = document.createElement('button');
    del.textContent = '✕';
    del.addEventListener('click', () => {
      groups.splice(k, 1);
      if (!groups.length) groups = presetGroups();
      saveGroups();
      renderGroupUI();
    });
    row.appendChild(place);
    row.appendChild(del);
    list.appendChild(row);
  });
}

// group footprint with placeRot quarter turns applied
function groupCellsRotated(g) {
  let cells = g.cells.map((c) => c.slice());
  for (let r = 0; r < placeRot; r++) {
    const W = Math.max(...cells.map((c) => c[0])) + 1;
    cells = cells.map(([x, y, z, cls]) => [z, y, W - 1 - x, cls]);
  }
  return cells;
}

function updateGroupGhost(baseX, baseY, baseZ) {
  const g = groups[activeGroupIdx];
  if (!g) { groupGhost.visible = false; return; }
  const cells = groupCellsRotated(g);
  let n = 0;
  let blocked = false;
  for (const [dx, dy, dz] of cells) {
    if (n >= 2048) break;
    const x = baseX + dx, y = baseY + dy, z = baseZ + dz;
    if (!inB(x, y, z)) { blocked = true; continue; }
    if (grid[idx(x, y, z)] !== EMPTY) blocked = true;
    _m.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
    groupGhost.setMatrixAt(n, _m);
    n++;
  }
  groupGhost.material.color.set(blocked ? 0xffaa44 : 0x44ff88);
  groupGhost.count = n;
  groupGhost.instanceMatrix.needsUpdate = true;
  groupGhost.visible = n > 0;
}

// core stamp: places cells AND registers a pour element
function stampCells(name, cells, baseX, baseY, baseZ) {
  const prevClass = S.formClassIdx;
  stroke = { cells: [] };
  let n = 0;
  const absCells = [];
  for (const [dx, dy, dz, cls] of cells) {
    const x = baseX + dx, y = baseY + dy, z = baseZ + dz;
    if (!inB(x, y, z)) continue;
    absCells.push([x, y, z, cls || 0]);
    const i = idx(x, y, z);
    if (grid[i] !== EMPTY) continue;
    S.formClassIdx = cls || 0;
    setCell(i, FORM);
    n++;
  }
  S.formClassIdx = prevClass;
  pushUndo();
  saveLocal();
  if (n) {
    const el = {
      id: nextElemId++,
      name: `${name} #${nextElemId - 1}`,
      base: [baseX, baseY, baseZ],
      cells: absCells,
      status: 'pending',
      result: null,
      analysis: null,
      validation: null,
    };
    elements.push(el);
    updateStartBtns();
  }
  return n;
}

function stampGroup(baseX, baseY, baseZ) {
  const g = groups[activeGroupIdx];
  if (!g) return;
  const n = stampCells(g.name, groupCellsRotated(g), baseX, baseY, baseZ);
  if (n) toast(`Placed ${g.name} — ${n} blocks · pour element registered`);
}

function selectRect(x0, z0, x1, z1) {
  selection.clear();
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [az, bz] = z0 < z1 ? [z0, z1] : [z1, z0];
  for (const i of formSet) {
    const [x, , z] = cellOf(i);
    if (x >= ax && x <= bx && z >= az && z <= bz) selection.add(i);
  }
  $('selCount').textContent = `${selection.size} selected`;
  formDirty = true;
}

function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  $('selCount').textContent = '0 selected';
  formDirty = true;
}

function deleteSelection() {
  if (!selection.size) { toast('Nothing selected'); return; }
  stroke = { cells: [] };
  for (const i of selection) {
    if (grid[i] === FORM) setCell(i, EMPTY);
  }
  pushUndo();
  saveLocal();
  toast(`Deleted ${selection.size} form blocks`);
  clearSelection();
}

function selectionCellsNormalized() {
  let mx = Infinity, my = Infinity, mz = Infinity;
  for (const i of selection) {
    const [x, y, z] = cellOf(i);
    if (x < mx) mx = x; if (y < my) my = y; if (z < mz) mz = z;
  }
  return {
    base: [mx, my, mz],
    rel: [...selection].map((i) => {
      const [x, y, z] = cellOf(i);
      return [x - mx, y - my, z - mz, formClass[i]];
    }),
    abs: [...selection].map((i) => {
      const [x, y, z] = cellOf(i);
      return [x, y, z, formClass[i]];
    }),
  };
}

function saveSelectionAsGroup() {
  if (!selection.size) { toast('Select some forms first (tool 5)'); return; }
  const name = prompt('Group name:', `Group ${groups.length + 1}`);
  if (!name) return;
  const { rel } = selectionCellsNormalized();
  groups.push({ name, cells: rel });
  saveGroups();
  renderGroupUI();
  toast(`Saved "${name}" — ${rel.length} blocks. Place it with tool 6.`);
}

function selectionToElement() {
  if (!selection.size) { toast('Select some forms first (tool 5)'); return; }
  const { base, abs } = selectionCellsNormalized();
  const el = {
    id: nextElemId++,
    name: `Element #${nextElemId - 1}`,
    base,
    cells: abs,
    status: 'pending',
    result: null,
    analysis: null,
    validation: null,
  };
  elements.push(el);
  updateStartBtns();
  toast(`${el.name} registered (${abs.length} form blocks) — Auto Pour will fill it`);
  clearSelection();
}

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(pointer, camera);
  const targets = [...formMeshes, ground];
  if (S.renderMode === 'blocks') targets.unshift(concMesh);
  else if (surf.mesh.visible) targets.unshift(surf.mesh);
  const hits = ray.intersectObjects(targets, false);
  for (const h of hits) {
    if (h.object === ground) {
      const x = Math.floor(h.point.x), z = Math.floor(h.point.z);
      return { ground: true, gx: h.point.x, gz: h.point.z, cell: inB(x, 0, z) ? [x, 0, z] : null, place: inB(x, 0, z) ? [x, 0, z] : null };
    }
    if (h.object === surf.mesh) {
      // map the surface hit back to the concrete cell behind it
      const n = h.face.normal;
      for (const off of [0.5, 1.5]) {
        const cx = Math.floor(h.point.x - n.x * off);
        const cy = Math.floor(h.point.y - n.y * off);
        const cz = Math.floor(h.point.z - n.z * off);
        if (inB(cx, cy, cz) && grid[idx(cx, cy, cz)] === CONC) {
          const px = Math.floor(h.point.x + n.x * 0.5);
          const py = Math.floor(h.point.y + n.y * 0.5);
          const pz = Math.floor(h.point.z + n.z * 0.5);
          return { ground: false, cell: [cx, cy, cz], place: inB(px, py, pz) ? [px, py, pz] : null };
        }
      }
      continue;
    }
    const mk = formMeshes.indexOf(h.object);
    const i = mk >= 0 ? formCellsArr[mk][h.instanceId] : concCells[h.instanceId];
    const [x, y, z] = cellOf(i);
    const n = h.face.normal;
    const px = x + Math.round(n.x), py = y + Math.round(n.y), pz = z + Math.round(n.z);
    return { ground: false, cell: [x, y, z], place: inB(px, py, pz) ? [px, py, pz] : null };
  }
  return null;
}

function applyTool(h, erase) {
  if (!h) return;
  if (erase || S.tool === 'erase') {
    if (h.cell && !h.ground) eraseCell(...h.cell);
    return;
  }
  if (S.tool === 'form') {
    if (h.place) placeFormColumn(...h.place);
  } else if (S.tool === 'pump') {
    if (h.ground) placePump(h.gx, h.gz);
    else toast('Click on open ground to park the pump');
  } else if (S.tool === 'pour') {
    if (h.cell) setPourPoint(h.cell[0], h.cell[2]);
  }
}

function hoverXZ(h) {
  if (!h) return null;
  if (h.cell) return [h.cell[0], h.cell[2]];
  if (h.ground) {
    const x = Math.max(0, Math.min(GX - 1, Math.floor(h.gx)));
    const z = Math.max(0, Math.min(GZ - 1, Math.floor(h.gz)));
    return [x, z];
  }
  return null;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const h = pick(ev);
  const erase = ev.altKey;
  if (S.tool === 'select' && !erase) {
    const xz = hoverXZ(h);
    if (xz) { selAnchor = xz; selecting = true; selectRect(xz[0], xz[1], xz[0], xz[1]); }
    return;
  }
  if (S.tool === 'place' && !erase) {
    if (h && h.place) stampGroup(h.place[0], h.ground ? 0 : h.place[1], h.place[2]);
    return;
  }
  if (S.tool === 'form' || S.tool === 'erase' || erase) {
    stroke = { cells: [] };
    painting = true;
  }
  applyTool(h, erase);
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  const h = pick(ev);
  hover = h;
  if (selecting && (ev.buttons & 1)) {
    const xz = hoverXZ(h);
    if (xz && selAnchor) {
      selectRect(selAnchor[0], selAnchor[1], xz[0], xz[1]);
      const ax = Math.min(selAnchor[0], xz[0]), bx = Math.max(selAnchor[0], xz[0]);
      const az = Math.min(selAnchor[1], xz[1]), bz = Math.max(selAnchor[1], xz[1]);
      selBox.scale.set(bx - ax + 1.1, 10, bz - az + 1.1);
      selBox.position.set((ax + bx + 1) / 2, 5, (az + bz + 1) / 2);
      selBox.visible = true;
    }
  }
  if (painting && (ev.buttons & 1)) applyTool(h, ev.altKey);
  updateGhost();
});

window.addEventListener('pointerup', () => {
  if (painting) { painting = false; pushUndo(); saveLocal(); }
  if (selecting) {
    selecting = false;
    selBox.visible = false;
    if (selection.size) toast(`${selection.size} form blocks selected — save as group, register as element, or delete`);
  }
});

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

function updateGhost() {
  if (!hover) { ghost.visible = false; groupGhost.visible = false; return; }
  if (S.tool === 'form' && hover.place) {
    const [x, y, z] = hover.place;
    const h = Math.min(S.wallH, GY - y);
    ghost.scale.set(1.02, h + 0.02, 1.02);
    ghost.position.set(x + 0.5, y + h / 2, z + 0.5);
    ghost.material.color.set(0x44ff88);
    ghost.visible = true;
  } else if (S.tool === 'erase' && hover.cell && !hover.ground) {
    const [x, y, z] = hover.cell;
    ghost.scale.set(1.06, 1.06, 1.06);
    ghost.position.set(x + 0.5, y + 0.5, z + 0.5);
    ghost.material.color.set(0xff4444);
    ghost.visible = true;
  } else if (S.tool === 'pour' && hover.cell) {
    const [x, , z] = hover.cell;
    ghost.scale.set(1.04, 0.3, 1.04);
    ghost.position.set(x + 0.5, 0.15, z + 0.5);
    ghost.material.color.set(0xffaa22);
    ghost.visible = true;
  } else if (S.tool === 'pump' && hover.ground) {
    ghost.scale.set(8, 0.3, 8);
    ghost.position.set(hover.gx, 0.15, hover.gz);
    ghost.material.color.set(0x2f7fd4);
    ghost.visible = true;
  } else {
    ghost.visible = false;
  }
  if (S.tool === 'place' && hover && hover.place) {
    updateGroupGhost(hover.place[0], hover.ground ? 0 : hover.place[1], hover.place[2]);
  } else {
    groupGhost.visible = false;
  }
}

// ---------- Keyboard ----------
const keys = {};
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  keys[e.code] = true;
  if (e.code === 'Space') { e.preventDefault(); pouring ? stopPour() : startPour(); }
  if (e.code === 'Digit1') setTool('form');
  if (e.code === 'Digit2') setTool('erase');
  if (e.code === 'Digit3') setTool('pump');
  if (e.code === 'Digit4') setTool('pour');
  if (e.code === 'Digit5') setTool('select');
  if (e.code === 'Digit6') setTool('place');
  if (e.code === 'KeyR' && S.tool === 'place') {
    placeRot = (placeRot + 1) % 4;
    if (hover && hover.place) updateGroupGhost(hover.place[0], hover.ground ? 0 : hover.place[1], hover.place[2]);
  }
  if (e.code === 'KeyH') toggleZen();
  if (e.code === 'Escape') {
    clearSelection();
    $('bigMenu').classList.remove('open');
    $('helpModal').classList.remove('open');
    $('reportModal').classList.remove('open');
    $('seqModal').classList.remove('open');
  }
  if (e.code === 'KeyM') {
    const sel = document.getElementById('renderMode');
    sel.value = S.renderMode === 'blocks' ? 'real' : 'blocks';
    sel.dispatchEvent(new Event('change'));
  }
  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

const _fwd = new THREE.Vector3(), _rgt = new THREE.Vector3();
function panKeys(dt) {
  let mx = 0, mz = 0, my = 0;
  if (keys['KeyW']) mz += 1;
  if (keys['KeyS']) mz -= 1;
  if (keys['KeyA']) mx -= 1;
  if (keys['KeyD']) mx += 1;
  if (keys['KeyE']) my += 1;
  if (keys['KeyQ']) my -= 1;
  if (!mx && !mz && !my) return;
  camera.getWorldDirection(_fwd);
  _fwd.y = 0; _fwd.normalize();
  _rgt.crossVectors(_fwd, new THREE.Vector3(0, 1, 0)).negate();
  const sp = 28 * dt;
  const d = new THREE.Vector3()
    .addScaledVector(_fwd, mz * sp)
    .addScaledVector(_rgt, -mx * sp);
  d.y = my * sp;
  camera.position.add(d);
  controls.target.add(d);
  controls.target.y = Math.max(0, Math.min(60, controls.target.y));
}

// ---------- World reinit (scenes) ----------
function reinitWorld(gx, gy, gz) {
  stopPour();
  cancelAutoPour();
  clearSelection();
  GX = gx; GY = gy; GZ = gz; N = GX * GY * GZ;
  grid = new Uint8Array(N);
  born = new Float32Array(N);
  hmap = new Uint8Array(GX * GZ);
  formClass = new Uint8Array(N);
  formSet.clear();
  active.clear();
  undoStack.length = 0;
  simTime = 0; simStarted = false; placedFt3 = 0; blowouts = 0; spawnAcc = 0; spawnFails = 0; pressAcc = 0; elemCheck = 0;
  spawnedFt3Total = 0; erasedFt3Total = 0; ft3OverDrop = 0;
  cMin = [GX, GY, GZ]; cMax = [-1, -1, -1];
  elements = []; nextElemId = 1; activeElem = null;
  pour = null; pumpPos = null; pourPt = null; boomTip = null;
  truck.visible = false; reachRing.visible = false; pourMarker.visible = false;
  if (boomMesh) { scene.remove(boomMesh); boomMesh.geometry.dispose(); boomMesh = null; }
  // mutate the shared ctx IN PLACE — pressure.js holds a reference to it
  Object.assign(ctx, { GX, GY, GZ, N, grid, born, hmap, formClass });
  initPressure(ctx);
  scene.remove(surf.mesh);
  surf.dispose();
  surf = createSurface(ctx);
  surf.mesh.visible = S.renderMode === 'real';
  scene.add(surf.mesh);
  createInstanced();
  applyMode();
  resizeStatics();
  controls.target.set(GX / 2, 2, GZ / 2);
  camera.position.set(GX / 2 - Math.max(40, GX * 0.7), Math.max(45, GY * 2.3), GZ / 2 + Math.max(55, GZ * 1.05));
  markConc();
  formDirty = true;
  capWarned = false;
  updateStartBtns();
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);

function setTool(t) {
  S.tool = t;
  for (const b of document.querySelectorAll('[data-tool]'))
    b.classList.toggle('active', b.dataset.tool === t);
  for (const c of document.querySelectorAll('.ctx'))
    c.style.display = c.dataset.ctx.split(' ').includes(t) ? 'flex' : 'none';
  if (t !== 'select') { selBox.visible = false; }
  if (t !== 'place') groupGhost.visible = false;
  updateGhost();
}
for (const b of document.querySelectorAll('[data-tool]'))
  b.addEventListener('click', () => setTool(b.dataset.tool));

$('wallH').addEventListener('input', (e) => {
  S.wallH = +e.target.value;
  $('wallHLbl').textContent = `${S.wallH} ft`;
});

$('formClass').addEventListener('change', (e) => { S.formClassIdx = +e.target.value; });

// pump select built from the fleet roster
{
  const sel = $('pumpSel');
  const groupsEl = { false: document.createElement('optgroup'), true: document.createElement('optgroup') };
  groupsEl[false].label = 'Line / truck pumps';
  groupsEl[true].label = 'Boom pumps';
  for (const p of PUMPS) {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = `${p.name} — ${p.maxCYhr} CY/hr, ${isFinite(p.reach) ? p.reach + ' ft reach' : 'hose anywhere'}`;
    groupsEl[p.boom].appendChild(o);
  }
  sel.appendChild(groupsEl[false]);
  sel.appendChild(groupsEl[true]);
  sel.value = S.pump;
}

$('pumpSel').addEventListener('change', (e) => {
  S.pump = e.target.value;
  if (pumpPos) placePump(pumpPos.x, pumpPos.z); // refresh ring/boom
  pumpHydraulics();
  updateStats();
});

$('throttle').addEventListener('input', (e) => {
  S.throttle = +e.target.value / 100;
  pumpHydraulics();
  updateThrottleLbl();
  updateStats();
});
function updateThrottleLbl() {
  $('throttleLbl').textContent = `${Math.round(S.throttle * 100)}% — ${Math.round(pumpByKey(S.pump).maxCYhr * S.throttle)} CY/hr`;
}

$('tipMode').addEventListener('change', (e) => {
  S.tipMode = e.target.value;
  $('tipYWrap').style.display = S.tipMode === 'manual' ? 'flex' : 'none';
  updateBoom();
});
$('tipY').addEventListener('input', (e) => {
  S.tipY = +e.target.value;
  $('tipYLbl').textContent = `${S.tipY} ft`;
  updateBoom();
});

function slumpDesc(s) {
  if (s <= 3) return 'stiff — pavement / footings';
  if (s <= 5) return 'standard structural';
  if (s <= 7) return 'wet — walls & columns';
  return 'flowable / SCC';
}
function setSlump(v, fromMix) {
  S.slump = v;
  $('slump').value = v;
  $('slumpLbl').textContent = `${v}" — ${slumpDesc(v)}`;
  if (!fromMix && S.mix) markMixEdited();
}
function setPsi(v, fromMix) {
  S.psi = v;
  $('psiInp').value = v;
  if (!fromMix && S.mix) markMixEdited();
}
$('slump').addEventListener('input', (e) => setSlump(+e.target.value));
$('psiInp').addEventListener('change', (e) => setPsi(Math.max(1000, +e.target.value || 4000)));
$('unitWt').addEventListener('change', (e) => {
  S.unitWt = Math.min(160, Math.max(100, +e.target.value || 150));
  e.target.value = S.unitWt;
});
$('setTime').addEventListener('input', (e) => {
  S.setMin = +e.target.value;
  $('setTimeLbl').textContent = `${S.setMin} min`;
});
$('speedSel').addEventListener('change', (e) => { S.speed = +e.target.value; });
$('chkBlow').addEventListener('change', (e) => { S.blowoutsOn = e.target.checked; });
$('btnStart').addEventListener('click', () => (pouring ? stopPour() : startPour()));
$('btnAutoPour').addEventListener('click', startAutoPour);
$('btnDelPump').addEventListener('click', removePump);

// new pour: keep forms, pump and elements — fresh concrete + clock
$('btnNewPour').addEventListener('click', () => {
  clearConcrete(false);
  toast('New pour ready — forms & pump kept, clock at 0:00. Hit Start or Auto Pour.');
});

// quick-save the current setup as a named scene
$('btnQuickSave').addEventListener('click', () => {
  const name = prompt('Save pour setup as:', sceneName === 'Standard' ? 'My pour' : sceneName);
  if (!name) return;
  sceneName = name;
  const s = loadSavedScenes();
  s[name] = layoutJSON();
  try { localStorage.setItem('openpour_scenes', JSON.stringify(s)); } catch (e) { toast('Storage full'); return; }
  renderScenesUI();
  saveLocal();
  toast(`"${name}" saved — reload it anytime from ☰ Menu → Scene`);
});

function updateStartBtns() {
  const pend = elements.filter((e) => e.status !== 'done').length;
  const b = $('btnAutoPour');
  if (autoPour) {
    b.textContent = '⏹ Cancel Auto';
    b.classList.add('pouring');
  } else {
    b.textContent = `⚙ Auto Pour${pend ? ` (${pend})` : ''}`;
    b.classList.remove('pouring');
  }
}

$('renderMode').addEventListener('change', (e) => { S.renderMode = e.target.value; applyMode(); });
$('chkGrid').addEventListener('change', (e) => {
  S.showGrid = e.target.checked;
  if (gridHelper) gridHelper.visible = S.showGrid;
});

function applyMode() {
  const real = S.renderMode === 'real';
  concMesh.visible = !real;
  surf.mesh.visible = real;
  formMeshes.forEach((m, k) => { m.material = real ? MATS.formCls[k].sm : MATS.formCls[k].mc; });
  if (real) surfDirty = true;
}

// zen mode — hide chrome
function toggleZen() {
  document.body.classList.toggle('zen');
}
$('btnZen').addEventListener('click', toggleZen);
$('zenPill').addEventListener('click', toggleZen);

$('btnUndo').addEventListener('click', undo);

$('btnClearConc').addEventListener('click', () => clearConcrete(true));

function clearConcrete(announce) {
  stopPour();
  cancelAutoPour();
  let removed = 0;
  for (let i = 0; i < N; i++) if (grid[i] === CONC) { grid[i] = EMPTY; removed++; }
  erasedFt3Total += removed;
  hmap.fill(0);
  active.clear();
  spawnAcc = 0;
  placedFt3 = 0;
  simTime = 0;
  simStarted = false;
  pressAcc = 0;
  elemCheck = 0;
  pour = null;
  for (const el of elements) { el.status = 'pending'; el.result = null; el.validation = null; }
  markConc();
  updateStartBtns();
  if (announce) toast('Concrete cleared — elements reset, sim clock back to 0:00');
}

function removePump() {
  stopPour();
  cancelAutoPour();
  pumpPos = null;
  pourPt = null;
  truck.visible = false;
  reachRing.visible = false;
  pourMarker.visible = false;
  if (boomMesh) { scene.remove(boomMesh); boomMesh.geometry.dispose(); boomMesh = null; }
  toast('Pump removed — park a new one with tool 3');
}

function clearAll() {
  stopPour();
  cancelAutoPour();
  grid.fill(EMPTY);
  hmap.fill(0);
  formClass.fill(0);
  formSet.clear();
  clearPressure();
  active.clear();
  spawnAcc = 0;
  placedFt3 = 0;
  simTime = 0;
  simStarted = false;
  pressAcc = 0;
  elemCheck = 0;
  pour = null;
  blowouts = 0;
  spawnedFt3Total = 0; erasedFt3Total = 0; ft3OverDrop = 0;
  cMin = [GX, GY, GZ]; cMax = [-1, -1, -1];
  elements = []; nextElemId = 1; activeElem = null;
  undoStack.length = 0;
  markConc();
  formDirty = true;
  updateStartBtns();
}

$('btnClearAll').addEventListener('click', () => {
  if (!confirm('Clear all forms AND concrete?')) return;
  clearAll();
  saveLocal();
});

// ---------- Layout save / load (v3) ----------
function layoutJSON() {
  const forms = [];
  for (const i of formSet) {
    const [x, y, z] = cellOf(i);
    forms.push([x, y, z, formClass[i]]);
  }
  return {
    app: 'openpour',
    version: 3,
    scene: { name: sceneName, dims: [GX, GY, GZ] },
    pump: pumpPos ? { key: S.pump, pos: [pumpPos.x, pumpPos.z] } : null,
    pourPt: pourPt ? [pourPt.x, pourPt.z] : null,
    forms,
    elements: elements.map((e) => ({ id: e.id, name: e.name, base: e.base, cells: e.cells })),
  };
}

function loadLayout(data) {
  if (!data || !Array.isArray(data.forms)) throw new Error('bad layout');
  const dims = (data.version >= 3 && data.scene && data.scene.dims) ? data.scene.dims : (data.grid || [64, 24, 64]);
  if (dims[0] !== GX || dims[1] !== GY || dims[2] !== GZ) reinitWorld(dims[0], dims[1], dims[2]);
  else clearAll();
  if (data.scene && data.scene.name) sceneName = data.scene.name;
  let n = 0;
  for (const f of data.forms) {
    const [x, y, z, cls] = f;
    if (inB(x, y, z)) {
      const i = idx(x, y, z);
      grid[i] = FORM;
      formClass[i] = Math.min(FORM_CLASSES.length - 1, cls || 0);
      formSet.add(i);
      expandBBox(x, y, z);
      n++;
    }
  }
  if (Array.isArray(data.elements)) {
    for (const e of data.elements) {
      if (!e || !Array.isArray(e.cells)) continue;
      elements.push({
        id: e.id || nextElemId, name: e.name || `Element #${e.id || nextElemId}`,
        base: e.base || [0, 0, 0], cells: e.cells,
        status: 'pending', result: null, analysis: null, validation: null,
      });
      nextElemId = Math.max(nextElemId, (e.id || 0) + 1);
    }
  }
  if (data.pump && data.pump.pos) {
    S.pump = data.pump.key || S.pump;
    const sel = $('pumpSel');
    if (sel) { sel.value = S.pump; sel.dispatchEvent(new Event('change')); }
    placePump(data.pump.pos[0], data.pump.pos[1]);
  }
  if (data.pourPt && pumpPos) {
    pourPt = { x: data.pourPt[0], z: data.pourPt[1] };
    pourMarker.position.set(pourPt.x + 0.5, 0.1, pourPt.z + 0.5);
    pourMarker.visible = true;
    updateBoom();
  }
  markConc();
  formDirty = true;
  updateStartBtns();
  return n;
}

function saveLocal() {
  try { localStorage.setItem('openpour_layout', JSON.stringify(layoutJSON())); } catch (e) { /* full */ }
}

$('btnExport').addEventListener('click', () => {
  downloadJSON(layoutJSON(), 'openpour-layout.json');
});

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadText(text, filename, type = 'text/csv') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('fileImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const n = loadLayout(data);
    saveLocal();
    toast(`Loaded ${n} form blocks${data.name ? ` — ${data.name}` : ''}`);
  } catch (err) {
    toast('Could not read layout JSON');
  }
  e.target.value = '';
});

// ---------- Scenes ----------
const SCENE_PRESETS = [
  { name: 'Small pad', dims: [32, 16, 32] },
  { name: 'Standard', dims: [64, 24, 64] },
  { name: 'Large site', dims: [96, 24, 96] },
];

function applyScenePreset() {
  const k = +$('sceneSel').value;
  let dims, name;
  if (k >= 0 && SCENE_PRESETS[k]) {
    dims = SCENE_PRESETS[k].dims;
    name = SCENE_PRESETS[k].name;
  } else {
    dims = [
      Math.max(16, Math.min(128, +$('dimX').value || 64)),
      Math.max(12, Math.min(32, +$('dimY').value || 24)),
      Math.max(16, Math.min(128, +$('dimZ').value || 64)),
    ];
    name = `Custom ${dims[0]}×${dims[1]}×${dims[2]}`;
  }
  if (!confirm(`Start a new ${name} scene (${dims.join('×')} ft)? Current work is cleared.`)) return;
  sceneName = name;
  reinitWorld(dims[0], dims[1], dims[2]);
  saveLocal();
  toast(`New scene: ${name}`);
  $('bigMenu').classList.remove('open');
}

function loadSavedScenes() {
  try { return JSON.parse(localStorage.getItem('openpour_scenes')) || {}; } catch (e) { return {}; }
}

function renderScenesUI() {
  const list = $('scenesList');
  const scenes = loadSavedScenes();
  list.innerHTML = '';
  for (const [name, data] of Object.entries(scenes)) {
    const row = document.createElement('div');
    row.className = 'grow';
    row.innerHTML = `<span>${name}</span><small>${(data.scene && data.scene.dims || []).join('×')}</small>`;
    const load = document.createElement('button');
    load.textContent = 'Load';
    load.addEventListener('click', () => {
      try {
        loadLayout(data);
        saveLocal();
        toast(`Scene "${name}" loaded`);
        $('bigMenu').classList.remove('open');
      } catch (e) { toast('Scene data is corrupt'); }
    });
    const del = document.createElement('button');
    del.textContent = '✕';
    del.addEventListener('click', () => {
      const s = loadSavedScenes();
      delete s[name];
      localStorage.setItem('openpour_scenes', JSON.stringify(s));
      renderScenesUI();
    });
    row.appendChild(load);
    row.appendChild(del);
    list.appendChild(row);
  }
  if (!list.children.length) list.innerHTML = '<div class="hint">No saved scenes yet.</div>';
}

$('btnSceneApply').addEventListener('click', applyScenePreset);
$('btnSceneSave').addEventListener('click', () => {
  const name = ($('sceneName').value || '').trim() || prompt('Scene name:', sceneName);
  if (!name) return;
  sceneName = name;
  const s = loadSavedScenes();
  s[name] = layoutJSON();
  try { localStorage.setItem('openpour_scenes', JSON.stringify(s)); } catch (e) { toast('Storage full'); return; }
  renderScenesUI();
  toast(`Scene "${name}" saved`);
});
$('btnTestScene').addEventListener('click', () => { loadTestScene(); $('bigMenu').classList.remove('open'); });

function loadTestScene() {
  sceneName = 'Test Scene';
  reinitWorld(64, 24, 64);
  S.pump = 's32x';
  const sel = $('pumpSel');
  sel.value = 's32x';
  sel.dispatchEvent(new Event('change'));
  placePump(10, 32);
  S.setMin = 240; $('setTime').value = 240; $('setTimeLbl').textContent = '240 min';
  S.speed = 10; $('speedSel').value = '10'; $('speedSel').dispatchEvent(new Event('change'));
  S.tipMode = 'auto'; $('tipMode').value = 'auto'; $('tipMode').dispatchEvent(new Event('change'));
  stampCells('Spread footing 6×6×2', rectOutline(6, 6, 2, 0), 22, 0, 12);
  stampCells('Spread footing 6×6×2', rectOutline(6, 6, 2, 0), 22, 0, 46);
  stampCells('Pile cap 10×10×3', rectOutline(10, 10, 3, 1), 42, 0, 27);
  saveLocal();
  updateStartBtns();
  toast('Test Scene loaded — 3 footings + pump ready. Hit ⚙ Auto Pour.');
}

// ---------- Sequence review ----------
function tone(v, warn, bad) {
  return v < warn ? '#4cc06c' : v < bad ? '#e0b84f' : '#e0604f';
}

function countCONC() {
  let n = 0;
  for (let i = 0; i < N; i++) if (grid[i] === CONC) n++;
  return n;
}

function seqRows() {
  return elements.filter((e) => e.validation).map((e) => {
    const v = e.validation, r = e.result || {};
    return {
      name: e.name,
      expYd: v.expectedFt3 / 27,
      actYd: v.actualFt3 / 27,
      errPct: v.volErrPct,
      fillPct: (r.fillPct || 0) * 100,
      top: `${v.achievedTop.toFixed(1)} / ${v.targetTop} ft`,
      psf: `${Math.round(v.peakPsf)} / ${Math.round(v.expectedPsf)}`,
      psfErr: v.psfErrPct,
      dropPct: v.overDropPct,
      durMin: v.durSec / 60,
      avgCYhr: v.avgCYhr,
      blow: r.blowouts || 0,
      status: r.reason || e.status,
    };
  });
}

function showSeqReview() {
  const rows = seqRows();
  if (!rows.length) { toast('No completed pour elements yet — run Auto Pour'); return; }
  const conc = countCONC();
  const massOk = spawnedFt3Total === conc + erasedFt3Total;
  const totalAct = rows.reduce((s, r) => s + r.actYd, 0);
  const totalExp = rows.reduce((s, r) => s + r.expYd, 0);
  const summary = [
    ['Elements poured', `${rows.length} (${elements.filter((e) => e.status === 'skipped').length} skipped)`],
    ['Volume', `${totalAct.toFixed(1)} yd³ in elements / ${totalExp.toFixed(1)} yd³ expected · ${(spawnedFt3Total / 27).toFixed(1)} yd³ pumped total`],
    ['Mass balance', massOk
      ? `<span style="color:#4cc06c">✓ exact — ${spawnedFt3Total} ft³ pumped = ${conc} in place + ${erasedFt3Total} removed</span>`
      : `<span style="color:#e0604f">✗ MISMATCH — pumped ${spawnedFt3Total}, in place ${conc}, removed ${erasedFt3Total}</span>`],
    ['Blowouts', String(rows.reduce((s, r) => s + r.blow, 0))],
    ['Segregation', `${(ft3OverDrop / Math.max(1, spawnedFt3Total) * 100).toFixed(1)}% of volume placed with >5 ft free fall`],
  ];
  const head = '<tr><th>Element</th><th>Exp yd³</th><th>Act yd³</th><th>Err</th><th>Fill</th><th>Top</th><th>psf pk/calc</th><th>>5ft drop</th><th>Avg CY/hr</th><th>Status</th></tr>';
  const body = rows.map((r) => `<tr>
    <td>${r.name}</td>
    <td>${r.expYd.toFixed(1)}</td>
    <td>${r.actYd.toFixed(1)}</td>
    <td style="color:${tone(Math.abs(r.errPct), 5, 12)}">${r.errPct >= 0 ? '+' : ''}${r.errPct.toFixed(1)}%</td>
    <td style="color:${tone(100 - r.fillPct, 5.1, 20)}">${r.fillPct.toFixed(0)}%</td>
    <td>${r.top}</td>
    <td style="color:${tone(Math.abs(r.psfErr), 20, 50)}">${r.psf}</td>
    <td style="color:${tone(r.dropPct, 5, 25)}">${r.dropPct.toFixed(0)}%</td>
    <td>${r.avgCYhr.toFixed(0)}</td>
    <td>${r.status}${r.blow ? ` · 💥${r.blow}` : ''}</td>
  </tr>`).join('');
  $('seqBody').innerHTML =
    summary.map(([k, v]) => `<div class="rrow"><span>${k}</span><b>${v}</b></div>`).join('') +
    `<table class="seqTable">${head}${body}</table>` +
    `<div class="hint">Backcheck: Exp = interior area × form height. psf calc = unit weight × (height − ½ ft). Err under ±5% and psf within ±20% indicate a physically consistent pour.</div>`;
  $('seqModal').classList.add('open');
}

$('btnSeqCsv').addEventListener('click', () => {
  const rows = seqRows();
  const csv = [
    'Element,Expected yd3,Actual yd3,Error %,Fill %,Top achieved ft,Top target ft,Peak psf,Calc psf,Over 5ft drop %,Duration min,Avg CY/hr,Blowouts,Status',
    ...rows.map((r) => [
      `"${r.name}"`, r.expYd.toFixed(2), r.actYd.toFixed(2), r.errPct.toFixed(2),
      r.fillPct.toFixed(1), r.top.split(' / ')[0], r.top.split(' / ')[1].replace(' ft', ''),
      r.psf.split(' / ')[0], r.psf.split(' / ')[1], r.dropPct.toFixed(1),
      r.durMin.toFixed(1), r.avgCYhr.toFixed(1), r.blow, r.status,
    ].join(',')),
    '',
    `Mass balance,pumped ${spawnedFt3Total} ft3,in place ${countCONC()} ft3,removed ${erasedFt3Total} ft3,${spawnedFt3Total === countCONC() + erasedFt3Total ? 'EXACT' : 'MISMATCH'}`,
  ].join('\n');
  downloadText(csv, 'openpour-pour-review.csv');
});
$('btnSeqReview').addEventListener('click', showSeqReview);
$('seqClose').addEventListener('click', () => $('seqModal').classList.remove('open'));

// ---------- Mix data ----------
let mixList = [];

const mixSelects = () => [$('mixSel'), $('mixSelTop')];

function populateMixSel() {
  for (const sel of mixSelects()) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">Manual — set sliders yourself</option>';
    for (let k = 0; k < mixList.length; k++) {
      const m = mixList[k];
      const o = document.createElement('option');
      o.value = String(k);
      o.textContent = `${m.code} — ${m.use || m.area || 'mix'}${m.fc ? ` (${m.fc} psi)` : ''}`;
      sel.appendChild(o);
    }
    sel.value = prev && +prev < mixList.length ? prev : '';
  }
}

function markMixEdited() {
  for (const sel of mixSelects()) {
    const o = sel.selectedOptions[0];
    if (o && o.value !== '' && !o.textContent.endsWith('(edited)')) o.textContent += ' (edited)';
  }
}

function selectMix(k) {
  if (k === '' || k === null || isNaN(+k)) {
    S.mix = null;
    $('mixCard').style.display = 'none';
    $('mixChart').style.display = 'none';
    return;
  }
  const m = mixList[+k];
  S.mix = m;
  if (m.fc) setPsi(m.fc, true);
  const sl = m.slumpTarget || m.slumpAvg;
  if (sl) setSlump(Math.round(sl * 2) / 2, true);
  S.aggIn = m.aggIn;
  const card = $('mixCard');
  card.style.display = 'block';
  const f28 = Math.round(evalCurve(m.fit, 28));
  const meets = m.fc ? f28 >= m.fc : null;
  card.innerHTML = [
    `<b>${m.code}</b> — ${m.use || ''}`,
    `f'c ${m.fc || 'n/a'} psi @ ${m.age}d · agg ${m.agg || '?'} · ${m.area || ''}`,
    m.wcRatio ? `w/c ${m.wcRatio}${m.supplier ? ' · ' + m.supplier : ''}` : (m.supplier || ''),
    `${m.breakSets} break set${m.breakSets === 1 ? '' : 's'} · fit f(28) = ${f28} psi ` +
      (meets === null ? '' : meets ? '<span style="color:#4cc06c">✓ meets design</span>' : '<span style="color:#e0604f">✗ below design</span>'),
  ].filter(Boolean).join('<br>');
  const chart = $('mixChart');
  chart.style.display = 'block';
  drawMixChart(chart, m, m.fc);
}

// menu + topbar mix selects stay in lockstep; the echo dispatch terminates
// because the second pass finds both values already equal
function onMixChange(v) {
  selectMix(v);
  for (const sel of mixSelects()) {
    if (sel.value !== v) {
      sel.value = v;
      sel.dispatchEvent(new Event('change'));
    }
  }
}
$('mixSel').addEventListener('change', (e) => onMixChange(e.target.value));
$('mixSelTop').addEventListener('change', (e) => onMixChange(e.target.value));

async function syncMixes(announce) {
  try {
    const { mixes, entryCount } = await fetchMixData();
    mixList = mixes;
    populateMixSel();
    if (announce) toast(`Break Lab: ${mixes.length} mixes, ${entryCount} break records`);
  } catch (err) {
    if (announce) toast("Couldn't reach Break Lab — use Import mixes JSON");
  }
}

$('btnMixSync').addEventListener('click', () => syncMixes(true));

$('fileMixImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const { mixes, entryCount } = normalizeImport(JSON.parse(await f.text()));
    mixList = mixes;
    populateMixSel();
    toast(`Imported ${mixes.length} mixes, ${entryCount} break records`);
  } catch (err) {
    toast('Could not read mix JSON');
  }
  e.target.value = '';
});

// ---------- Group builder + export/import ----------
$('btnBuildGroup').addEventListener('click', () => {
  const w = Math.max(2, Math.min(40, +$('bW').value || 6));
  const d = Math.max(2, Math.min(40, +$('bD').value || 6));
  const h = Math.max(1, Math.min(20, +$('bH').value || 2));
  const cls = +$('bClass').value || 0;
  const name = ($('bName').value || '').trim() || `Footing ${w}×${d}×${h}`;
  groups.push({ name, cells: rectOutline(w, d, h, cls) });
  saveGroups();
  renderGroupUI();
  activeGroupIdx = groups.length - 1;
  $('groupSel').value = String(activeGroupIdx);
  $('bigMenu').classList.remove('open');
  setTool('place');
  toast(`"${name}" created — click the map to place it (R rotates)`);
});

$('btnGroupsExport').addEventListener('click', () => {
  downloadJSON({ app: 'openpour-groups', version: 1, groups: groups.filter((g) => !g.preset) }, 'openpour-groups.json');
});

$('fileGroupsImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = Array.isArray(data.groups) ? data.groups : [];
    let added = 0;
    for (const g of incoming) {
      if (!g || !g.name || !Array.isArray(g.cells)) continue;
      if (groups.some((x) => x.name === g.name)) continue;
      groups.push({ name: g.name, cells: g.cells });
      added++;
    }
    saveGroups();
    renderGroupUI();
    toast(`Imported ${added} group${added === 1 ? '' : 's'}`);
  } catch (err) {
    toast('Could not read groups JSON');
  }
  e.target.value = '';
});

// ---------- Plan overlay ----------
$('fileOverlay').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    if (overlayMat.map) overlayMat.map.dispose();
    overlayMat.map = t;
    overlayMat.needsUpdate = true;
    overlay.visible = true;
    URL.revokeObjectURL(url);
    toast('Plan overlay loaded — trace your forms on it');
  });
  e.target.value = '';
});
$('ovOpacity').addEventListener('input', (e) => { overlayMat.opacity = +e.target.value; });
$('ovScale').addEventListener('input', (e) => {
  const s = +e.target.value;
  overlay.scale.set(s, s, 1);
});
$('btnOvRot').addEventListener('click', () => { overlay.rotation.z += Math.PI / 2; });
$('btnOvClear').addEventListener('click', () => { overlay.visible = false; });

$('btnHelp').addEventListener('click', () => $('helpModal').classList.toggle('open'));
$('helpClose').addEventListener('click', () => $('helpModal').classList.remove('open'));
$('btnReport').addEventListener('click', showReport);
$('reportClose').addEventListener('click', () => $('reportModal').classList.remove('open'));

// full menu overlay
$('btnMenu').addEventListener('click', () => { $('bigMenu').classList.toggle('open'); renderScenesUI(); });
$('menuClose').addEventListener('click', () => $('bigMenu').classList.remove('open'));
$('bigMenu').addEventListener('click', (e) => {
  if (e.target === $('bigMenu')) $('bigMenu').classList.remove('open');
});

// selection / groups
$('btnSaveGroup').addEventListener('click', saveSelectionAsGroup);
$('btnSelToElem').addEventListener('click', selectionToElement);
$('btnDelSel').addEventListener('click', deleteSelection);
$('btnClearSel').addEventListener('click', clearSelection);
$('groupSel').addEventListener('change', (e) => { activeGroupIdx = +e.target.value; placeRot = 0; });
$('btnRotGroup').addEventListener('click', () => {
  placeRot = (placeRot + 1) % 4;
  if (hover && hover.place) updateGroupGhost(hover.place[0], hover.ground ? 0 : hover.place[1], hover.place[2]);
});

// ---------- Report card (manual pours) ----------
function fmtDay(d) {
  if (d === null) return 'beyond curve';
  return d < 1 ? `${Math.round(d * 24)} hr` : `day ${Math.ceil(d)}`;
}

function showReport() {
  const fit = S.mix ? S.mix.fit : fallbackCurve(null, null, S.psi);
  const fc = S.mix && S.mix.fc ? S.mix.fc : S.psi;
  const vol = placedFt3 / 27;
  const p = pour || { startSim: 0, startVol: 0, peakUtil: press.peakUtil, peakPsf: press.peakPsf, blowouts0: 0 };
  const pVol = (placedFt3 - p.startVol) / 27;
  const durHr = (simTime - p.startSim) / 3600;
  const foot = footprintCols();
  const rise = foot > 0 && durHr > 0 ? (placedFt3 - p.startVol) / foot / durHr : 0;
  const pump = pumpByKey(S.pump);
  const util = p.peakUtil || press.peakUtil;
  const strip75 = solveAge(fit, 0.75 * fc);
  const full = solveAge(fit, fc);
  const rows = [
    ['Pour volume', `${pVol.toFixed(1)} yd³ this pour · ${vol.toFixed(1)} yd³ total · ${Math.ceil(vol / 10)} trucks`],
    ['Pump', `${pump.name} @ ${Math.round(pumpState.effCYhr || pump.maxCYhr * S.throttle)} CY/hr${pumpState.derated ? ' (derated)' : ''} · peak line ~${Math.round(pumpState.reqPsi)} / ${pump.maxPsi} psi`],
    ['Pour duration', durHr > 0 ? `${(durHr * 60).toFixed(0)} min sim · avg rise ${rise.toFixed(1)} ft/hr` : '—'],
    ['Form pressure', `peak ${Math.round(util * 100)}% of rating (${Math.round(p.peakPsf || press.peakPsf)} psf) · ${blowouts - (p.blowouts0 || 0)} blowout${blowouts - (p.blowouts0 || 0) === 1 ? '' : 's'} this pour`],
    ['Free fall', `${(ft3OverDrop / Math.max(1, spawnedFt3Total) * 100).toFixed(1)}% of all volume placed with >5 ft drop`],
    ['Formwork', `${press.contactSF} SF in contact · ${grossSF} SF gross panels`],
    ['Mix', S.mix ? `${S.mix.code} (${S.mix.fit.src === 'breaks' ? 'project break data' : 'ACI 209 default'})` : `manual ${S.psi} psi (ACI 209 default curve)`],
    ['Strength timeline', `f(1d) ${Math.round(evalCurve(fit, 1))} · f(3d) ${Math.round(evalCurve(fit, 3))} · f(7d) ${Math.round(evalCurve(fit, 7))} · f(28d) ${Math.round(evalCurve(fit, 28))} psi`],
    ['Milestones', `strip at 75% f'c → ${fmtDay(strip75)} · full design strength → ${fmtDay(full)}`],
  ];
  $('reportBody').innerHTML = rows
    .map(([k, v]) => `<div class="rrow"><span>${k}</span><b>${v}</b></div>`)
    .join('');
  $('reportModal').classList.add('open');
}

function footprintCols() {
  let n = 0;
  for (let c = 0; c < GX * GZ; c++) if (hmap[c] > 0) n++;
  return n;
}

// ---------- Toast / stats ----------
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function updateStats() {
  const yd3 = placedFt3 / 27;
  $('stVol').textContent = `${yd3.toFixed(1)} yd³`;
  $('stTrucks').textContent = `${Math.ceil(yd3 / 10)}`;
  const m = Math.floor(simTime / 60), s = Math.floor(simTime % 60);
  $('stTime').textContent = `${m}:${String(s).padStart(2, '0')}`;
  const pump = pumpByKey(S.pump);
  pumpHydraulics();
  $('stPump').textContent = `${pump.name} @ ${Math.round(pumpState.effCYhr)} CY/hr${pumpState.derated ? ' ⚠' : ''}`;
  $('stSF').textContent = `${press.contactSF} / ${grossSF} SF`;
  const u = press.worstUtil;
  const el = $('stPress');
  el.textContent = `${Math.round(u * 100)}%`;
  el.style.color = u < 0.6 ? '#4cc06c' : u < 0.9 ? '#e0b84f' : '#e0604f';
  // pump pressure gauge
  const pu = Math.min(1.25, pumpState.reqPsi / pumpState.maxPsi);
  $('gPsiBar').style.width = `${Math.min(100, pu * 100)}%`;
  $('gPsiBar').style.background = pu < 0.7 ? '#4cc06c' : pu < 1 ? '#e0b84f' : '#e0604f';
  $('gPsiLbl').textContent = pumpState.derated
    ? `~${Math.round(pumpState.reqPsi)} / ${pump.maxPsi} psi — derated to ${Math.round(pumpState.effCYhr)} CY/hr`
    : `~${Math.round(pumpState.reqPsi)} / ${pump.maxPsi} psi line pressure`;
  // free-fall readout
  const ff = $('freeFall');
  if (pourPt) {
    const drop = Math.max(0, tipYFor(pourPt) - hmap[pourPt.x + pourPt.z * GX]);
    ff.textContent = `Free fall ${drop.toFixed(0)} ft`;
    ff.style.color = drop <= 5 ? '#4cc06c' : drop <= 10 ? '#e0b84f' : '#e0604f';
  } else {
    ff.textContent = '';
  }
  // ACI-style advisory
  const adv = advisory(S, S.setMin, minRatingPsf);
  const foot = footprintCols();
  const riseNow = foot > 0 && pouring ? pumpState.effCYhr * 27 / foot : 0;
  const advEl = $('pressAdv');
  const over = riseNow > adv.rMax && pouring;
  advEl.innerHTML =
    `Weakest form ${minRatingPsf} psf → max head <b>${adv.hMax.toFixed(1)} ft</b> · max rise <b>${adv.rMax.toFixed(1)} ft/hr</b>` +
    (pouring && foot > 0 ? ` · current <b>${riseNow.toFixed(1)} ft/hr</b> ${over ? '⚠' : '✓'}` : '');
  advEl.style.color = over ? '#e0604f' : '';
  updateThrottleLbl();
  // boom visual rides the surface during manual pours
  if (pouring && pourPt && !autoPour) updateBoom();
}

// ---------- Boot ----------
resizeStatics();
(function restore() {
  try {
    const raw = localStorage.getItem('openpour_layout');
    if (raw) {
      const n = loadLayout(JSON.parse(raw));
      if (n) toast(`Restored ${n} form blocks from last session`);
    }
  } catch (e) { /* ignore */ }
})();

setTool('form');
applyMode();
loadGroups();
renderScenesUI();
updateStartBtns();
for (const id of ['pumpSel', 'formClass', 'mixSel', 'mixSelTop', 'groupSel', 'renderMode', 'speedSel', 'sceneSel', 'tipMode', 'bClass'])
  enhanceSelect($(id));
$('wallHLbl').textContent = `${S.wallH} ft`;
setSlump(S.slump, true);
setPsi(S.psi, true);
$('setTimeLbl').textContent = `${S.setMin} min`;
$('tipYLbl').textContent = `${S.tipY} ft`;
pumpHydraulics();
updateThrottleLbl();
updateStats();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Headless smoke tests ----------
let selftesting = false;

function boxForm(x0, x1, z0, z1, height, classIdx) {
  const prevClass = S.formClassIdx;
  S.formClassIdx = classIdx;
  for (let h = 0; h < height; h++) {
    for (let x = x0; x <= x1; x++) { setCell(idx(x, h, z0), FORM); setCell(idx(x, h, z1), FORM); }
    for (let z = z0 + 1; z < z1; z++) { setCell(idx(x0, h, z), FORM); setCell(idx(x1, h, z), FORM); }
  }
  S.formClassIdx = prevClass;
  formDirty = true;
}

function runSelfTests() {
  selftesting = true;
  reinitWorld(64, 24, 64);
  rand = mulberry32(42);
  const out = [];
  try {
    // --- 1. basic pour (legacy test) ---
    boxForm(20, 30, 20, 30, 3, 2);
    S.setMin = 90; S.slump = 5; S.speed = 20; S.throttle = 1; S.pump = 's32x'; S.aggIn = 1;
    S.tipMode = 'manual'; S.tipY = 23;          // legacy behavior: high fixed tip
    placePump(8, 8);
    setPourPoint(25, 25);
    startPour();
    for (let t = 0; t < 600; t++) tick(0.1 * 20);
    stopPour();
    const conc = countCONC();
    rebuildConc(); rebuildForms();
    const formsDrawn = formMeshes.reduce((s, m) => s + m.count, 0);
    out.push(`conc=${conc}`, `placed=${placedFt3}`, `drawn=${concMesh.count}/${formsDrawn}`,
      `press=${press.peakUtil > 0 ? 'ok' : 'ZERO'}`);

    // --- 2. surface nets on the poured concrete ---
    const st = surf.rebuild([cMin, cMax], simTime, setSec());
    const okN = st.verts > 100 && st.tris > 100;
    out.push(`surf=${okN ? `${st.verts}v/${st.tris}t` : 'FAIL'}`);

    // --- 3. blowout: tall single-skin light-duty box, slow set, hard pour ---
    clearAll();
    rand = mulberry32(7);
    boxForm(24, 34, 24, 34, 12, 0);            // 750 psf → ~5 ft max head
    S.setMin = 240; S.slump = 6; S.tipMode = 'manual'; S.tipY = 23;
    placePump(8, 8);
    setPourPoint(29, 29);
    startPour();
    for (let t = 0; t < 900 && blowouts === 0; t++) tick(0.1 * 20);
    stopPour();
    out.push(`blowout=${blowouts >= 1 ? 'ok(' + blowouts + ')' : 'NONE'}`);

    // --- 4. no blowout: steel-ply, short pour ---
    clearAll();
    rand = mulberry32(7);
    boxForm(24, 34, 24, 34, 12, 2);            // 1500 psf → 10 ft head
    S.setMin = 240; S.slump = 6;
    setPourPoint(29, 29);
    startPour();
    for (let t = 0; t < 150; t++) tick(0.1 * 20);  // ~4.5 ft head — well inside rating
    stopPour();
    out.push(`noblow=${blowouts === 0 && press.peakUtil < 1 ? `ok(util=${press.peakUtil.toFixed(2)})` : `FAIL(${blowouts},util=${press.peakUtil.toFixed(2)})`}`);

    // --- 5. curve fit on fixture + real-entry parse ---
    const fit = fitCurve(TEST_FIXTURE.pts);
    const f28 = fit ? evalCurve(fit, 28) : 0;
    const age75 = fit ? solveAge(fit, 0.75 * 4480) : null;
    const mono = fit && evalCurve(fit, 7) < evalCurve(fit, 28) && evalCurve(fit, 28) < evalCurve(fit, 90);
    const fitOk = fit && fit.a > 0 && fit.b > 0 && Math.abs(f28 - 4480) / 4480 < 0.05 && mono && age75 > 1 && age75 < 28;
    const pts = entryPoints(TEST_FIXTURE.entry);
    const parseOk = pts.some((p) => p.t === 7 && p.n === 2) && pts.some((p) => p.t === 28 && p.n === 3) && pts.some((p) => p.t === 90 && p.n === 2);
    out.push(`fit=${fitOk ? 'ok' : 'FAIL'}`, `parse=${parseOk ? 'ok' : 'FAIL'}`);

    // --- 6. pump hydraulics ---
    const base = { ...S, slump: 5, throttle: 1, aggIn: 1, unitWt: 150 };
    const wp = pumpByKey('wp1000');
    const a1 = pumpModel({ ...base, slump: 5 }, wp, 200, 6);
    const a2 = pumpModel({ ...base, slump: 2 }, wp, 200, 6);     // stiffer → more pressure
    const a3 = pumpModel({ ...base, slump: 5 }, wp, 400, 6);     // longer line → more pressure
    const stiffDerates = a2.derated && a2.effCYhr < a2.rateCYhr;
    const pumpOk = a2.reqPsi > a1.reqPsi && a3.reqPsi > a1.reqPsi && stiffDerates;
    out.push(`pump=${pumpOk ? 'ok' : `FAIL(${a1.reqPsi | 0},${a2.reqPsi | 0},${a3.reqPsi | 0})`}`);

    // --- 7. groups: stamp a rotated preset footing, then marquee-select it ---
    clearAll();
    activeGroupIdx = 0;            // Spread footing 6×6×2 → 40 perimeter blocks
    placeRot = 1;
    stampGroup(10, 0, 10);
    const stamped = formSet.size;
    selectRect(0, 0, GX - 1, GZ - 1);
    const selN = selection.size;
    clearSelection();
    placeRot = 0;
    out.push(`group=${stamped === 40 && selN === stamped ? 'ok' : `FAIL(${stamped},${selN})`}`);

    // --- 8. flood fill / element analysis ---
    clearAll();
    stampCells('Fill test', rectOutline(10, 10, 3, 0), 10, 0, 10);
    const elF = elements[elements.length - 1];
    const an = analyzeElement(ctx, elF);
    const fillOk = an.valid && an.enclosed && an.interior.length === 64 && an.capacityFt3 === 192 && an.targetTop === 3;
    // open U-shape (one wall missing) must not count as enclosed
    const uCells = rectOutline(8, 8, 2, 0).filter(([x, , z]) => z !== 7);
    const elU = { cells: uCells.map(([dx, dy, dz, c]) => [30 + dx, dy, 30 + dz, c]) };
    stroke = { cells: [] };
    for (const [x, y, z] of elU.cells) if (grid[idx(x, y, z)] === EMPTY) { S.formClassIdx = 0; setCell(idx(x, y, z), FORM); }
    pushUndo();
    const anU = analyzeElement(ctx, elU);
    out.push(`fill=${fillOk && anU.valid && !anU.enclosed ? 'ok' : `FAIL(${an.interior && an.interior.length},${an.capacityFt3},${anU.enclosed})`}`);

    // --- 9. auto-pour backcheck (the realism proof) ---
    clearAll();
    rand = mulberry32(11);
    S.pump = 's58sx'; S.setMin = 240; S.slump = 5; S.throttle = 1; S.aggIn = 1; S.tipMode = 'auto'; S.speed = 20;
    placePump(6, 24);
    stampCells('Footing A', rectOutline(6, 6, 2, 0), 12, 0, 12);
    stampCells('Footing B', rectOutline(6, 6, 2, 0), 34, 0, 34);
    startAutoPour();
    let guard = 0;
    while (autoPour && guard++ < 4000) tick(0.1 * 20);
    const done = elements.filter((e) => e.status === 'done' && e.validation);
    let apOk = done.length === 2 && guard < 4000;
    let worstErr = 0, psfOk = true;
    for (const e of done) {
      const v = e.validation;
      if (e.result.fillPct < 0.95) apOk = false;
      if (Math.abs(v.achievedTop - v.targetTop) > 1) apOk = false;
      if (Math.abs(v.volErrPct) > 5) apOk = false;
      if (Math.abs(v.volErrPct) > Math.abs(worstErr)) worstErr = v.volErrPct;
      // ±2 ft of head: voxel discreteness plus the transient spawn mound
      // that briefly rides above the form top right at cutoff (real pressure)
      if (Math.abs(v.peakPsf - v.expectedPsf) > S.unitWt * 2.0) psfOk = false;
    }
    const concNow = countCONC();
    const massOk = spawnedFt3Total === concNow + erasedFt3Total;
    out.push(`autopour=${apOk && psfOk && massOk ? `ok(${done.length}/2,err${worstErr.toFixed(1)}%,psf=ok,mass=ok)` : `FAIL(${done.length},${worstErr.toFixed(1)},${psfOk},${massOk})`}`);

    // --- 10. free-fall scatter ---
    clearAll();
    const scatterRun = (tipY) => {
      clearConcrete(false);
      rand = mulberry32(99);
      S.tipMode = 'manual'; S.tipY = tipY;
      setPourPoint(32, 32);
      startPour();
      for (let t = 0; t < 40; t++) tick(0.1 * 20);  // small pour so scatter isn't drowned by pile spread
      stopPour();
      let rSum = 0, nC = 0;
      for (let i = 0; i < N; i++) {
        if (grid[i] !== CONC) continue;
        const [x, , z] = cellOf(i);
        rSum += Math.hypot(x - 32, z - 32);
        nC++;
      }
      return { meanR: nC ? rSum / nC : 0, over: ft3OverDrop };
    };
    placePump(6, 24);
    const lo = scatterRun(6);
    const overLo = lo.over;
    const hi = scatterRun(20);
    const overHi = hi.over - overLo;
    // high free fall must widen the placement footprint (seeded → stable)
    // and register segregation-risk volume
    const dropOk = hi.meanR > lo.meanR && overHi > 50;
    out.push(`drop=${dropOk ? `ok(r${lo.meanR.toFixed(1)}<${hi.meanR.toFixed(1)},over=${overHi})` : `FAIL(${lo.meanR.toFixed(2)},${hi.meanR.toFixed(2)},${overHi})`}`);
    S.tipMode = 'auto';

    // --- 11. scene reinit round-trip ---
    reinitWorld(32, 16, 32);
    let sceneOk = grid.length === 32 * 16 * 32 && hmap.length === 32 * 32;
    const ri = idx(31, 15, 31);
    const [rx, ry, rz] = cellOf(ri);
    sceneOk = sceneOk && rx === 31 && ry === 15 && rz === 31;
    rand = mulberry32(5);
    S.pump = 's32x'; S.tipMode = 'auto';
    placePump(4, 16);
    stampCells('Small footing', rectOutline(5, 5, 2, 0), 12, 0, 12);
    setPourPoint(14, 14);
    startPour();
    for (let t = 0; t < 100; t++) tick(0.1 * 20);
    stopPour();
    sceneOk = sceneOk && countCONC() > 10;
    const st2 = surf.rebuild([cMin, cMax], simTime, setSec());
    sceneOk = sceneOk && st2.verts > 10;
    reinitWorld(64, 24, 64);
    sceneOk = sceneOk && grid.length === 64 * 24 * 64;
    out.push(`scene=${sceneOk ? 'ok' : 'FAIL'}`);

    document.title = 'SELFTEST ' + out.join(' ');
  } catch (e) {
    document.title = 'SELFTEST FAIL ' + e.message + ' | ' + out.join(' ');
  }
  rand = Math.random;
  selftesting = false;
}

if (location.hash === '#selftest') setTimeout(runSelfTests, 500);

if (location.hash === '#selftest-real') {
  setTimeout(() => {
    selftesting = true;
    reinitWorld(64, 24, 64);
    rand = mulberry32(42);
    boxForm(20, 34, 22, 32, 4, 1);
    S.setMin = 90; S.slump = 5; S.speed = 20; S.tipMode = 'manual'; S.tipY = 23;
    placePump(8, 8);
    setPourPoint(27, 27);
    startPour();
    for (let t = 0; t < 500; t++) tick(0.1 * 20);
    S.renderMode = 'real';
    $('renderMode').value = 'real';
    applyMode();
    rand = Math.random;
    selftesting = false;
  }, 500);
}

if (location.hash === '#selftest-autopour') {
  setTimeout(() => {
    selftesting = true;
    rand = mulberry32(11);
    loadTestScene();
    S.speed = 20;
    startAutoPour();
    let guard = 0;
    while (autoPour && guard++ < 4000) tick(0.1 * 20);
    S.renderMode = 'real';
    $('renderMode').value = 'real';
    applyMode();
    document.title = `AUTOPOUR done=${elements.filter((e) => e.status === 'done').length}/3 vol=${(spawnedFt3Total / 27).toFixed(1)}yd`;
    rand = Math.random;
    selftesting = false;
  }, 600);
}

// ---------- Main loop ----------
const TICK = 0.1; // seconds, real time
let acc = 0, last = performance.now();
let colorClock = 0, statClock = 0, surfClock = 0, surfSkip = false;

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  acc += dt;
  while (acc >= TICK) {
    acc -= TICK;
    tick(TICK * S.speed);
  }

  // periodic refresh so curing tint advances even when nothing moves
  colorClock += dt;
  if (colorClock > 1 && (concMesh.count > 0 || surf.mesh.visible)) { colorClock = 0; markConc(); }

  statClock += dt;
  if (statClock > 0.25) { statClock = 0; updateStats(); }

  if (S.renderMode === 'blocks') {
    if (concDirty) rebuildConc();
  } else {
    surfClock += dt;
    if (surfDirty && surfClock > (surfSkip ? 0.6 : 0.3)) {
      surfClock = 0;
      const st = surf.rebuild([cMin, cMax], simTime, setSec());
      surfSkip = st.ms > 8; // adaptive: back off if rebuilds get slow
      surfDirty = false;
    }
  }
  if (formDirty) rebuildForms();

  // pour stream visual
  if (pouring && pourPt) {
    const top = hmap[pourPt.x + pourPt.z * GX];
    const tipY = boomTip ? boomTip.y : tipYFor(pourPt) + 0.5;
    const h = Math.max(0.5, tipY - top);
    stream.scale.set(1, h, 1);
    stream.position.set(pourPt.x + 0.5, top + h / 2, pourPt.z + 0.5);
    stream.visible = true;
  } else {
    stream.visible = false;
  }

  updateDebris(dt);
  panKeys(dt);
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

// auto-sync mixes from Break Lab (quiet on failure)
syncMixes(false).then(() => {
  if (mixList.length) toast(`Break Lab synced — ${mixList.length} mixes available in Mix Design`);
});
