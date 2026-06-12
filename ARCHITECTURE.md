# OpenPour — Architecture

Reference for diagnosing and extending the simulator. Companion docs: `DEVLOG.md` (chronological build history), `README.md` (user guide).

---

## 1. System overview

Static, no-build web app. Six ES modules loaded via importmap (Three.js 0.160 pinned from jsDelivr). Everything runs client-side; the only network calls are the Three.js CDN and a read-only fetch of Break Lab's Firebase RTDB.

| File | Role | Depends on |
|---|---|---|
| `app.js` | World state, sim loop, tools/UI wiring, auto-pour sequencer, scenes, selftests | all below |
| `pressure.js` | Form pressure pass, blowout decisions, pump fleet + hydraulics model | ctx only |
| `elements.js` | Pour-element analysis: interior flood fill, fill detection, backcheck math | ctx only |
| `mixdata.js` | Break Lab fetch/normalize, strength-curve fit, mix chart | none (fetch + canvas) |
| `surface.js` | Realistic-mode isosurface (surface nets) + concrete detail shaders | three |
| `fancy.js` | Custom dropdown component wrapping native `<select>`s | none |

**The `ctx` contract**: `app.js` owns all world state and passes one shared object — `{GX, GY, GZ, N, EMPTY, FORM, CONC, grid, born, hmap, formClass, formSet, idx, cellOf, inB, rand}` — to `pressure.js` (held by reference) and `elements.js`/`surface.js` (per call / per creation). On scene resize, `reinitWorld()` **mutates ctx in place** (never replaces it) and recreates anything that froze sizes at construction (pressure buffers via `initPressure`, the surface module, instanced meshes, static geometry).

## 2. World data model

