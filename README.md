# OpenPour — Concrete Pour Simulator

A voxel concrete-pour sandbox that doubles as an engineering tool. Every block is **1 ft³**. Build formwork, park a real pump, dial in a real mix, and pour — concrete falls, flows, and self-levels by slump, loads your forms, takes its initial set, and gains strength along a curve fitted to your actual cylinder breaks.

Built to run on machines **without a discrete GPU**: instanced meshes, no shadows, capped pixel ratio, 10 Hz fixed-step simulation, bbox-restricted surface rebuilds.

## Run it

```bash
cd ~/pour-sim
python3 -m http.server 8080
# open http://localhost:8080
```

Files: `index.html`, `app.js` (core), `pressure.js` (form pressure / blowouts / pump hydraulics), `mixdata.js` (Break Lab sync + strength curves), `surface.js` (realistic-mode isosurface). No build step; Three.js 0.160 from jsDelivr.

## Controls

| Input | Action |
|---|---|
| `1` / `2` / `3` / `4` | Build form / Erase / Place pump / Pour point |
| `5` | Select — drag a marquee over forms, then save as group or delete |
| `6` | Place group — stamp saved groups & footing presets, `R` rotates |
| Left click + drag | Use current tool (form tool paints walls at the set height & class) |
| `Alt` + click | Quick-erase with any tool |
| Right-drag / Wheel | Rotate / zoom |
| `W A S D`, `Q`/`E` | Pan, down/up |
| `Space` | Start / stop pour |
| `M` | Toggle Blocks (Minecraft) ↔ Realistic concrete |
| `Ctrl+Z` undo · `Esc` clear selection / close menus | |

The UI is a contextual top toolbar — the controls swap with the active tool — plus a full-screen **☰ Menu** for mix design, groups, view, overlay, and layout. Groups (saved selections and built-in footing presets like spread footings, pile caps, grade beams, column forms) persist in localStorage.

## Engineering model

- **Mix data** auto-syncs from Break Lab (Firebase) on load — real mix designs plus every cylinder break. Picking a mix sets slump/f'c/aggregate and fits a hyperbolic (ACI 209-form) strength-gain curve to the pooled break averages, plotted with the break points in the Mix Design panel. No break data → flagged ACI 209 default curve. Offline: import a mixes JSON.
- **Pump fleet** from the Brundage-Bone/JLS 2023 spec book: line pumps through the Schwing 65SXF, each with net reach, max output (CY/hr), rated concrete pressure (psi), max aggregate, and line size. The volume-control slider throttles output; required line pressure is modeled from rate, line length, slump, and aggregate — exceed the pump's rating and it **derates** (gauge shows it). Aggregate bigger than the line refuses to pump.
- **Form pressure**: lateral pressure = unit weight × head of still-plastic concrete above each contact face. Forms tint green → yellow → red toward their class rating (3/4" ply 750 / HDO 1100 / steel-ply 1500 psf). Sustained overload → **blowout** (toggleable): panels burst with debris and the pour spills out the hole. The advisory under Start Pour gives max head and max rise rate (ACI 347-style) for your weakest form and set time.
- **Formwork SF**: top bar tracks contact SF (faces against concrete) vs gross panel SF.
- **Pour report** (📋, auto after each pour ≥ 1 yd³): volume, trucks, rise rate, peak form-pressure utilization, blowouts, formwork SF, and a strength timeline from the fitted curve — "strip at 75% f'c → day N", "full design strength → day M".

## Auto-pour & validation

- **Pour elements**: every group you stamp (and any selection you register via "+ Pour element") becomes a footing the pump can pour. **⚙ Auto Pour** orders them nearest-first, slews the boom element-to-element, and fills each exactly to the top of its form (≥95% of the interior at target height). Manual pours inside an element also stop at the form top.
- **Boom tip height** (pour toolbar): auto mode keeps the discharge ~3 ft above the settled surface like a real operator, riding up as the footing fills; manual mode fixes the height. Free fall drives physics — above ~6 ft the stream scatters and splatters, long drops splash on impact, and every ft³ placed with >5 ft free fall is tracked as segregation risk. Tip height also feeds the pump's static head.
- **Backcheck review** (auto-opens after Auto Pour; chart topbar button): per-element expected vs actual volume (interior area × height vs counted cells), fill %, achieved top, peak form pressure vs the analytic γ·(H−½) hand calc, free-fall quality, rates — plus an **exact mass-balance check** (every ft³ pumped = in place + removed). CSV export included.

## Scenes

The Scene menu card creates new worlds: Small 32×16×32, Standard 64×24×64, Large 96×24×96, or custom dims (16–128 ft). Scenes save by name (grid, forms, pump, pour elements) and round-trip through layout JSON v3. **🧪 Test Scene** loads three footings + a pump ready for Auto Pour — its review proves the sim against hand calculations.

Other additions: `H` hides the UI (zen mode), the Groups card has a parametric W×D×H footing builder plus groups export/import, and forms/ground/concrete all have procedural textures (concrete gets world-projected noise + bump with a wet sheen that dries off).

## Pouring from a structural drawing

1. **Plan Overlay** — drape an image of the drawing on the ground at grid scale and trace the forms.
2. **Ask Claude** — drop the drawing into a Claude Code chat and import the layout JSON it returns (`sample-layout.json` included: spread footing + grade beam).

### Layout JSON schema (v2)

```json
{
  "app": "openpour",
  "version": 2,
  "name": "F-3 spread footing",
  "grid": [64, 24, 64],
  "forms": [[x, y, z, classIdx], ...]
}
```

Grid is 64 × 24 × 64 ft (x east, y up, z south), origin at the NW pad corner. `classIdx`: 0 = ply/ties, 1 = HDO gang, 2 = steel-ply (omit for 0; v1 three-element entries still load). Form the *outline* — concrete fills the inside.

## Headless verification

`#selftest` runs a seeded scenario suite (pour, surface mesh, blowout, no-blowout, curve fit, pump hydraulics) and writes results to the page title; `#selftest-real` sets up a poured scene in Realistic mode for screenshots:

```bash
chrome --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader \
  --virtual-time-budget=25000 --dump-dom http://localhost:8080/#selftest | grep -o '<title>[^<]*'
```
