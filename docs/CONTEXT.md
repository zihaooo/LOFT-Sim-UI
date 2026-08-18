# Project Context

This project is a Vite + TypeScript + Three.js frontend for visualizing a large UAV/UAM fleet in a 3D urban scene. It is the web front-end for **[LOFT-Sim](https://github.com/cherryh2021/LOFT-Sim)** (the Low-altitude Operations Fast-Time Simulator): the simulator owns the airspace network and vehicle state, and this app renders the fleet and provides interactive controls.

The app picks a data source at startup (see [Runtime Flow](#runtime-flow)):

- **Telemetry-backed (default).** The scene network is fetched from the simulator's `/configs` endpoint and live UAV state streams over a `/ws` websocket. This is what you get when LOFT-Sim serves the UI.
- **Standalone demo.** With no backend (e.g. `npm run dev`), it falls back to bundled assets under `public/data/` and schedules UAV departures in the browser from a demand-flow file. The control panel also offers frontend-only demo presets and custom file uploads.

`PLAN.md` describes the original MVP target; the implementation has since been refactored, so **this document uses the current code as the source of truth**. `RENDER.md` covers the load-time + per-frame rendering pipeline in detail.

## Current Stack

- Build/runtime: Vite, TypeScript, native ES modules.
- Rendering: Three.js; `three-mesh-bvh` + `three-bvh-csg` for flight-envelope geometry/CSG.
- Camera controls: `OrbitControls`.
- Control panel: Tweakpane (+ `tweakpane-plugin-file-import`).
- FPS panel: `stats.js`.
- Tests: Vitest.
- Local mock telemetry: `scripts/gen_mock_data.py` + `scripts/mock_ws_server.mjs`.

Important commands:

```sh
npm test          # Vitest
npm run build     # tsc + vite build → dist/
npm run dev       # dev server (standalone demo data)
npm run preview   # serve the production build
npm run mock:data # generate mock/mock_telemetry.json from a network file
npm run mock:ws   # serve it at ws://127.0.0.1:8765/ws
npm run verify:render # manual headless-Chrome render smoke-test (needs system Chrome; skips if absent)
```

## Data Sources and Inputs

`src/main.ts` resolves three source texts and hands them to `createSceneData`:

- `corridorOsm` — the air-corridor network (defines corridors, routes, vertiports, and the scene frame).
- `buildingOsm` — the optional base map (buildings, roads, trees); an empty string when absent.
- `flowJson` — demand flows (standalone mode only; empty in telemetry mode, where UAVs come from `/ws`).

Resolution order (`loadInitialSources`):

1. **Backend `/configs`** — returns `{ corridorOsm, buildingOsm? }`; only `corridorOsm` is required. Used in telemetry-backed runs.
2. **Bundled fallback** under `public/data/` when `/configs` is unavailable:
   - `network/airspace_network.osm` — default air-corridor network
   - `network/map.osm` — buildings/roads/trees (optional; a missing file renders the scene without them)
   - `demand/flow.json` — default demand
   - `model/quadrotor.gltf`, `model/fixedwing.gltf`, `model/hybrid.gltf` — per-vehicle-type UAV models, picked by telemetry `vehicleTypeCode` (1=quadrotor, 2=fixed-wing, 3=hybrid); each falls back to a low-poly cone if absent

Ground icon artwork lives outside `data/`, under `public/icons/` (`vertiport.svg` for vertiport terminals; `nav_site.svg`, `comm_site.svg`, `surv_site.svg` for CNS sites). These are always bundled — never supplied by the backend or by uploads — and are listed in `GROUND_ICON_ASSETS`.

Demo presets (frontend-only, dev builds): `two_air_corridor.osm` / `two_flow.json` and `stress_air_corridor.osm` / `stress_flow.json`. Uploaded files (dev "Config Files Override") replace any of the three source texts and reload the scene.

The **scene frame** (bounds, ground size, initial camera) is derived solely from `corridorOsm`: `computeSceneBounds` takes the airspace-network node extent padded by `BBOX_PADDING_METERS` (500m) on each side. `buildingOsm` is optional decorative content — when present, its buildings/roads/trees are clipped to that frame; when absent (empty string) only the ground plane and airspace layers render. An airspace network with no nodes throws (surfaced in the loading overlay).

The ground plane (and its grid) extends a further `GROUND_PADDING_METERS` (150m) beyond the scene bounds, so the clipped map sits inside a margin of bare ground rather than flush with the ground edge. This extra padding applies only to `createGroundGroup`; map clipping, the camera frame, and the UAV bounding sphere all stay on the scene bounds.

OSM/flow parsing and projection live in `src/data/`:

- `osm.ts` — `createSceneData`, the top-level orchestrator.
- `common.ts` — `parseOsm`, `projectGeoPoint`, `averageOrigin`, OSM node/way/relation types.
- `corridors.ts` — corridor extraction + connected-component grouping (`measurePolyline`, `isVertiportNode`).
- `routes.ts` — route extraction (relations stitched into one polyline).
- `map.ts` — buildings, roads, trees, and `computeSceneBounds` (the scene frame, from the airspace-network nodes).
- `vertiport.ts`, `cnsSite.ts`, `flows.ts` — vertiport markers, CNS sites, and demand flows.

## Scene Data Model

Core shared types are in `src/types.ts`. Telemetry DTOs are in `src/telemetry/protocol.ts`.

- `SceneData` — complete frontend scene payload: `origin`, `sceneBounds`, `corridors`, `routes`, `buildings`, `roads`, `trees`, `vertiports`, `sites`, `flows`.
- `AirPath` — a colored 3D polyline plus per-node metadata: `points`, `nodeIds`, `vertiportFlags`, `componentId`, `color`, `envelopeRadius`, `length`, `cumulativeLengths`, `from`/`to`/`name`/`id`. `AirCorridor` and `AirRoute` are both aliases of `AirPath`:
  - **Corridors** are ways carrying a `corridor_id` (the airspace schema's required gate tag), grouped into connected components by shared **non-vertiport** nodes (union-find in `assignCorridorComponents`). Vertiports are hard terminals that break connectivity. All corridors in a component share one color and fuse into one flight envelope.
  - **Routes** are relations carrying a `route_id`, whose member ways are stitched (in member order) into one polyline. **Each route is its own component**, so its envelope is built and colored independently of every other route and corridor.
  - Ids come from the simulator schema's stable tags — `corridor_id` for ways, `route_id` for relations, `node_id` for vertiports (e.g. `c3`, `r1`, `mair`) — never from the OSM-native element id, so they match what telemetry and demand flows reference. (Schema source of truth: `../LOFT-Sim-Airspace-Editor/schema/airspace_schema.json`; the pre-v1 `airspace=yes` / `object_type` / `object_id` vocabulary is no longer supported.)
- `BuildingFootprint`, `RoadPath`, `TreePoint`, `VertiportPoint` — static map geometry.
- `CnsSite` — an optional CNS ground station (`node_type` = `navigation_site` / `communication_site` / `surveillance_site`) with a `coverageRadius` in meters (0 = the node carried no usable `coverage_radius` tag, so it renders as a marker without a coverage dome).
- `FlowDefinition` — `flowId`, `routeId`, `uavPerHour`.
- `UavSchedule` vs `UavState` are intentionally separate:
  - `UavSchedule` is stable planned data (one planned departure).
  - `UavState` is derived per-frame state (position, tangent, distance, progress, status).

## Coordinate System

City-scale flat-earth projection:

- Latitude → local `x`.
- Elevation → local `y`.
- Longitude → local `z`.

The shared `ProjectionOrigin` is the `averageOrigin` of the corridor + building OSM nodes, computed once in `createSceneData` and passed to every parser so all geometry aligns. Helpers live in `src/data/common.ts` (`projectGeoPoint`, `averageOrigin`) and `src/geometry/coordinates.ts` (`toVector3`, `toScreenPosition`).

## Runtime Flow

`src/main.ts`:

1. Injects the DOM shell (`#scene-host`, `#label-layer`, `#hud-stats`, `#control-panel`, loading overlay).
2. `loadInitialSources()` — fetches `/configs`, falling back to bundled files.
3. `loadUavModels()` and `loadGroundIconTextures(ACTIVE_GROUND_ICONS)`, in parallel. Models: one per vehicle type (`quadrotor`/`fixedwing`/`hybrid`.gltf), each preserving its gltf materials and normalized to a per-type span (`DRONE_MODEL_SPAN_METERS_BY_TYPE`); a missing type falls back to a cone. Icon textures: each requested SVG rasterized into a `CanvasTexture`; a missing asset is fatal. Both are kept as long-lived masters — models are cloned per scene (the scene disposes materials), textures are shared as-is (nothing disposes them).
4. `createSceneData(corridorOsm, buildingOsm, flowJson)` → `SceneData`.
5. `mountScene()` → `new FleetScene({ …, telemetryUrl })`. `telemetryUrl` is set **only for the default scene** (`activeDemoPreset === null`); demo presets run frontend-only. Dev → `ws://127.0.0.1:8765/ws`; prod → `ws(s)://<host>/ws`.
6. The `FleetScene` constructor builds the fleet sources (a `DemoFleetSource` always; a `TelemetrySource` when `telemetryUrl` is present), the camera rig, all static scene groups, the control panel, readout panels, and labels.
7. `FleetScene.start()` registers resize/keyboard/pointer/context-menu handlers, calls `telemetrySource.start()`, and starts the animation loop.

Scene reloads (uploaded files) and demo-preset switches `dispose()` the current scene and mount a fresh one.

## Fleet Sources

`src/fleet/` defines the per-frame source of UAV instances. `FleetScene` owns the mesh, camera, labels, and readouts; a source only computes instance matrices/colors and maps render slots to selectable UAV ids.

- `source.ts` — the `FleetSource` interface: `update(ctx) → FleetFrame | null`, `resolveId(typeCode, instanceId)` (a pure slot→id lookup; FleetScene owns the click toggle/clear policy), `reset()`. `update` writes instances through `ctx.writer` (a `UavFrameWriter`; the concrete `UavInstanceWriter` lives in `uavInstanceWriter.ts`) into the per-type meshes. A `FleetFrame` carries `activeCount`, `scheduledCount` (number for demo, `null` for telemetry), `simTimeSeconds`, the reconciled `selectedUavId` / `selectedRouteId`, a follow-camera `selection` pose, `selectedUavState` (drives the selected UAV's label), and `selectedSummary`. The interface deliberately covers only this per-frame contract; lifecycle and debug affordances (`start`/`stop`/`setRunning`/`setSpeed`, `fleetSize`, `debugReadout`) are accessed on the two concrete sources FleetScene already holds typed fields for.
- `demoSource.ts` (`DemoFleetSource`) — renders the frontend fleet expanded from demand flows. Owns the pending/active schedule rosters and the kinematic sampling.
- `telemetrySource.ts` (`TelemetrySource`) — renders backend snapshots directly (no interpolation). Owns the `TelemetryClient` lifecycle and maps binary drone **handles** to the scene's stable string ids via the client registry.

Each frame, `FleetScene.updateFleet` runs telemetry first; if it returns a live frame, telemetry wins, otherwise the demo source renders. The source that produced the frame becomes `activeSource`, to which click selection is routed.

## Telemetry

`src/telemetry/`:

- `client.ts` (`TelemetryClient`) — manages the websocket connection (connection state, snapshot-rate/parse-time/dropped-frame stats, last error), a registry mapping binary handles → stable ids for drones/routes/corridors, and play/pause/speed commands to the backend.
- `protocol.ts` — decodes binary frames into a `TelemetrySnapshot` (`simTimeSeconds`, `sequence`, `drones[]`); each `TelemetryDroneState` carries a handle, position/velocity, `stateCode`, route/corridor handles, and vehicle type.

## Simulation Behavior

**Demo source.** `createFleet()` expands each `FlowDefinition` into one `UavSchedule` per planned departure across an hourly cycle. UAVs are scheduled once, fly a single one-shot pass, and are destroyed on route completion or first ground contact after takeoff. A selection pointing at a UAV destroyed this frame is cleared (returned as `""`), never echoed back as a zombie id. The source maintains:

- `pendingUavIndices` — sorted by departure time (the dispatch queue).
- `activeUavIndices` — currently-flying schedule indices.
- `slotToFleetIndexByType` — maps a visible (vehicle type, instance slot) back to a schedule index for click selection (the demo fleet only populates the quadrotor type).

**Telemetry source.** Renders the latest snapshot's live drones each frame; the backend owns position/velocity/status. UAVs appear and disappear as the stream dictates; each drone is written into the mesh for its `vehicleTypeCode`, and `slotToHandleByType` maps a visible (vehicle type, instance slot) back to drone handles. Unlike the demo source, a selection whose drone is merely absent from the current snapshot is kept — the drone may return on a later snapshot, and a still-streaming prior handle survives a registry id remap.

## Rendering Strategy

(Full pipeline in `RENDER.md`.)

- **Static map** is built once and clipped to the scene bounds (buildings/roads by polygon clip, trees by point test): buildings merged into one mesh; roads into one opaque vertex-colored mesh (the material uses `depthWrite:false` so coplanar quads at intersections/corners don't z-fight each other); trees as two instanced meshes (trunk + canopy). The ground plane is static; the reference **grid** is a separate `LineSegments` layer (`createGrid`) with its own visibility toggle and a user-adjustable line spacing (the initial spacing is derived from the scene bounds via `initialGridSpacingIndex`, and changing it disposes and rebuilds only the grid's line geometry). The ground material carries a small `polygonOffset` so the coplanar grid lines reliably win the depth test at every distance.
- **Underground clipping**: the renderer is given a single global clipping plane just below the ground (`new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.1)`, keeping `y ≥ −0.1 m`), so any sub-surface geometry — notably the buried envelope ground-terminal stubs — is hidden. Because this also removes the sky dome's lower hemisphere, `SCENE_BACKGROUND_COLOR` is set equal to `SKY_DOME_COLOR` so the exposed background below the horizon blends in seamlessly. Global clipping applies to every material regardless of `localClippingEnabled`.
- **Corridors**: all centerlines batched into one fat-line (`LineSegments2`) draw + one direction-cone `InstancedMesh`. Flight envelopes are merged into one watertight, uniform-opacity translucent solid per connected component (chain polylines Douglas-Peucker-simplified, then bisector-miter tubes; CSG only at true junctions and at bends too sharp to miter — smoothed networks otherwise leave sharp corridor joints flanked by short sample segments, folding the tube into fins).
- **Routes**: one subgroup per route (`route:<id>`), each with its own centerline + envelope child, so the selected route can be shown alone.
- **Vertiports**: camera-oriented ground decals, one client of the shared **ground icon** layer (`src/geometry/groundIcon.ts` + `src/layer/groundIcon.ts`). Icon artwork is an SVG under `public/icons/`, rasterized once at startup into a shared `CanvasTexture`; `src/layer/vertiport.ts` holds only the vertiport-specific footprint and placement. Adding an icon type is an entry in `GROUND_ICON_ASSETS` plus a caller. **Asset convention:** an icon must be a circular badge filling its viewBox — it is mapped onto a `CircleGeometry` disc so the mesh is the artwork's silhouette, which is what lets the material stay fully opaque (no alpha test, no alpha-to-coverage) and keeps the rim antialiased by plain MSAA.
- **CNS sites** (`src/layer/cnsSite.ts`): optional navigation / communication / surveillance ground stations. Each site gets a ground marker (the second client of the ground icon layer, one marker group per category so each keeps its own badge texture), and each site with a `coverage_radius` also gets a fog-free ground **ring** at the exact extent plus **two mutually exclusive dome treatments** of the same coverage volume, selected by the **CNS Sites** mode (`Off` / `Intensity` / `Coverage`, default Coverage; disabled when the network carries no sites). Each treatment lives in its own subgroup so switching modes flips visibility flags; markers and rings accompany both visible modes, and everything takes the category's color (`CNS_SITE_COLORS`, matching the icon accents).
  - **Intensity** — the signal-strength read: a unit proxy sphere scaled to the radius, drawn back-face with a small `ShaderMaterial` whose fragment alpha is the closed-form line integral of a dB-linear signal density (∝ `ln(coverage_radius / r)`, the remaining log-distance link margin, zero at the radius) over the ray's segment through the volume ball ∩ above-ground ∩ padded ground rectangle, so the tint concentrates at the site, falls off logarithmically to zero at the rim, and never counts coverage below ground or past the map edge — works with the camera outside *or inside* the dome (where it usually is; the radii are scene-sized). The fog renders without a depth test, so objects inside the coverage are veiled rather than punched out as untinted cutouts — the veil is the ray's full column, a subtle overcount accepted for its simplicity. The map-edge cut lives on the integration segment, because a fragment's alpha carries a whole ray column.
  - **Coverage** — the effective-range read: a faint double-sided translucent shell, answering "is this corridor inside coverage?" at a glance where the fog stays deliberately analytic. Its map-edge cut is baked into the geometry: each site's range sphere is intersected with a box over the padded ground rectangle at build time (`three-bvh-csg`, the same CSG pipeline the envelopes use), so where coverage crosses the map edge the shell closes with a flat vertical wall — plane-clipping the hollow surface instead would open arch-shaped holes exposing the interior. The box floor sits below the global below-ground clipping plane, which trims the walls flush with the ground and leaves no floor cap to z-fight the map. The shell depth-tests normally, so opaque geometry in front of the shell wall occludes it.
- **UAVs**: one `THREE.InstancedMesh` per vehicle type (quadrotor/fixed-wing/hybrid), each rendered with the model's **own gltf materials**. A drone is written into the mesh for its `vehicleTypeCode` (unknown → quadrotor; the demo fleet is all quadrotor). Per-mesh capacity = `max(demo fleet size, TELEMETRY_UAV_MESH_CAPACITY = 10_000)` (so the buffers are ~3× a single mesh, since any one type could be the whole fleet). A shared `UavInstanceWriter` sets each mesh's `count` and uploads only active matrix/color ranges per frame, skipping meshes with no instances. The per-instance color carries **selection only**: the selected drone is painted solid red via a material patch (the instance color *overrides* the base color under the fragment's `USE_COLOR` define); every other drone shows its model materials.
- **Lighting & shadows** (`createLightingGroup`): a `HemisphereLight` (ambient fill) plus one shadow-casting `DirectionalLight` (the sun). At construction the sun is re-centered on the scene (its `SUN_OFFSET` is added to the `sceneBounds` center, not the world origin), and `fitShadowCameraToBounds` fits the orthographic shadow frustum to `sceneBounds` × `SHADOW_SCENE_HEIGHT_METERS` by projecting the scene box's eight corners into light-view space and taking their extent (plus a `SHADOW_FIT_MARGIN` pad). This keeps the whole scene inside the frustum and every shadow-map texel well-spent regardless of which preset/extent is loaded — a fixed frustum either clipped the larger presets or wasted resolution on the smaller ones. The **Shadows** control toggles the shadow pass off at runtime.
- **Drone shadows (blob layer)**: drones do **not** cast into the shadow map — their small, thin, fast geometry aliases into the city-scale map and shimmers. Instead, one shared `InstancedMesh` of flat ground decals (`createBlobShadowMesh`) draws a shadow per visible drone, written by `UavInstanceWriter` alongside the drone instances — **oriented to the drone's heading** and **projected along the sun's parallel rays** onto the receiving surface (`surfaceHeightAt`, v1 = flat ground at 0). The **shape** is a per-type composite of rectangles fitted to each model's silhouette (quad: square body + two diagonal arm bars = an X; fixed-wing/hybrid: wing + fuselage + horizontal stabilizer, plus the fixed-wing's twin booms; spinning props/rotors get no rect). Those rects are precomputed offline from the glTF box geometry by `scripts/compute_shadow_params.py` → `public/data/model/shadow_profiles.json`, then baked as GLSL constants into the blob material's fragment shader by `layer/shadowProfiles.ts` (no uniforms), where they are **smooth-min-unioned in signed-distance space** (so joints round over instead of creasing) and given one soft edge. `instanceColor` carries data, not colour: `.r` = altitude-fade opacity, `.g` = the per-type profile index. Size grows and opacity fades with altitude (gone by `BLOB_SHADOW_FADE_HEIGHT_METERS`; faint/high blobs culled), mimicking how a small high object loses its ground shadow. Limitation: a flat-ground decal shows no shadow on building rooftops (it's occluded under the building); the `surfaceHeightAt` seam is where a building height field would later land rooftop shadows (which, with the angled projection, needs a ray-march, not a single lookup).

## Control Panel

`src/scene/control.ts` builds the Tweakpane panel over a shared mutable `SimulationControlState`. Three sections:

- **Controls** — Play/pause, discrete speed slider (`1x`, `2x`, `5x`, `10x`, `100x`), Camera mode (`Free` / `Follow selected UAV`), a **CNS Sites** mode dropdown (`Off` / `Intensity` / `Coverage` — Intensity and Coverage are exclusive readings of the same coverage volume, and a selector states that rule by its shape instead of two checkboxes enforcing it on each other), visibility toggles (Vertiports, Corridors, Selected route, Envelopes, Buildings, Roads, Trees, Grid, Labels), a Grid Size slider, a Shadows on/off toggle, Reset view, Reset simulation. Reset view is a pure client-side camera action (no backend dependency), so unlike the dev-only Reset simulation it stays available in every build. Corridors and the route overlay are mutually exclusive. The CNS Sites/Buildings/Roads/Trees controls are disabled when their layer rendered no geometry (e.g. no map, no site nodes in the network, or the map clipped entirely outside the scene bounds). The **Grid Size** slider sets the reference grid's line spacing; like the speed slider it is an *index* into a fixed `GRID_SPACING_TICKS` array (the ticks aren't evenly spaced, so a raw-value slider couldn't snap to them), its initial index is derived from the scene bounds, and it is greyed out while the Grid toggle is off. Shadows is a render toggle rather than a layer toggle: it flips `renderer.shadowMap.enabled` (flagging every material for shader recompile, otherwise the change wouldn't take effect) **and** hides the drone blob-shadow layer, so it governs every shadow in the scene — turning it off skips the per-frame shadow pass entirely.
- **Config Files Override** (dev only) — upload a map / corridor / demand file and reload the scene.
- **Demo** (dev only) — load the frontend-only Two Corridors or Stress Test preset (toggling off restores the default telemetry-backed scene).

`SimulationControlState` is co-owned: Tweakpane writes it on user input; `FleetScene` reads it every frame and also writes `selectedUavId` / `cameraMode`. Speed/play changes are forwarded to the telemetry source as backend commands.

## Camera, Interaction, Selection, Labels

All camera behavior lives in `scene/cameraRig.ts` (`CameraRig`): the initial framing, keyboard pan, follow mode, the reset-view tween, and the above-ground clamp. `FleetScene` calls `cameraRig.update(delta, selection)` once per frame and routes key events and the Reset buttons to it.

- **Free mode**: right-drag rotate, left-drag pan, scroll zoom, WASD/arrow keys pan on the ground plane.
- **Follow mode**: chases the selected UAV from behind/above; snaps on entry or selection change, then trails by the per-frame position delta. Requires a selection.
- **Reset view**: `cameraRig.resetView()` eases `camera.position` and `controls.target` from their current pose back to the initial framing over `RESET_VIEW_DURATION_SECONDS` with an ease-in-out cubic. It forces Free mode on entry (else Follow would drive the camera and fight the tween) and suspends `OrbitControls` for the flight so a stray drag can't fight it.
- **Selection**: left-click raycasts all per-type UAV meshes; the hit mesh's vehicle type and instance id are resolved through `activeSource.resolveId(typeCode, instanceId)` to the canonical id, and `FleetScene` applies the toggle/clear policy (clicking the already-selected UAV clears). The selected UAV is painted solid red and summarized in the HUD.
- **Labels**: one corridor label per corridor, plus a single lazily-created label for the selected UAV. Driven by the Labels toggle. Corridor anchors are static, so their projection is gated: labels re-project only when the camera matrix, viewport, or visibility flags changed since the last frame.

## Known Technical Debt

Resolved in the 2026-07-05 cleanup pass (anchor for git history): the FleetScene god-object was trimmed (camera behavior → `scene/cameraRig.ts`, per-frame readout writes → `scene/readouts.ts`); `FleetFrame.uavStateById` (a full per-UAV map with a single-entry consumer) became `selectedUavState`; `AirPath` dropped its unread `geoPoints`/`segmentLengths`; a demo selection now clears when its UAV is destroyed instead of lingering as a zombie id; corridor-label projection is gated on camera/visibility change; and the narrow `FleetSource` interface is documented as an accepted decision (see Fleet Sources), not debt.

Still true:

- `FleetScene` remains the orchestration hub (~650 lines wiring fleet, rendering, and UI together). Livable at the current scope; extract further only when one concern grows.
- A recycled telemetry handle could briefly steal the selection if the backend reuses a handle whose old id is still selected before the registry catches up.
- Per-corridor visibility/recolor needs a full rebuild of the merged centerline/envelope buffers.
- Shadows are on by default (user-toggleable and frustum-fitted to the scene); buildings/trees still cast into the shadow map (a standing GPU cost when enabled), while drones use the cheaper blob layer instead.

## Future Feature Notes

- **Corridor coverage highlight** — the direct sequel to the CNS Coverage mode: color corridor segments by whether they lie inside any site's effective range, so "is the corridor covered?" is answered on the corridor itself instead of by eyeballing shells. The pieces already line up: corridor points and site positions share the metric scene frame; coverage is a static per-vertex `distance(point, site.position) < site.coverageRadius` test computable at build time; and the merged corridor centerline already carries a per-vertex color buffer (`src/layer/airPath.ts`), so baking coverage-derived colors into that buffer costs zero extra draw calls (a per-vertex attribute + custom line shader is the fallback if the base colors must survive for other states). Scale caveat: the current site radii (1.3–1.5 km) nearly span the demo scene, so most of the network classifies as covered unless the radii are retuned.

## Open Design Questions

- For sparse telemetry ticks, does the frontend need interpolation/prediction, or is latest-state rendering enough?
- What is the expected maximum active UAV count, and how should an overflow past `TELEMETRY_UAV_MESH_CAPACITY` be handled (grow vs. drop with a warning)? The cap is now allocated **per vehicle type** (each type's mesh sized for the whole fleet), so the worst-case allocation is `types × cap`; a shared budget or per-type sizing from observed counts could reclaim that.
- Can UAVs change route after creation? Can routes/buildings/roads/trees change during a running simulation?
- What should happen to follow mode and the HUD when the selected UAV is destroyed?
- Is simulation speed authoritative on the backend, or a local playback control over buffered snapshots?
