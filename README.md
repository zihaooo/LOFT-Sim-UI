# LOFT Sim UI

A browser-based 3D visualization for large UAV/UAM fleet simulation in an urban scene, built with Three.js.

The app supports two visualization modes:

- **Demo mode** *(current)* — loads local OSM map and demand flow assets, schedules UAV departures in the frontend, and animates the fleet along predefined air corridors.
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
public/
  data/
    demand/  flow definition JSON (demand inputs)
    map/     OSM map and air-corridor files
    model/   optional drone glTF
src/
  animation/ fleet simulation tick logic
  data/      OSM parsing and projection
  geometry/  coordinate, corridor, drone, and map geometry helpers
  layer/     scene layer builders (environment, map, corridor, drone)
  scene/     FleetScene orchestration, labels, HUD readouts
  types/     shared DTO types
  main.ts    entry point: loads assets and starts FleetScene
  types.ts   core scene/UAV types
```

## Scene Inputs

Files under `public/data/` are served by Vite at `/data/...` in the browser and copied into `dist/data/` during production builds. `src/main.ts` loads these default scene assets:

- `public/data/map/air_corridor.osm` — default air-corridor network
- `public/data/map/map.osm` — buildings, roads, trees
- `public/data/demand/flow.json` — default flow demand
- `public/data/model/drone.gltf` *(optional)* — falls back to a low-poly cone if missing

Demo presets live alongside the default files, including `two_air_corridor.osm` / `two_flow.json` and `stress_air_corridor.osm` / `stress_flow.json`.

## Controls

The Tweakpane panel exposes:

- Play / Pause and a discrete speed slider (`1x`, `2x`, `5x`, `10x`, `100x`)
- Camera mode: `Free` or `Follow selected UAV`
- Visibility toggles for corridors, flight envelopes, buildings, roads, trees, and labels
- Reset simulation

Camera and selection:

- **Free mode:** right-drag to rotate, left-drag to pan, scroll to zoom, WASD/arrow keys to pan on the ground plane.
- **Follow mode:** chases the selected UAV from behind and above; requires a selected UAV.
- **Selection:** left-click a UAV in the scene to select it; the HUD shows its ID, type, and corridor.

## Coordinate System

City-scale flat-earth projection: latitude → `x`, altitude → `y`, longitude → `z`. The shared origin is computed from corridor and map OSM nodes so all geometry aligns. Helpers live in `src/data/osm.ts` and `src/geometry/coordinates.ts`.

## Status

Implemented: static scene rendering, instanced UAV mesh, click selection, follow camera, label management, and a number of fleet/render optimizations.

Not yet implemented: backend connection, real-time network updates, physics, collision avoidance, weather, corridor editing, persistence. 
