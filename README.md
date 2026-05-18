# LOFT Sim UI

A browser-based 3D visualization for large UAV/UAM fleet simulation in an urban scene, built with Three.js.

The app supports two visualization modes:

- **Demo mode** *(current)* — loads local OSM map and demand flow assets, schedules UAV departures in the frontend, and animates the fleet along predefined air routes.
- **Backend mode** — connects to an external simulation backend that owns UAV state; the frontend focuses on rendering and interaction.


## Stack

- **Build/runtime:** Vite + TypeScript (native ES modules)
- **Rendering:** Three.js
- **UI:** Tweakpane (control panel), `stats.js` (FPS overlay)
- **Tests:** Vitest

## Getting Started

```sh
npm install
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # type-check and produce a production build in dist/
npm run preview  # serve the production build
npm test         # run the Vitest suite
```


## Project Layout

```
asset/
  demand/    flow definition JSON (demand inputs)
  map/       OSM map and air-route files
  model/     optional drone glTF
src/
  animation/ fleet simulation tick logic
  data/      OSM parsing and projection
  geometry/  coordinate, route, drone, and map geometry helpers
  layer/     scene layer builders (environment, map, route, drone)
  scene/     FleetScene orchestration, labels, HUD readouts
  types/     shared DTO types
  main.ts    entry point: loads assets and starts FleetScene
  types.ts   core scene/UAV types
```

## Scene Inputs

`src/main.ts` loads these static assets:

- `asset/map/stress_air_route.osm` — air routes
- `asset/map/map.osm` — buildings, roads, trees
- `asset/demand/stress_flow.json` — flow demand
- `asset/model/drone.gltf` *(optional)* — falls back to a low-poly cone if missing

Smaller demo files (`air_route.osm`, `flow.json`) live alongside the stress assets.

## Controls

The Tweakpane panel exposes:

- Play / Pause and a discrete speed slider (`1x`, `2x`, `5x`, `10x`, `100x`)
- Camera mode: `Free` or `Follow selected UAV`
- Visibility toggles for routes, flight envelopes, buildings, roads, trees, and labels
- Reset simulation

Camera and selection:

- **Free mode:** right-drag to rotate, left-drag to pan, scroll to zoom, WASD/arrow keys to pan on the ground plane.
- **Follow mode:** chases the selected UAV from behind and above; requires a selected UAV.
- **Selection:** left-click a UAV in the scene to select it; the HUD shows its ID, type, and route.

## Coordinate System

City-scale flat-earth projection: latitude → `x`, altitude → `y`, longitude → `z`. The shared origin is computed from route and map OSM nodes so all geometry aligns. Helpers live in `src/data/osm.ts` and `src/geometry/coordinates.ts`.

## Status

Implemented: static scene rendering, instanced UAV mesh, click selection, follow camera, label management, and a number of fleet/render optimizations.

Not yet implemented: backend connection, real-time network updates, physics, collision avoidance, weather, route editing, persistence. 