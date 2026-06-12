# GoldSmith Studio — PWA Plan
*(working name — pick your own; "JewelCalc but mine, prettier, then grillz, then workflow")*

## 0. Vision & Principles

A professional 3D assistant for bench jewellers, grillz makers and CAD designers. It complements sculpting apps (Nomad Sculpt, Blender, Rhino) — it does not replace them. Users sculpt elsewhere; this app handles **measurement, validation, repair, parametric generation, weight/cost calculation, grillz fitting prep, and client deliverables**.

Hard constraints (agreed):
- **No AI/LLM features. No backend. No recurring costs.** Everything runs client-side in the browser; all data stays on-device (IndexedDB + file export). 100% offline-capable PWA, installable on iPad/desktop/Android.
- **For Mateusz's personal use first**, designed so it can later be sold to other jewellers, grillz makers, and dentists/dental techs (licensing/auth deferred to v3+, see §9).
- Primary device: **iPad (Safari/installed PWA)**, secondary: desktop browser, Android.
- Proven feasible: the competitor (JewelCalc) runs this exact stack — Three.js viewer + Manifold (WASM) geometry kernel + client-side PDF — entirely in-browser, smoothly on iPad. Heavy 3D is NOT a blocker.

Competitive positioning: **v1 = full JewelCalc feature parity with dramatically better UX. v2 = grillz/dental toolkit nobody else has (exocad-grade fit features at hobbyist price). v3 = production workflow (orders, quotes, casting packages).**

---

## 1. UX Concept — the big differentiator

JewelCalc's weakness: one screen with a pile of accordion panels, boring, low-effort visuals. Our answer:

### 1.1 Workspace model
- **Viewport-first layout**: the 3D scene is the hero, edge-to-edge. Panels are collapsible overlays/drawers, never a permanent sidebar wall.
- **Workflow tabs (guided modes)** along one edge. Each mode reconfigures the toolset around one job, while the model stays loaded in the same scene:
  1. **Import** — load & inspect
  2. **Repair** — analyze & heal
  3. **Measure** — dimensions, sections, thickness
  4. **Build** — parametric generators
  5. **Resize** — smart ring resizer
  6. **Fit** (v2) — grillz/dental tools
  7. **Cost** — materials, weight, pricing
  8. **Deliver** — report PDF, exports, (v3: orders)
