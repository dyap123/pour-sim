/* ============================================================
   OpenPour — form pressure, blowouts, pump hydraulics
   Lateral form pressure = unit weight × plastic head (depth of
   not-yet-set concrete above the contact cell). Pump pressure
   model is ACI 304.2R-flavored: static head + line friction
   driven by slump, aggregate, line size and rate.
   ============================================================ */

export const FORM_CLASSES = [
  { key: 'ply',   name: '3/4" ply + snap ties', psf: 750  },
  { key: 'hdo',   name: 'HDO gang form',        psf: 1100 },
  { key: 'steel', name: 'Steel-ply system',     psf: 1500 },
];

// JLS / Brundage-Bone SpecBook 2023. Reach = net horizontal (ft).
// Output & concrete pressure printed in the book for the 2110 and
// line pumps; boom outputs are manufacturer-typical for the model.
export const PUMPS = [
  { key: 'wp1000',  name: 'Schwing WP 1000X line',     boom: false, reach: Infinity, maxCYhr: 85,  maxPsi: 1000, maxAgg: 0.5, lineDia: 3 },
  { key: 'olin5',   name: 'Olin 5" pea gravel line',   boom: false, reach: Infinity, maxCYhr: 60,  maxPsi: 1450, maxAgg: 1.5, lineDia: 4 },
  { key: 'cp2110v', name: 'CP 2110 truck — volume',    boom: false, reach: Infinity, maxCYhr: 139, maxPsi: 2175, maxAgg: 2.5, lineDia: 5 },
  { key: 'cp2110p', name: 'CP 2110 truck — pressure',  boom: false, reach: Infinity, maxCYhr: 90,  maxPsi: 3200, maxAgg: 2.5, lineDia: 5 },
  { key: 's20',     name: 'Schwing S 20',              boom: true,  reach: 44,  maxCYhr: 96,  maxPsi: 1131, maxAgg: 1.5, lineDia: 4 },
  { key: 's28x',    name: 'Schwing S 28X',             boom: true,  reach: 70,  maxCYhr: 130, maxPsi: 1131, maxAgg: 2.5, lineDia: 5 },
  { key: 's32x',    name: 'Schwing 32X',               boom: true,  reach: 84,  maxCYhr: 163, maxPsi: 1233, maxAgg: 2.5, lineDia: 5 },
  { key: 'bsf38',   name: 'Putzmeister BSF 38Z-5',     boom: true,  reach: 99,  maxCYhr: 170, maxPsi: 1233, maxAgg: 2.5, lineDia: 5 },
  { key: 's43sx',   name: 'Schwing 43SX',              boom: true,  reach: 115, maxCYhr: 180, maxPsi: 1233, maxAgg: 2.5, lineDia: 5 },
  { key: 'bsf47',   name: 'Putzmeister BSF 47Z',       boom: true,  reach: 125, maxCYhr: 210, maxPsi: 1233, maxAgg: 2.5, lineDia: 5 },
  { key: 's58sx',   name: 'Schwing 58SX',              boom: true,  reach: 165, maxCYhr: 200, maxPsi: 1233, maxAgg: 2.5, lineDia: 5 },
  { key: 's65sxf',  name: 'Schwing 65SXF',             boom: true,  reach: 187, maxCYhr: 200, maxPsi: 1233, maxAgg: 2.5, lineDia: 5 },
];
export const pumpByKey = (k) => PUMPS.find((p) => p.key === k) || PUMPS[6];

let C = null;             // ctx from app.js
let pressPsf = null;      // last computed lateral pressure per cell (psf)
let overSec = null;       // accumulated sim-seconds of overload per cell

export const press = {
  contactSF: 0,
  worstUtil: 0,           // current worst utilization across forms
  worstCell: -1,
  peakUtil: 0,            // session peak
  peakPsf: 0,
};

export function initPressure(ctx) {
  C = ctx;
  pressPsf = new Float32Array(ctx.N);
  overSec = new Float32Array(ctx.N);
}

export const cellPsf = (i) => pressPsf[i];
export const cellUtil = (i, classIdx) => pressPsf[i] / FORM_CLASSES[classIdx].psf;

export function clearPressure(i) {
  if (i === undefined) { pressPsf.fill(0); overSec.fill(0); press.peakUtil = 0; press.peakPsf = 0; press.worstUtil = 0; }
  else { pressPsf[i] = 0; overSec[i] = 0; }
}

/* Lateral pressure pass. dtSim = sim seconds since the last pass.
   Returns a list of cells that blew out this pass (app removes them). */
