# LOFT-Sim UI

A browser-based 3D visualization for large UAV/UAM fleets in an urban scene, built with Three.js. It is the web front-end for **[LOFT-Sim](https://github.com/cherryh2021/LOFT-Sim)** (the Low-altitude Operations Fast-Time Simulator): the simulator owns the airspace network and vehicle state, and this app renders the fleet and provides interactive controls.

You normally don't install this repo to use it — LOFT-Sim downloads a built release of this UI on demand (see [Releases & distribution](#releases--distribution)). Clone it only to develop the UI itself.

## Modes

The app picks a data source at startup:

- **Telemetry-backed (default).** It fetches the scene network from the simulator's `/configs` endpoint and streams live UAV state over a `/ws` websocket. This is what you get when LOFT-Sim serves the UI (`loft-sim run --visualization web`).
- **Standalone demo.** When no backend is present (e.g. `npm run dev`), it falls back to the bundled assets under `public/data/`, scheduling UAV departures in the browser from a demand-flow file. The control panel also offers frontend-only demo presets and custom file uploads.

## Stack

- **Build/runtime:** Vite + TypeScript (native ES modules)
- **Rendering:** Three.js (`three-mesh-bvh` / `three-bvh-csg` for geometry)
- **UI:** Tweakpane (control panel), `stats.js` (FPS overlay)
- **Tests:** Vitest

## Getting started (development)

```sh
npm install
npm run dev      # dev server at http://localhost:5173 (standalone demo data)
npm run build    # type-check (tsc) and produce a production build in dist/
npm run preview  # serve the production build
npm test         # run the Vitest suite
```

### Exercising telemetry mode locally

Under `npm run dev` the network/map come from the bundled `public/data/` files (the backend `/configs` is absent), while UAV state is read from a websocket at `ws://127.0.0.1:8765/ws`. A bundled mock server can supply that stream without running the full simulator:

```sh
npm run mock:data   # generate mock/mock_telemetry.json from a network file
npm run mock:ws     # serve it at ws://127.0.0.1:8765/ws (--hz 30|60|120)
```

To render against the real simulator instead, run `loft-sim run --visualization web`, which serves this UI and its telemetry from the same origin.

### Render smoke-test (manual)

`npm run verify:render` drives the real app in a system Chrome (headless, WebGL via SwiftShader) to confirm the per-type UAV models render and that selecting a drone turns it solid red. It starts its own mock WS + Vite, captures `mock/render-check/{fleet,selected}.png`, and exits non-zero on failure.

It needs a system Chrome/Chromium (`puppeteer-core` downloads no browser); set `CHROME_PATH` to override auto-detection. If no Chrome is found it **skips** (exit 0). This is an opt-in local check — it is not part of `npm test` and not a CI gate (a CI runner without Chrome would skip; for a real gated check use Playwright with a managed browser).

## Releases & distribution

This UI is shipped as a versioned, checksummed build artifact rather than committed into LOFT-Sim:

1. Pushing a `v*` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which runs the production build, packages `dist/` into `loft-ui-<tag>.tar.gz`, computes its SHA-256, and publishes both as GitHub Release assets.
2. LOFT-Sim pins an independent UI version in `loft/telemetry/web_ui_pin.py` and downloads + verifies that release at runtime (the first time the web UI is launched), caching it locally.

To adopt a new UI build in LOFT-Sim, cut a release here, then update the pinned version and SHA-256 on the LOFT-Sim side. Because the repo is public, the release assets download without authentication.

## Project layout

```
public/
  data/
    network/  air-corridor + map OSM files (default and demo presets)
    demand/   demand-flow JSON
    model/    drone glTF (falls back to a low-poly cone if absent)
src/
  data/       OSM/flow parsing, corridors, routes, projection
  geometry/   coordinate, corridor centerline/envelope, drone, map geometry
  layer/      scene layer builders (map, environment, corridor, drone)
  fleet/      fleet sources — frontend demo scheduling and telemetry-backed state
  telemetry/  websocket client and binary telemetry protocol
  scene/      FleetScene orchestration, control panel, labels, HUD readouts
  main.ts     entry point: selects data source and mounts FleetScene
  constant.ts shared tunables; types.ts core scene/UAV types
```

## Scene inputs

Files under `public/data/` are served by Vite at `/data/...` and copied into `dist/data/` during production builds. The default scene loads:

- `data/network/airspace_network.osm` — default air-corridor network (also defines the scene bounds, ground size, and initial camera)
- `data/network/map.osm` — buildings, roads, trees (optional; the scene renders from the airspace network alone when it is absent)
- `data/demand/flow.json` — default flow demand (standalone mode only)
- `data/model/quadrotor.gltf` — quadrotor UAV model (the one currently rendered for all UAVs)
- `data/model/fixedwing.gltf` — fixed-wing cargo UAV model (asset for future per-type rendering)
- `data/model/hybrid.gltf` — hybrid tilt-rotor VTOL cargo UAV model (asset for future per-type rendering)

Demo presets live alongside these: `two_air_corridor.osm` / `two_flow.json` and `stress_air_corridor.osm` / `stress_flow.json`. In telemetry-backed mode the network comes from the simulator's `/configs` and UAVs come from the websocket, so the bundled demand file is unused.

## Controls

The Tweakpane panel has three sections:

- **Config Files** — upload a custom map, air-corridor, or demand file and **Reload scene**.
- **Controls** — Play/Pause, a discrete speed-multiplier slider, Camera mode (`Free` / `Follow selected UAV`), visibility toggles (vertiports, corridors, routes, flight envelopes, buildings, roads, trees, labels), a **Shadows** on/off toggle (building/tree shadows plus drones' altitude-faded ground shadows), and **Reset simulation**.
- **Demo** — load the frontend-only **Two Corridors** or **Stress Test** preset (toggling off restores the default telemetry-backed scene).

Camera and selection:

- **Free mode:** right-drag to rotate, left-drag to pan, scroll to zoom, WASD/arrow keys to pan on the ground plane.
- **Follow mode:** chases the selected UAV from behind and above; requires a selection.
- **Selection:** left-click a UAV to select it; the HUD shows its ID, type, and corridor.

## Coordinate system

City-scale flat-earth projection: latitude → `x`, altitude → `y`, longitude → `z`. The shared origin is computed from corridor and map OSM nodes so all geometry aligns. The scene bounds and initial camera are derived from the airspace network — its node extent padded by 500 m on each side — and any base map is clipped to those bounds. The ground plane extends a further 250 m so the clipped map sits inside a margin of bare ground. Helpers live in `src/data/osm.ts` and `src/geometry/coordinates.ts`.
