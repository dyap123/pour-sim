/* ============================================================
   OpenPour — mix data from Break Lab (Firebase RTDB, REST)
   Pulls real mix designs + cylinder break results, pools the
   per-age averages per mix, and fits a hyperbolic strength-gain
   curve (ACI 209 form):  f(t) = t / (a + b·t)  [psi, t in days]
   ============================================================ */

const BASE = 'https://gen-lang-client-0119642855-default-rtdb.firebaseio.com/concrete-breaks';
const PROBE_AGES = [1, 3, 7, 14, 28, 56, 90];

export async function fetchMixData() {
  const [mixes, entries] = await Promise.all([
    fetch(`${BASE}/mixDesigns.json`).then((r) => r.json()),
    fetch(`${BASE}/entries.json`).then((r) => r.json()),
  ]);
  return normalize(mixes || {}, entries || {});
}

/* Accepts a raw RTDB export {mixDesigns:{}, entries:{}} or {mixes:[], entries:[]} */
export function normalizeImport(data) {
  const mixes = data.mixDesigns || data.mixes || {};
  const entries = data.entries || {};
  return normalize(mixes, entries);
}

const num = (v) => {
  const n = parseFloat(v);
  return isFinite(n) && n > 0 ? n : null;
};

/* One averaged {t, psi, n} point per tested age of one entry. */
export function entryPoints(e) {
  const ages = Array.isArray(e.ages) && e.ages.length ? e.ages : PROBE_AGES;
  const pts = [];
  for (const a of ages) {
    let cyl = e['d' + a];
    if (!Array.isArray(cyl)) cyl = [e[`d${a}_1`], e[`d${a}_2`], e[`d${a}_3`]];
    const v = (cyl || []).map(num).filter(Boolean);
    if (v.length) pts.push({ t: +a, psi: v.reduce((s, x) => s + x, 0) / v.length, n: v.length });
  }
  return pts;
}

/* Parse aggregate strings like '1/2"', '1"', '3/4', 'sand' → inches. */
export function parseAggIn(s) {
  if (!s) return 1;
  const str = String(s).toLowerCase();
  if (str.includes('sand') || str.includes('pea')) return 0.375;
  const frac = str.match(/(\d+)\s*\/\s*(\d+)/);
  if (frac) return +frac[1] / +frac[2];
  const whole = str.match(/(\d+(\.\d+)?)/);
  return whole ? +whole[1] : 1;
}

function normalize(mixesRaw, entriesRaw) {
  const entries = Object.values(entriesRaw || {});
  const byMix = {};
  for (const e of entries) {
    if (!e || !e.mix) continue;
    (byMix[e.mix] = byMix[e.mix] || []).push(e);
  }
  const mixes = [];
  for (const m of Object.values(mixesRaw || {})) {
    if (!m || !m.code) continue;
    const ents = byMix[m.code] || [];
    // pool {t, psi, n} per age across all entries, weighted by cylinder count
    const pool = {};
    let slumpSum = 0, slumpN = 0;
    for (const e of ents) {
      for (const p of entryPoints(e)) {
        const g = (pool[p.t] = pool[p.t] || { t: p.t, sum: 0, n: 0 });
        g.sum += p.psi * p.n;
        g.n += p.n;
      }
      const s = num(e.slump);
      if (s && s < 12) { slumpSum += s; slumpN++; }
    }
    const pts = Object.values(pool)
      .map((g) => ({ t: g.t, psi: g.sum / g.n, n: g.n }))
      .sort((p, q) => p.t - q.t);
    const fc = num(m.fc);
    const fit = fitCurve(pts) || fallbackCurve(pts, m);
    mixes.push({
      code: m.code,
      fc,
      age: num(m.age) || 28,
      use: m.use || '',
      area: m.area || '',
      agg: m.agg || '',
      aggIn: parseAggIn(m.agg),
      slumpTarget: num(m.slumpTarget),
      slumpAvg: slumpN ? slumpSum / slumpN : null,
      wcRatio: num(m.wcRatio),
      cementType: m.cementType || '',
      supplier: m.supplier || '',
      fcr: num(m.fcr),
      breakSets: ents.length,
      pts,
      fit,
    });
  }
  mixes.sort((a, b) => (b.fc || 0) - (a.fc || 0));
  return { mixes, entryCount: entries.length };
}

