# GoldSmith Studio

A professional 3D assistant for bench jewellers, grillz makers and CAD designers. It complements
sculpting apps (Nomad Sculpt, Blender, Rhino): users sculpt elsewhere, this app handles
measurement, validation, repair, parametric generation, weight/cost calculation, grillz fitting
prep, and client deliverables.

**Hard constraints:** no AI features, no backend, no recurring costs. Everything runs client-side
in the browser; all data stays on-device (IndexedDB + file export). Offline-capable PWA targeting
iPad (Safari) first, desktop and Android second.

The full product plan lives in `docs/PLAN-PWA.md`.

## Status

Build-order steps 1–4 are implemented:

- **App shell** — viewport-first layout, dark studio theme with gold accent, workflow tab rail
  (Import, Repair, Measure + Cost active, the rest are placeholders), glassy overlay panels.
- **Viewer** — orbit/pan/zoom with inertial damping (touch: 1-finger orbit, 2-finger pan, pinch),
  view presets (Top/Front/Left/Right/Iso/Fit), perspective ↔ orthographic, display materials
  (polished gold/silver PBR, neutral studio, wireframe, normals & backface debug), configurable
  background + grid, turntable mode, PNG snapshot.
- **Import** — STL (binary+ASCII), OBJ, GLB/GLTF; drag & drop or file picker; unit interpretation
  (mm/cm/m/in); percentage rescale with live bounding-box readout; append or replace; parts tree
  with show/hide, select, rename, delete; move/rotate/scale transform gizmo.
- **Repair Center** — analysis report (triangles, shells, boundary edges/hole loops, non-manifold
  edges, inverted shells, watertight, volume, surface area) with problem areas highlighted in the
  viewport (red hole edges, blue flipped faces); heal (vertex weld, degenerate cleanup, winding
  fix, hole fill, small-shell filter, Manifold boolean union) with Safe/Aggressive/Custom modes;
  before/after stats; non-destructive undo; split into shells. All geometry ops run in a Web
  Worker (Manifold WASM).
- **Session autosave** — scene and display settings persist to IndexedDB and restore on reopen.
- **Weight & Cost** (step 3) — editable material library (Au 24/22/18/14/10k in yellow/white/rose,
  Ag 925/999, Pt 950, Pd 950, brass, bronze, resin, wax + custom materials); per-part material
  assignment with live volume → weight → cost (casting loss factor %, currency selector);
  "Refresh from market" spot prices (gold-api.com + ECB FX via frankfurter.dev, straight from the
  browser, graceful offline fallback to saved prices); shrinkage % helper (scales part before
  export); calculation history with CSV export. All persisted in IndexedDB.
- **Measure & Sections** (step 4) — point-to-point dimensions with vertex snapping, persistent
  screen-sized labels, per-dimension color, undo/clear (dimensions survive reload); section view
  per axis with position slider, flip, and thin-slab slice mode (translucent helper plane marks
  the cut; interior shown double-sided — no stencil caps yet); bounding-box readout; ring
  inner-diameter auto-detect; one-tap drafting view (orthographic front for dimensioned
  screenshots).

## Stack

TypeScript · React 19 · Vite · Three.js (imperative engine, **not** react-three-fiber) ·
Manifold WASM · Zustand · Tailwind CSS v4 + Radix primitives · idb · Vitest.

### Architecture rule

`src/core/` is UI-framework-agnostic: geometry, analysis, IO and persistence never import React,
and Three.js usage is confined to `core/engine` + `core/io` behind small facades. This keeps the
door open for the planned React Native shell (see plan §6).

```
src/
  core/
    engine/     SceneManager (Three.js renderer, cameras, gizmo, parts,
                measurements, section clipping) + materials
    geometry/   pure-TS analysis & repair + Manifold worker + client facade,
                fast volume/area + ring inner-Ø estimate (measure.ts)
    calc/       material library, weight/cost math, spot-price fetch
    io/         STL/OBJ/GLB importers
    persist/    IndexedDB scene/settings/materials/history autosave
    types.ts    shared types & presets
  app/studio.ts the controller wiring engine ⇄ store ⇄ persistence
  store/        zustand app state
  components/   React UI (viewport host, top bar, tab rail, panels)
```

## Development

```sh
pnpm install
pnpm dev          # dev server
pnpm exec vitest  # geometry unit tests
pnpm build        # production build (tsc + vite)
```

`scripts/make-test-stl.mjs` regenerates the broken/clean cube fixtures in `public/test/` used for
manual testing (drop `public/test/broken-cube.stl` into the viewport, then Repair → Analyze →
Heal: it should go from *watertight NO, 4 boundary edges* to *watertight yes, 1000.13 mm³*).

## Verification cross-checks (plan §8)

- 10 mm cube: volume 1000 mm³, surface 600 mm² — covered by unit tests.
- 10 mm cube of 14k yellow ≈ 13.05 g — covered by unit tests and verified live in the Cost tab.
- Ring inner-Ø estimate: synthetic 16 mm-bore band detected at 16.00 mm; solid bodies correctly
  report "no through-hole".
