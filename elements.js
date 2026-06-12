/* ============================================================
   OpenPour — pour elements (footings, pile caps, walls placed
   as groups). Pure functions over the shared ctx: interior
   flood fill, fill detection, and backcheck validation math.
   ============================================================ */

/* Derive pourable geometry from an element's recorded cells against the
   LIVE grid (forms may have been erased since the stamp).
   Returns { valid, enclosed, interior:Int32Array of column keys,
             pourCol:[x,z], baseY, targetTop, capacityFt3 } */
export function analyzeElement(ctx, el) {
  const { GX, GZ, FORM, grid, idx } = ctx;
  if (!el.cells.length) return { valid: false };

  let baseY = Infinity, topY = -1;
  let x0 = Infinity, x1 = -1, z0 = Infinity, z1 = -1;
  for (const [x, y, z] of el.cells) {
    if (y < baseY) baseY = y;
    if (y > topY) topY = y;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const targetTop = topY + 1;

  // wall columns = element columns with a surviving FORM cell in the lift range
  const wall = new Set();
  let surviving = 0;
  for (const [x, y, z] of el.cells) {
    if (y < baseY || y >= targetTop) continue;
    if (grid[idx(x, y, z)] === FORM) {
      surviving++;
      wall.add(x + z * GX);
    }
  }
  if (surviving < el.cells.length * 0.6) return { valid: false };

  // flood the OUTSIDE from the bbox perimeter (4-connected, non-wall columns)
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  const mark = new Uint8Array(W * D); // 1 = outside
  const queue = [];
  const push = (lx, lz) => {
    const k = lx + lz * W;
    if (lx < 0 || lx >= W || lz < 0 || lz >= D || mark[k]) return;
    if (wall.has(x0 + lx + (z0 + lz) * GX)) return;
    mark[k] = 1;
    queue.push(lx, lz);
  };
  for (let lx = 0; lx < W; lx++) { push(lx, 0); push(lx, D - 1); }
  for (let lz = 0; lz < D; lz++) { push(0, lz); push(W - 1, lz); }
  while (queue.length) {
    const lz = queue.pop(), lx = queue.pop();
    push(lx + 1, lz); push(lx - 1, lz); push(lx, lz + 1); push(lx, lz - 1);
  }

  let interior = [];
  for (let lz = 0; lz < D; lz++) {
    for (let lx = 0; lx < W; lx++) {
      const c = x0 + lx + (z0 + lz) * GX;
      if (!mark[lx + lz * W] && !wall.has(c)) interior.push(c);
    }
  }
  let enclosed = interior.length > 0;
  if (!enclosed) {
    // open form — pour what's inside the bbox anyway, expected volume is advisory
    for (let lz = 1; lz < D - 1; lz++) {
      for (let lx = 1; lx < W - 1; lx++) {
        const c = x0 + lx + (z0 + lz) * GX;
        if (!wall.has(c)) interior.push(c);
      }
    }
    if (!interior.length) return { valid: false };
  }

  // pour point: interior column nearest the interior centroid
  let cx = 0, cz = 0;
  for (const c of interior) { cx += c % GX; cz += (c / GX) | 0; }
  cx /= interior.length; cz /= interior.length;
  let best = interior[0], bestD = Infinity;
  for (const c of interior) {
    const d = (c % GX - cx) ** 2 + (((c / GX) | 0) - cz) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }

  return {
    valid: true,
    enclosed,
    interior: Int32Array.from(interior),
    pourCol: [best % GX, (best / GX) | 0],
    baseY,
    targetTop,
    capacityFt3: interior.length * (targetTop - baseY),
  };
}

/* Fraction of interior columns filled to the form top. */
export function fillState(ctx, el) {
  const { hmap } = ctx;
  const a = el.analysis;
  if (!a || !a.valid) return { fillPct: 0, full: 0 };
  let full = 0;
  for (const c of a.interior) if (hmap[c] >= a.targetTop) full++;
  return { fillPct: full / a.interior.length, full };
}

/* Backcheck: simulated outcome vs analytic expectation. */
export function validateElement(ctx, el, unitWt) {
  const { GX, CONC, grid, hmap, idx } = ctx;
  const a = el.analysis;
  const r = el.result || {};
  let actual = 0, topSum = 0, topMin = Infinity;
  for (const c of a.interior) {
    const x = c % GX, z = (c / GX) | 0;
    for (let y = a.baseY; y < a.targetTop; y++) {
      if (grid[idx(x, y, z)] === CONC) actual++;
    }
    topSum += Math.min(hmap[c], a.targetTop);
    if (hmap[c] < topMin) topMin = hmap[c];
  }
  const H = a.targetTop - a.baseY;
  const expectedPsf = unitWt * Math.max(0, H - 0.5);
  const durSec = (r.endSim || 0) - (r.startSim || 0);
  return {
    expectedFt3: a.capacityFt3,
    actualFt3: actual,
    volErrPct: a.capacityFt3 ? ((actual - a.capacityFt3) / a.capacityFt3) * 100 : 0,
    achievedTop: topSum / a.interior.length,
    topMin,
    targetTop: a.targetTop,
    expectedPsf,
    peakPsf: r.peakPsf || 0,
    psfErrPct: expectedPsf ? (((r.peakPsf || 0) - expectedPsf) / expectedPsf) * 100 : 0,
    durSec,
    avgCYhr: durSec > 0 ? (r.spawned || 0) / 27 / (durSec / 3600) : 0,
    overDropPct: r.spawned ? ((r.ft3OverDrop || 0) / r.spawned) * 100 : 0,
  };
}