/* Weighted least squares on the linearized model t/f = a + b·t.
   Returns {a, b, src:'breaks'} or null if data is insufficient/degenerate. */
export function fitCurve(pts) {
  const usable = (pts || []).filter((p) => p.psi > 0);
  const distinct = new Set(usable.map((p) => p.t));
  if (distinct.size < 2) return null;
  let sw = 0, st = 0, sy = 0, stt = 0, sty = 0;
  for (const p of usable) {
    const w = p.n || 1, y = p.t / p.psi;
    sw += w; st += w * p.t; sy += w * y; stt += w * p.t * p.t; sty += w * p.t * y;
  }
  const den = stt - (st * st) / sw;
  if (Math.abs(den) < 1e-12) return null;
  const b = (sty - (st * sy) / sw) / den;
  const a = (sy - b * st) / sw;
  if (!(a > 0) || !(b > 0)) return null;
  return { a, b, src: 'breaks' };
}

/* ACI 209 moist-cured Type I default: f(t) = fRef · t/(4 + 0.85t),
   which is a = 4/fRef, b = 0.85/fRef in the same hyperbolic form. */
export function fallbackCurve(pts, m, psiDefault) {
  const p28 = (pts || []).find((p) => p.t === 28);
  const fRef = (p28 && p28.psi) || (m && (num(m.fcr) || num(m.fc))) || psiDefault || 4000;
  return { a: 4 / fRef, b: 0.85 / fRef, src: 'aci' };
}

export const evalCurve = (fit, tDays) => (tDays <= 0 ? 0 : tDays / (fit.a + fit.b * tDays));

/* Inverse: age (days) at which strength F is reached; null if never. */
export function solveAge(fit, F) {
  const ult = 1 / fit.b;
  if (F >= ult) return null;
  return (fit.a * F) / (1 - fit.b * F);
}

/* ---- Strength-gain chart (Canvas 2D) ---- */
export function drawMixChart(canvas, mix, designFc) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  const fit = mix.fit;
  const tMax = Math.max(56, ...(mix.pts.map((p) => p.t))) * 1.1;
  const yMax = Math.max(designFc || 0, evalCurve(fit, tMax), ...mix.pts.map((p) => p.psi)) * 1.15 || 1000;
  const px = (t) => 26 + (t / tMax) * (W - 34);
  const py = (f) => H - 16 - (f / yMax) * (H - 26);
  // axes
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(26, 6); g.lineTo(26, H - 16); g.lineTo(W - 6, H - 16); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.font = '9px sans-serif';
  for (const t of [7, 28, 56, 90]) {
    if (t > tMax) continue;
    g.fillText(`${t}d`, px(t) - 6, H - 5);
    g.fillRect(px(t), H - 18, 1, 3);
  }
  g.save(); g.translate(8, H / 2); g.rotate(-Math.PI / 2); g.fillText('psi', 0, 0); g.restore();
  // design f'c line
  if (designFc) {
    g.strokeStyle = 'rgba(91,155,213,0.7)';
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(26, py(designFc)); g.lineTo(W - 6, py(designFc)); g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(91,155,213,0.9)';
    g.fillText(`f'c ${designFc}`, W - 52, py(designFc) - 3);
  }
  // fitted curve
  g.strokeStyle = fit.src === 'breaks' ? '#4cc06c' : '#c8a64c';
  g.lineWidth = 1.6;
  g.beginPath();
  for (let t = 0.5; t <= tMax; t += tMax / 60) {
    const x = px(t), y = py(evalCurve(fit, t));
    t === 0.5 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
  // break averages
  g.fillStyle = '#e8e9ec';
  for (const p of mix.pts) {
    g.beginPath(); g.arc(px(p.t), py(p.psi), 2.6, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillText(fit.src === 'breaks' ? 'fit: project breaks' : 'fit: ACI 209 default', 30, 12);
}

/* ---- embedded fixture for the selftest ---- */
export const TEST_FIXTURE = {
  pts: [{ t: 7, psi: 3010, n: 3 }, { t: 28, psi: 4480, n: 3 }, { t: 56, psi: 4990, n: 3 }],
  entry: { // shaped like a real Break Lab record: string arrays, missing fields
    mix: 'TEST1', pourDate: '2026-05-01', slump: '4.5',
    d7: ['2950', '3070', ''], d28: ['4400', '4560', '4480'], d28_date: '2026-05-29',
    d90_1: '5200', d90_2: '5150',
  },
};