- A persistent **"everything" mode** is still reachable (power users liked JewelCalc's all-in-one view) — workflow tabs are the default, not a cage.
- **Touch-first**: ≥44 pt targets, gesture orbit/pan/zoom (one-finger orbit, two-finger pan, pinch zoom), Apple Pencil support for measurement point picking, long-press context actions. Bottom-sheet panels on narrow screens.
- **Modern dark studio aesthetic**: deep neutral darks, one warm metal accent (gold), high-contrast type, subtle depth/glass on panels, polished microinteractions (smooth camera tweens, haptic-feeling button states). Light theme as an option later.
- **Command palette / quick action search** (desktop nicety): press `/`, type "resize"…
- Onboarding: empty-state hints per workflow tab instead of a manual.

### 1.2 Scene & viewer (always available)
- Orbit/pan/zoom with inertial damping; view cube or Top/Front/Left/Right/Reset presets; orthographic & perspective toggle.
- Display materials: polished gold/silver (PBR matcaps), neutral studio, wireframe overlay, normals/backface debug view.
- Configurable backgrounds & grid; turntable mode for client screenshots; one-tap **snapshot to PNG** (used later in reports).
- Multi-part model tree: parts list with show/hide, select, delete, rename.

---

## 2. v1 Feature Set (JewelCalc parity, done better)

### 2.1 Import & file handling
- Formats: **STL (binary+ASCII), OBJ, GLB/GLTF, PLY, 3MF** (PLY & 3MF are a step beyond JewelCalc; PLY matters for dental scans later).
- Drag & drop, file picker, and (in RN/installed contexts) share-sheet import.
- Unit interpretation (mm/cm/m) + percentage rescale with live bounding-box readout (X×Y×Z mm) so you can sanity-check "is this ring actually 20 mm wide?"
- Append multiple files into one scene (parts), or replace.
- **Auto-orientation guess + manual transform**: move/rotate/scale gizmo (JewelCalc lacks a transform gizmo — big UX win).
- Session autosave: reopening the app restores the last scene from IndexedDB.

### 2.2 Geometry kernel & Repair Center
Built on the Manifold (WASM) library — same proven kernel as the competitor (Apache-2.0).
- **Analysis report**: parts count, triangles, shells, inverted normals, boundary edges (holes), non-manifold edges, watertight yes/no, volume, surface area.
- **Heal**: boolean-union all shells into one watertight solid; normal fixing; degenerate-triangle cleanup.
- Modes: Safe (default), Aggressive (dirty scans), Custom tolerance.
- **Filter small parts** by minimum volume before healing (floating debris from sculpts).
- **Split into shells** as separate parts.
- Better UX than competitor: before/after stats side by side, problem areas **highlighted in the viewport** (red hole edges, blue flipped faces) — JewelCalc only shows numbers.
- Non-destructive: healing creates a new revision; undo restores.

### 2.3 Measurement & inspection
- **Linear and aligned dimensions** (point-to-point in 3D, snapped to vertices/surface), persistent labels, undo/clear, configurable color.
- **Section/clipping tools**: clip plane per axis with position slider, slice mode (thin slab), multi-section, cut view with capped cross-section so you can read wall thickness on the section.
- **Drafting mode**: orthographic side view with dimensions for screenshots.
- **Beyond parity — wall-thickness heatmap**: color the surface by local thickness (raycast-based), with a minimum-thickness threshold (e.g. "show me everything under 0.6 mm in red"). This is the #1 printability question and JewelCalc only offers manual slicing. (Computationally heavy → run in a worker, progressive refinement.)
- Bounding box dims, ring inner-diameter auto-detect readout.

### 2.4 Weight, materials & cost
- **Material library** (local, editable): defaults for Au 24/22/18/14/10k (yellow/white/rose), Ag 925/999, Pt 950, Pd, brass, bronze, castable resin, wax. Each: name, density g/cm³, optional price per gram, color tag.
- Per-part material assignment; totals per material and grand total.
- Outputs: **volume, weight, surface area** (surface area × thickness = electroplating estimate), cost = weight × price/g with adjustable **casting loss factor %** (parity-plus: JewelCalc doesn't expose loss factor).
- **Metal prices: manual entry first** + a "Refresh from market" button that calls a free public spot-price API directly from the browser when online (no server; graceful offline fallback to last saved prices). Currency selector.
- **Shrinkage helper**: scale model up by metal/investment shrinkage % (e.g. 1.5–2 %) before export for casting.
- Calculation **History** log (model name, date, material, weight, cost), exportable CSV.

### 2.5 Parametric generators (v1 = parity set)
All generators output real meshes into the scene, exportable, usable as bases for Nomad sculpting.

1. **Gemstone Generator**
   - ≥20 cuts: Round, Princess, Cushion (sq/std), Trillion (straight/curved), Oval, Pear, Marquise, Emerald (std/square), Heart, Radiant (std/square), Baguette, Octagon, Triangle, Calf, Asscher…
   - Industry size↔height tables per cut; custom L×W×H override.
   - **Matching cutter mesh** option (slightly oversized negative for boolean-subtracting a seat in the host model).
   - Export gem alone or place into scene.
2. **Band Ring Builder**
   - 9+ cross-section profiles (flat, comfort-fit variants, D-shape, half-round, knife-edge…).
   - Size by region (US/UK/EU/JP/CH/FR/DE) or direct inner diameter mm.
   - Uniform or **variable** mode (different width/thickness at bottom/shoulder/top with Smooth-spline or Classic-bézier interpolation, shoulders toggle).
   - Live 3D preview while dragging parameters (parity-plus; JewelCalc generates on click).
3. **3D Text Generator**
   - Text on plane or **along curve** (ring outside/inside, coin top/bottom arc), diameter from ring-size pickers, letter height, segment detail, subdivision.
   - Several bundled licensed fonts + **user font upload (TTF/OTF)** (parity-plus).
   - Output as solid (for embossing) or as cutter (for engraving subtraction).
4. **Ring Size Chart** — full bidirectional converter: diameter/radius/circumference ↔ US/UK/FR/DE/JP/CH; tap a size to spawn a **sizer cylinder** in the scene for visual checking against a model (parity-plus).

Backlog generators (v1.5+, modular): prong heads/bezel cups auto-sized from a gem, clasps & findings (lobster/box/toggle, bails, jump rings, ear posts), cuban/curb chain links, signet blanks, pavé layout along a curve, eternity-stone distributor.

### 2.6 Smart Ring Resizer (parity)
- Modes: **Solitaire/Engagement (protect head)** — keeps a protected angular zone rigid (default 45°), smoothing zone (default 40°), deforms only the shank; **Wedding band (uniform radial)**.
- Auto-detect current inner size; target size in mm or any regional system; before/after labels in 3D.
- Clean mesh-deformation, then optional re-heal pass.

### 2.7 Export & reports
- Export STL (binary), GLB/GLTF, OBJ, 3MF; per-part or merged; with optional shrinkage scale applied.
- **PDF Report Generator** (client-side): branded with custom logo + custom render image (or auto viewport snapshot), model stats (dims, volume, weight per material, surface area), gemstone list (cut/size/qty), modeling cost with billing increments (exact/15 min/30 min/1 h), optional metal-price disclosure, notes field. Copy-results-to-clipboard text version.
- Templates: Client quote / Casting spec / Internal record.

### 2.8 PWA platform features
- Installable (manifest + service worker), fully offline after first load (WASM + fonts precached).
- IndexedDB persistence: materials, history, settings, last scene, report branding.
- File System Access API where available; download fallback elsewhere; Web Share API for sending exports straight to Mail/AirDrop on iPad.
- Theming: dark studio default, accent choices, scene backgrounds.
- Local data export/import (single JSON backup file) — your insurance with no cloud.

---

## 3. v2 — Grillz & Dental Toolkit (the moat)

Target users: grillz makers, plus dentists/dental technicians. Workflow today: receive intraoral scan (STL/PLY) → sculpt grillz over it in Nomad → print castable resin → cast → **pray it fits**. The app removes the praying.

### 3.1 Fit Offset / Cement Gap (priority 1)
- Load the tooth scan; select the relevant teeth region (lasso/brush selection on surface).
- Generate an **offset surface** of the scan by a configurable clearance (typical 0.03–0.12 mm, presets + slider) — implemented as Minkowski-style offset via the geometry kernel.
- Two uses:
  a. **Subtract from a sculpted grillz shell**: import your Nomad-sculpted grillz, boolean-subtract the offset scan → interior surface guaranteed to have uniform clearance. One tap.
  b. **Export the offset scan** to sculpt over in Nomad directly.
- Visual clearance map: color the grillz interior by distance-to-tooth (red = touching/interference, green = within tolerance, blue = too loose).

### 3.2 Undercut Detection & Blockout (priority 1)
- Choose an **insertion axis** (default: average tooth normal / occlusal direction; adjustable with a 3D arrow gizmo, or "find best axis" minimizing undercut area).
- **Undercut survey**: color regions of the scan that are undercut relative to the axis (the classic dental-CAD survey view).
- **Auto-blockout**: fill undercuts to the survey line (with optional retention allowance, e.g. leave 0.02 mm of undercut for snap-fit retention — grillz makers want a little grip). Output a blocked-out scan to design against.
- Result: grillz that actually seat along the chosen path and snap on with predictable retention.

### 3.3 Supporting grillz features
- **Shell generator**: select teeth → uniform-thickness shell (0.6–1.5 mm) following the blocked-out, offset surface — a perfect Nomad starting point.
- **Bite clearance** (later): load upper+lower scans, distance map between them, check the grillz doesn't open the bite.
- Per-tooth weight estimate (split shell by tooth boundaries) for pricing 6-tooth vs 8-tooth sets.
- Dental presets in materials (10k–18k common grillz alloys), scan-cleanup preset in Repair Center (aggressive mode tuned for intraoral scan noise).
- PLY import with vertex colors displayed (scans often carry color — helps see margins).

---

## 4. v3 — Production Workflow (local-only CRM)

All local, no backend, exportable.
- **Clients**: name, contact, notes, ring sizes / tooth-scan files on record.
- **Orders/Jobs**: client, linked design files & calculations, status pipeline (Inquiry → Design → Approved → Print → Cast → Finish → Done), due date, photos.
- **Quote builder**: metal weight × live/manual price + casting fee + stones (from gem list) + labor (hours × rate, billing increments) → branded PDF quote; convert quote → order.
- **Casting-house package export**: one tap → ZIP containing repaired STL(s), spec-sheet PDF (material, finish, estimated weight, shrinkage applied y/n, notes), and preview renders — ready to email to the printer/caster.
- Dashboard: jobs by status, due soon, monthly totals.

---

## 5. Explicit non-goals
- No sculpting/freeform modelling (Nomad does that).
- No AI/LLM features in-product. *Nice-to-have note only*: an optional, clearly-marked "ask AI" link-out could be added someday, but nothing in core depends on it and nothing creates running costs.
- No cloud accounts, sync, or server rendering in v1–v3.
- No CAM/milling toolpaths; no full dental prosthetics (crowns/bridges) — only what grillz need.

---

## 6. Technical direction (decide details in implementation sessions)
- **Stack sketch**: TypeScript, React (or Svelte — decide later), Three.js for rendering, **Manifold WASM** as geometry kernel (booleans, healing, offsets), Web Workers for all heavy geometry (UI never blocks), jsPDF or pdf-lib for reports, IndexedDB via a small wrapper, Vite, PWA via Workbox.
- Architecture rule that enables the React Native plan: **`core/` (geometry, calc, file IO, report generation) must be UI-framework-agnostic and DOM-light** so the identical engine ships inside the RN shell. See PLAN-REACT-NATIVE.md.
- Performance budgets: open a 2 M-triangle scan on iPad without crash (progressive load, optional decimation for display), all geometry ops in workers with progress UI and cancel.
- Test rigs: unit tests on calc math (volume→weight, size charts), golden-file tests on generators, fuzz STL parser with broken files.

## 7. Suggested build order (v1)
1. App shell, theming, viewport, import (STL/OBJ/GLB), camera & display modes, scene autosave.
2. Manifold integration: analysis + repair center; transform gizmo.
3. Materials + weight/cost calc + history + manual prices (+ market refresh).
4. Measurements + clipping/sections + drafting mode.
5. Generators: band ring → gems(+cutters) → 3D text → size chart/sizer.
6. Smart Resizer.
7. PDF reports + branding + exports (incl. shrinkage scale).
8. PWA polish: offline, install, backup/restore. → **v1 ship (personal use)**.
9. Wall-thickness heatmap; extra formats (PLY/3MF). → v1.5
10. Grillz toolkit (§3) → v2. Workflow (§4) → v3.

## 8. Verification ideas per milestone
- Cross-check weight results against JewelCalc and hand math for known primitives (10 mm cube of 14k ≈ 13.05 g, etc.).
- Print-test the fit-offset pipeline on a real scan + resin print before calling v2 done.
- Ring sizes validated against ISO 8653 tables.

## 9. Future commercialization note (out of scope now)
When selling: add license-key or store-purchase gating (RN shell makes App Store/Play billing easy), 7-day trial → viewer-lite mode (JewelCalc's model works), landing page, Patreon/community marketing like ArtChahur. Dental/dentist market angle: position the grillz fit tools as "exocad-lite for grillz" — no certified medical-device claims (cosmetic jewellery only — keep that wording to avoid MDR/FDA territory).