- Grid of 1-ft³ voxels, default 64×24×64 (X east, Y up, Z south). Dims are module-level `let`s; `idx/cellOf/inB` read them live.
- `grid: Uint8Array(N)` — EMPTY / FORM / CONC.
- `born: Float32Array(N)` — sim time each CONC cell was placed; age vs `setSec()` decides plastic vs set (no separate "cured" state).
- `hmap: Uint8Array(GX·GZ)` — top of CONC per column (**includes in-flight cells** — see §4 for where this matters and how it's corrected).
- `formClass: Uint8Array(N)` + `formSet: Set<idx>` — per-block form class (ply 750 / HDO 1100 / steel 1500 psf).
- Audit counters: `spawnedFt3Total`, `erasedFt3Total`, `ft3OverDrop` (segregation), with the invariant **spawned ≡ countCONC + erased** (blowouts move concrete, never delete it). `placedFt3` is the separate UI net counter.
- `elements[]` — pour elements: `{id, name, base, cells[[x,y,z,cls]…absolute], status, analysis, result, validation}`. Created by every group stamp and by "+ Pour element" on a selection. `analysis` is derived lazily and revalidated against the live grid (<60% surviving forms → skipped).

## 3. Simulation pipeline

`animate()` (rAF) → fixed-step accumulator → `tick(0.1 · speed)` at 10 Hz real time.

```
tick(dt):
  substeps = clamp(round(speed/4), 1, 8)      // flow must keep pace with spawn
  per substep:
    simTime += dt/sub
    spawn (if pouring): rate = pumpState.effCYhr → spawnAcc → spawnOne()
    flowPass(): cellular automata over `active` map
    pressAcc += dt/sub
  pressure pass every 5 sim-s → pressurePass() → tint + blowout bursts
  sequencer step (travel: every tick; pour checks: 1/sim-s)
```

**Flow CA** (`flowPass`/`tryMove`): each active cell falls 1 cell per pass if empty below; otherwise tries the 4 lateral dirs (pre-shuffled permutation table, no GC): fall-over-edge `p = 0.25+0.75·P`, downhill (column diff ≥ 2) `p = 0.15+0.85·P`, level-out (diff = 1) `p = 0.4·P²` — with `P = ((slump−1)/8)^1.6`. Cells settle after `10+3·slump` failed passes and wake when neighbors vacate. Cells lock permanently once `age > setSec()`.

**Spawn + free fall** (`spawnOne`): tip elevation from `tipYFor` (auto: settled surface + 3 ft, manual slider). `dropH = tip − settledTop()`; drop > 6 ft scatters the spawn column (radius grows to ±4 at 20 ft, p up to 0.75), drop > 4 ft extends the cell's active life (impact splash), drop > 5 ft increments segregation counters. Backlog: 3 spawn slots above the tip, sustained failure streak (>200) = "form full".

**`settledTop(x,z)`** = `min(hmap[col], maxLateralNeighborHmap + 2)` — heuristic that ignores in-flight spawn towers when computing drop height and auto-tip elevation.

## 4. Physics models (and their calibration status)

| Model | Formula | Source / status |
|---|---|---|
| Form pressure | psf = γ · contiguous-plastic head. Head scans **up from the form face** counting contiguous plastic CONC; air gaps (falling cells) break it, set cells terminate it (self-supporting → cold joints correct) | First-principles hydrostatic; matches γ(H−½) in selftest |
| Blowout | util>1 sustained >90 sim-s → p/min = 0.05+0.5(util−1)²; bursts the cell + ≤2 neighbors >0.9 util, wakes nearby plastic CONC | Game-calibrated probability; ratings are real form-class numbers |
| Advisory | hMax = rating/γ; Rmax = hMax/(setMin/60) ft/hr vs live rise rate | ACI 347-flavored, simplified to the sim's exact set model |
| Pump pressure | reqPsi = k(slump)·aggFactor·v·L + γ·rise/144; k: 0.7→0.08 psi/ft per ft/s (slump 2→9"); aggFactor = 1+0.8(agg/lineDia); over rating → analytic derate | **Feel-calibrated**, not lab data; fleet specs (rate/maxPsi/reach) are real Brundage-Bone numbers |
| Strength gain | f(t)=t/(a+b·t), weighted LSQ on linearized t/f; fallback ACI 209 (a=4/fRef, b=0.85/fRef) | Fit to actual Break Lab cylinder averages |
| Set/cure | single `setMin` slider; binary plastic→set at that age | **Not data-driven** (no set-time data in Break Lab); no temperature input |

## 5. Auto-pour sequencer

State machine in `autoPour` driven from `tick()` on **sim time** (headless-safe):
`startAutoPour` → analyze + reach-check all pending elements → **nearest-first greedy** order → per element: `travel` (boom tip smoothstep-lerped, ~12 ft/s, pouring off) → `pour` (pour point = interior centroid column, tip auto-rides surface) → finish on `fillPct ≥ 0.95` | form-full streak | capacity timeout (1.5× expected duration + 120 s) → `finishElement` (fresh pressure pass, element-scoped peak psf, `validateElement`) → next. Manual pours inside an element get the same 1/sim-s fill check. Ends with the sequence review modal (expected-vs-actual table, mass balance, CSV).

## 6. Rendering

Two paths, both CPU-budgeted (no shadows, no AA, pixelRatio ≤ 1.5, low-power context):

- **Blocks**: `concMesh` InstancedMesh + 3 per-class `formMeshes` (real textures per class), exposed-face culling, rebuilds confined to the concrete bbox (`cMin/cMax`, grow-only), ≤10 Hz on dirty. Caps: `CAP = clamp(GX·GZ·10, 40k, 90k)` instances with a one-time toast on overflow. Form tint = utilization ramp (white→green→yellow→red) or selection blue, multiplied over the texture.
- **Realistic** (`surface.js`): binary occupancy (backed into forms/floor where adjacent to CONC, so the surface sits flush) → separable 1-2-1 blur → **surface nets** (table-free; one vertex per sign-change cell at averaged edge crossings, quads across sign-change lattice edges) → indexed BufferGeometry with gradient normals, per-vertex cure color + `wet` attribute. Shaders via `onBeforeCompile` on Phong (r160 chunk names): world-XZ-projected 2-octave noise albedo, hand-rolled bump from noise derivatives scaled by `(2.2−1.4·wet)`, specular = `0.08+0.9·wet`. Rebuilds ~3 Hz, bbox-restricted, adaptive backoff past 8 ms. `MAXV = clamp(GX·GZ·22, 90k, 200k)`.
- Visual props: boom TubeGeometry rebuilt on tip moves, stream cylinder = live free-fall length, debris pool (16 pooled planks), reach ring, marquee box, group ghost (instanced, blocked = orange).

## 7. UI architecture

Topbar (stats + mix select + menu/report/review/zen buttons) · contextual toolbar (`.ctx` clusters shown per tool via `data-ctx` tokens — pump cluster shared by pump+pour tools) · full-screen menu of cards (Mix, Groups+builder, Scene, View, Overlay, Layout) · modals (help, pour report, sequence review). All dropdowns are `fancy.js` popovers over hidden native selects (two-line "Title — subtitle" parsing; native `change` events keep all existing wiring alive; MutationObserver follows repopulation). Zen mode = `body.zen` class.

## 8. Persistence

localStorage: `openpour_layout` (autosave, JSON v3), `openpour_groups`, `openpour_scenes` (name → full v3 snapshot). Layout JSON v3: `{app, version:3, scene:{name,dims}, pump:{key,pos}, pourPt, forms:[[x,y,z,cls]], elements:[{id,name,base,cells}]}` — v2/v1 still load. Groups export as `{app:'openpour-groups', groups}`. **Everything is per-browser; nothing syncs across machines.**

## 9. Testing

`#selftest` — 13 deterministic tokens (seeded mulberry32 via the swappable `rand` hook) written to `document.title`: legacy pour, surface mesh, blowout/no-blowout, curve fit + live-shape parse, pump monotonicity + derate, group stamp/marquee, flood-fill geometry, **auto-pour backcheck** (fill ≥95%, |vol err| <5%, psf within γ·2 ft of γ(H−½), exact mass balance), free-fall scatter + segregation, scene-resize round-trip. `#selftest-real` / `#selftest-autopour` are screenshot scenes. Headless recipe: Chrome `--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --virtual-time-budget=40000 --dump-dom <url>#selftest`. The suite has caught five real physics/sequencing bugs to date (see DEVLOG v1/v4).

---

## 10. Diagnostic: known limitations & improvement targets

Ordered roughly by impact-per-effort for making the tool *better* (more realistic, faster, more useful in the field).

### Physics fidelity
1. **Flow speed is resolution-locked.** Cells fall 1 cell/pass ⇒ ~10 ft/s at 1× regardless of mix; lateral spread rate is probability-only. A momentum/throughput term (cells move >1/pass when unobstructed, scaled by slump) would decouple realism from tick rate. (`flowPass`/`tryMove`, app.js)
2. **In-flight vs settled concrete is heuristic.** `settledTop` (max-neighbor cap) and the contiguous-head scan both work around `hmap` counting falling cells. A per-cell `supported` bit (set when a cell lands, cleared when its support moves) would make hmap, pressure, drop height, and fill detection all exact and cheaper. Highest-leverage internal refactor.
3. **No temperature.** ACI 347 pressure and real set times are temperature-driven; Break Lab entries even carry an `ambient` field. Add a temp input → scale `setMin` (maturity-style) and show it in the advisory. Small change, big engineering credibility. (`pressure.js advisory`, mix panel)
4. **Pump friction constants are feel-calibrated.** `k(slump)` and `aggFactor` were tuned for plausible gauge numbers, not measured. Calibrate against a published nomograph (ACI 304.2R / KSP tables) and document the mapping. (`pressure.js pumpModel`)
5. **No vibration/consolidation**, no segregation *consequence* (it's tracked and reported but doesn't degrade anything). Could tie `ft3OverDrop` fraction into the element's reported strength confidence.

### Performance (the CPU-laptop question)
6. **`rebuildForms` is a full-grid scan** (O(N)) and runs after **every pressure pass** (every 5 sim-s) plus every edit. At 96×24×96 that's 221k cells per pass. Fix: iterate `formSet` instead of the grid (forms are sparse — typically <5k cells), or keep per-class dirty flags. Probably the single biggest win for large scenes. (app.js `rebuildForms`)
7. **Concrete bbox is grow-only** (`cMin/cMax`); after a big pour is erased the instanced rebuild and surface march keep scanning the old volume until Clear. Recompute the bbox on erase strokes or periodically.
8. **Surface rebuild is monolithic** per bbox; chunking (16³ regions with per-chunk dirty) would smooth worst-case frames on big slabs in realistic mode.
9. No runtime perf telemetry. A tiny on-screen ms/frame + rebuild-ms readout (dev flag) would make the laptop field test diagnosable instead of anecdotal.

### Product / field usability
10. **No cross-device persistence.** Scenes/groups are localStorage-only. The obvious move given the rest of the OpenYap stack: optional Firebase sync (same RTDB pattern as CUP/Break Lab, `pour-sim/` namespace) for scenes, groups, and pour-review results — then reviews become shareable records.
11. **Single pour point per element.** Big slabs/mats realistically need multiple boom positions per element; the sequencer supports it structurally (queue of pour columns per element) but it's not implemented.
12. **Element lifecycle gaps**: undo doesn't restore the element registry; deleting forms orphan-skips elements via the 60% heuristic only at pour time. A registry-aware undo entry type would close this.
13. **No touch/mobile controls** (marquee, right-drag orbit). iPad-in-the-field is a realistic use case in this org.
14. **Drawing import is manual** (trace overlay or Claude-generated JSON). A vision pass that proposes form outlines from the overlay image (even rough rectangles to refine) would shortcut the main authoring loop.

### Testing
15. Selftests assert physics but **not performance** (no "rebuild under X ms at 96³" gate) and screenshots are eyeballed, not diffed. A pixel-diff against golden images + a perf token would catch regressions the current suite can't.