export function pressurePass(dtSim, S, simTime, setSec) {
  const { GX, GY, GZ, CONC, grid, born, idx, cellOf, formSet, formClass, rand } = C;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let contact = 0, worst = 0, worstCell = -1;
  const bursts = [];
  for (const i of formSet) {
    const [x, y, z] = cellOf(i);
    let head = 0;
    for (const [dx, dz] of DIRS) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nx >= GX || nz < 0 || nz >= GZ) continue;
      const j = idx(nx, y, nz);
      if (grid[j] !== CONC) continue;
      contact++;
      if (simTime - born[j] < setSec) {
        // plastic — head is the CONTIGUOUS plastic column rising from this
        // face: air gaps under in-flight cells break contiguity (no bogus
        // head from falling concrete), set concrete is self-supporting
        let h = 0, yy = y;
        while (yy < GY) {
          const k = idx(nx, yy, nz);
          if (grid[k] !== CONC || simTime - born[k] >= setSec) break;
          h++;
          yy++;
        }
        head = Math.max(head, h - 0.5);
      }
    }
    const p = S.unitWt * Math.max(0, head);
    pressPsf[i] = p;
    const util = p / FORM_CLASSES[formClass[i]].psf;
    if (util > worst) { worst = util; worstCell = i; }
    if (util > 1) {
      overSec[i] += dtSim;
      if (S.blowoutsOn && overSec[i] > 90) {
        const pPerMin = 0.05 + 0.5 * (util - 1) * (util - 1);
        if (rand() < pPerMin * dtSim / 60) bursts.push(i);
      }
    } else {
      overSec[i] = Math.max(0, overSec[i] - dtSim * 2);
    }
  }
  press.contactSF = contact;
  press.worstUtil = worst;
  press.worstCell = worstCell;
  if (worst > press.peakUtil) { press.peakUtil = worst; press.peakPsf = pressPsf[worstCell] || 0; }
  return bursts;
}

/* Neighbors to also rip out when a cell bursts (same wall, overloaded). */
export function burstNeighbors(i, limit = 2) {
  const { GX, GZ, FORM, grid, idx, cellOf, formClass } = C;
  const [x, y, z] = cellOf(i);
  const out = [];
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (nx < 0 || nx >= GX || ny < 0 || nz < 0 || nz >= GZ) continue;
    const j = idx(nx, ny, nz);
    if (grid[j] === FORM && cellUtil(j, formClass[j]) > 0.9) {
      out.push(j);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/* ---- ACI 347-style placement advisory ---- */
export function advisory(S, setMin, weakestPsf) {
  const hMax = weakestPsf / S.unitWt;                 // ft of full-liquid head the form takes
  const rMax = hMax / (setMin / 60);                  // ft/hr rise so head never exceeds hMax
  return { hMax, rMax };
}

/* ---- Pump hydraulics ----
   reqPsi(rate) = friction(slump, agg, line) · length + static head.
   k(slump): psi/ft per ft/s of line velocity — stiff mixes drag far more. */
function frictionK(slumpIn) {
  const t = Math.min(1, Math.max(0, (slumpIn - 2) / 7));    // 2" → 0, 9" → 1
  return 0.70 - 0.62 * t;                                    // 0.70 → 0.08 psi/ft per ft/s of line velocity
}

export function pumpModel(S, pump, lineLenFt, riseFt) {
  const rateCYhr = pump.maxCYhr * S.throttle;
  const aggFactor = 1 + 0.8 * (S.aggIn / pump.lineDia);      // big rock in a small line drags
  const kk = frictionK(S.slump) * aggFactor;
  const area = Math.PI * (pump.lineDia / 24) ** 2;           // line area ft² (radius = dia_in/2/12)
  const psiAtRate = (r) => {
    const v = (r * 27 / 3600) / area;                        // mean line velocity ft/s
    return kk * v * lineLenFt + S.unitWt * riseFt / 144;
  };
  const reqPsi = psiAtRate(rateCYhr);
  let effCYhr = rateCYhr, derated = false;
  if (reqPsi > pump.maxPsi) {
    // invert: solve the rate the pump can actually sustain at maxPsi
    const staticPsi = S.unitWt * riseFt / 144;
    const v = Math.max(0, (pump.maxPsi - staticPsi)) / (kk * lineLenFt || 1e-9);
    effCYhr = Math.max(0, v * area * 3600 / 27);
    derated = true;
  }
  return { rateCYhr, reqPsi, effCYhr, derated, maxPsi: pump.maxPsi };
}
