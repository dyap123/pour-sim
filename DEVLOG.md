# OpenPour — Dev Log

Running log of everything built, in order. Newest at the bottom.

---

## 2026-06-11 · v1 — Core simulator

**Files**: `index.html`, `app.js`

- Voxel world 64×24×64, **1 block = 1 ft³**: build formwork (wall-height painting), erase, place pump, set pour point.
- Cellular-automata concrete flow at 10 Hz: cells fall, then spread laterally with probability driven by **slump** (2–9") vs column height differences — stiff mixes pile steep, SCC self-levels. Initial-set time locks cells; wet (dark) → cured (light) tinting.
- Pump presets with rate (yd³/hr) + boom reach, truck + boom + pour-stream visuals, reach circle.
- CPU-friendly rendering: InstancedMesh + exposed-face culling, no shadows/AA, pixel ratio cap, low-power renderer.
- Minecraft-mode texture toggle, plan-image ground overlay, layout JSON export/import (Claude can generate layouts from structural drawings), localStorage autosave, undo.
- **Bug found & fixed via headless selftest**: pour falsely shut off ("form full") because the check read concrete still falling at the boom tip; fixed with sub-stepped flow at high sim speeds + failure-streak shutoff.
- Headless verification harness: `#selftest` hash writes results to `document.title`; Chrome `--headless=new --use-angle=swiftshader` + screenshot checks.

## 2026-06-11 · v2 — Engineering upgrade

**Files**: + `pressure.js`, `mixdata.js`, `surface.js`

- **Break Lab integration** (`mixdata.js`): auto-sync mixes + cylinder break records from the Break Lab Firebase (REST, CORS verified). Per-mix strength-gain curve fitted to pooled break averages — hyperbolic ACI 209 form `f(t)=t/(a+b·t)` via weighted least squares; ACI 209 default fallback flagged when no breaks. Mix selector + detail card + strength chart canvas; `solveAge` inverse for milestones.
- **Real pump fleet** (`pressure.js`) from the JLS/Brundage-Bone SpecBook 2023: 12 models (Schwing WP 1000X line pump → 65SXF), net reach, max output, **rated concrete pressure** (CP 2110: 139 CY/hr @ 2175 psi rod side / 90 @ 3200 piston side — printed in the book). Throttle ("Variable Volume Control"); required line PSI modeled from rate, line length, slump, aggregate; over rating → **derate** with gauge; oversized aggregate refuses to pump.
- **Form pressure + blowouts**: lateral psf = unit weight × plastic head (un-set concrete above each contact). Form classes per block (ply 750 / HDO 1100 / steel-ply 1500 psf), green→yellow→red utilization tinting, sustained overload → probabilistic **blowout** (toggleable) with debris + spill via CA wake. ACI 347-style advisory (max head / max rise rate).
- **Realistic render mode** (`surface.js`): surface-nets isosurface (table-free marching-cubes equivalent) over blurred occupancy; density backs into forms/floor for flush contact; gradient normals; per-vertex cure color + `wet` attribute driving Phong specular via onBeforeCompile. ~3 Hz bbox-restricted rebuilds, adaptive backoff.
- Formwork **SF stats** (contact vs gross panels), 📋 pour report modal (volume, rise rate, peak pressure, blowouts, SF, strength timeline + strip-date milestones).
- Layout JSON v2 (`[x,y,z,classIdx]`).
- Selftest suite: blowout / no-blowout (seeded RNG), surface triangle counts, curve fit on fixture, pump hydraulics monotonicity + derate. All headless-gated.

## 2026-06-11 · v3 — UI rework + groups

**Files**: + `fancy.js`; major `index.html` rework

- Sidebar removed → **contextual top toolbar** (controls swap with active tool) + full-screen **☰ Menu** overlay (card grid: Mix, Groups, View, Overlay, Layout).
- **Select tool (5)**: marquee over forms (blue glow), save selection as named group / delete. **Place tool (6)**: stamp saved groups with rotatable ghost preview (R), collision-aware coloring. Preset footings: spread footings 6×6/10×10, pile cap 8×8×4, grade beam 16 ft, column form 4×4×10. Groups persist in localStorage.
- Visual pass: dusk gradient sky, warm sun + cool rim light, vignette, glass/gradient theme (#6ea8ff→#9b6dff).
- **Icon/selector polish**: minimalist inline SVG line icons with labels everywhere (toolbar, topbar, menu cards); `fancy.js` custom dropdowns — two-line options (title + spec subtitle), glass popover, gradient active state; native selects stay hidden + synced so all wiring is untouched. Toggle-switch checkboxes, gradient slider thumbs.
- Topbar **mix selector** synced with the menu's.
- Selftest `group=` token: stamp rotated preset (exact block count) + marquee selection coverage.

## 2026-06-11 · v4 — Auto-pour, validation, scenes, free-fall physics

**Files**: + `elements.js`; major refactors in `app.js`, `surface.js`, `pressure.js`, `index.html`

- [x] **Variable grid dims**: `reinitWorld(gx,gy,gz)` reallocates the whole world (typed arrays, ctx mutated in place for pressure.js, surface recreated with dispose, instanced meshes recapped, statics resized, camera retargeted). Scene presets Small 32×16×32 / Standard 64×24×64 / Large 96×24×96 + custom dims; named scenes in localStorage; layout JSON **v3** (scene dims, pump, pour point, elements); built-in **Test Scene** (3 footings + pump, the validation demo).
- [x] **Pour elements** (`elements.js`): every group stamp registers an element; "+ Pour element" registers a marquee selection. `analyzeElement` revalidates against the live grid, flood-fills the interior (enclosed detection), finds the centroid pour column, computes capacity. Fill-to-top = ≥95% of interior columns at form top — applies to auto-pour **and** manual pours inside an element.
- [x] **Auto-pour sequencer**: nearest-first greedy ordering, boom travel animation (smoothstep lerp, sim-time so it works headless), per-element pour with reach validation, form-full + capacity-timeout backstops, per-element results.
- [x] **Boom tip height / free-fall physics**: auto mode rides ~3 ft above the *settled* surface (neighbor-max heuristic so in-flight spawn towers don't corrupt it) and climbs as the footing fills; manual slider 2–26 ft. Free fall drives: scatter (radius grows with drop, up to ±4 at 20 ft+), impact splash (longer active life), segregation tracking (every ft³ placed with >5 ft drop), and boom static head in the pump pressure model. Live colored free-fall readout.
- [x] **Backcheck review** (`seqModal` + CSV): per-element expected vs actual volume / fill % / achieved top / peak psf vs analytic γ·(H−½) / free-fall % / rates, plus **exact mass balance** (pumped = in place + removed) and totals.
- [x] **Pressure physics fix found by testing**: head is now the *contiguous plastic column* rising from each form face — air gaps under falling cells break contiguity (no bogus 20-ft heads from spawn towers), set concrete self-supports (cold joints correct).
- [x] **Textures/shaders**: world-XZ-projected two-octave noise albedo + hand-rolled bump on the realistic surface (wet = smooth/glossy → cured = rough), per-class form textures (ply grain + snap ties / dark HDO sheen / steel seams + rivets) on per-class instanced meshes, dirt ground + compacted-pad repeat textures.
- [x] **Zen mode** (`H` or eye button hides topbar/toolbar, pill restores) + **parametric footing builder** (name/W/D/H/class → group, jumps to place tool) + groups export/import JSON.
- [x] **Selftest suite now 13 tokens**, all passing headless:
  `conc placed drawn press surf blowout noblow fit parse pump group fill autopour drop scene` —
  highlight: `autopour=ok(2/2, err0.0%, psf=ok, mass=ok)` (volume error 0.0% vs hand calc, pressure within γ·2ft of γ(H−½), mass balance exact), `drop=ok(r3.9<4.1, over=102)`.
  Bugs the suite caught this round: sequencer stuck in travel phase (missing state transition), free-fall measured against backlog-corrupted hmap, falling-cell towers reading as hydrostatic head, scatter washed out by pile spread (metric fixed to mean radius).

---

## Status / next up

- **2026-06-12 — user hands-on test pass** of v4 (everything above is headless-verified only, not yet human-tested). Suggested route: ☰ Menu → Scene → 🧪 Test Scene → ⚙ Auto Pour at 5–10× → watch the boom hop footings and the review pop → try `M` realistic mode, the manual tip slider at ~20 ft (splatter), and a saved scene round-trip.
- Not deployed (local only: `python3 -m http.server 8080` in ~/pour-sim).
