# Rendering Pipeline

This document describes the full rendering pipeline for LOFT-Sim-UI, broken down into the two big phases — **load-time scene assembly** (runs once) and **per-frame render loop** (runs at ~60 Hz). For each step the input, output, and where the data lives (CPU memory vs. GPU buffers / cache) are noted.

The app runs in one of two data modes (chosen at startup, see Phase A Step 2): **telemetry-backed** (scene network from the backend `/configs`, live UAV state over a `/ws` websocket) and **standalone demo** (bundled assets, UAVs scheduled in the browser). The rendering pipeline below is identical in both; only the *source of UAV instances* differs (Phase B Step 2).

---

## Phase A — Load-time pipeline (runs once at startup)

### Step 1. DOM bootstrap (`src/main.ts`)
- **Input**: `index.html` mounts a `#root` div.
- **Action**: `main.ts` injects the static shell — `#scene-host` (Three.js canvas host), `#label-layer` (HTML overlay), `#hud-stats`, `#control-panel`, a help panel, and a `#loading-overlay`. Then calls `start()`.
- **Output (CPU memory)**: DOM tree containing the anchor elements.
- **GPU**: nothing yet.

### Step 2. Source resolution (`main.ts` → `loadInitialSources`)
- **Input**: none (or the backend, if present).
- **Action**: resolves three source texts — `corridorOsm`, `buildingOsm`, `flowJson`:
  - **Telemetry-backed (default)**: `GET /configs` returns `{ corridorOsm, buildingOsm }`; `flowJson` stays empty because UAVs arrive over the websocket, not from a demand file.
  - **Standalone fallback** (when `/configs` is unavailable, e.g. `npm run dev`): parallel `fetch` of `/data/network/airspace_network.osm`, `/data/network/map.osm`, `/data/demand/flow.json` via `loadText()`.
- **Output (CPU memory)**: three raw text strings.
- **HTTP cache**: the browser caches responses by URL/ETag; subsequent reloads hit the disk cache.
- (Demo presets and uploaded config files are scene *reloads* — see Side channels.)

### Step 3. Scene-data construction (`createSceneData` in `src/data/osm.ts`)
- **Input**: the three text payloads.
- **Action**: parses corridor and building OSM into `{nodes, ways, relations}` (`data/common.ts`), computes one shared `averageOrigin` from the corridor nodes (network-only, so scene coordinates do not depend on the background map), then builds:
  - `parseAirCorridors` → ways carrying a `corridor_id` (the airspace schema's gate tag), grouped into connected components by shared non-vertiport nodes (union-find).
  - `parseRoutes` → relations carrying a `route_id`, stitched into one polyline each (each route is its own component).
  - `parseBuildings`, `parseRoads`, `parseTrees`, `parseMapBounds` from the building OSM.
  - `parseVertiports` from the corridor OSM.
  - `parseContingencySites` from the corridor OSM — optional standalone contingency landing sites (`node_type=cont_site`); markers are pinned to the ground plane (the `altitude` tag is ground elevation, not a marker height) and sim-side tags (`max_landing_rate_per_hour`, `vehicle_access`) are ignored.
  - `parseCnsSites` from the corridor OSM — optional navigation/communication/surveillance ground stations (`node_type` in `CNS_SITE_TYPES`) with a `coverage_radius` in meters (0 when the tag is missing or unusable → marker only, no dome).
  - `parseFlowDefinitions(flowJson)` → demand specs (empty in telemetry mode).
  - The shared `ProjectionOrigin` keeps everything aligned (`lat→x, elevation→y, lon→z`).
- **Output (CPU memory)**: a single `SceneData` object — the canonical immutable scene description used for the rest of the lifetime.
- **Cache**: none persistent; lives only in JS heap.

### Step 4. Asset preload (`loadUavModels()` + `loadGroundIconTextures()`)
Both run in parallel from `main.ts` behind the loading overlay, and both produce **long-lived masters** that outlive any single `FleetScene`.

**UAV models** (`loadUavModels()` from `src/geometry/drone.ts`)
- **Input**: one gltf per vehicle type — `/data/model/{quadrotor,fixedwing,hybrid}.gltf` (each optional; HEAD-checked, and HTML responses are rejected so a dev-server fallback page isn't mistaken for a model).
- **Action**: for each, loads the GLTF, bakes world transforms, merges its meshes into one geometry **with per-material groups** (so the model's own materials survive), and normalizes it (centered, scaled so its widest horizontal span matches the type's `DRONE_MODEL_SPAN_METERS_BY_TYPE` entry, rotated to face forward).
- **Output**: a `Map<vehicleTypeCode, { geometry, materials }>`. A type whose asset is missing is simply absent → `createFallbackUavGeometry()` (a forward-pointing cone) is used for it later in `createUavMesh`. `main.ts` keeps these as long-lived masters and hands each `FleetScene` a `cloneUavModels()` copy, because a scene disposes its own geometry/materials on teardown.
- **Memory**: vertex data on the JS heap until uploaded to a VBO on first render.

**Ground icon textures** (`loadGroundIconTextures(keys)` from `src/geometry/groundIcon.ts`)
- **Input**: the icon keys `main.ts` lists in `ACTIVE_GROUND_ICONS` (the vertiport and contingency site badges plus the three CNS site badges), resolved through `GROUND_ICON_ASSETS` to SVG paths under `public/icons/`. Only the requested keys are fetched, so an authored-but-unplaced icon costs no texture memory.
- **Action**: fetches the SVG text, stamps `GROUND_ICON_TEXTURE_SIZE` into the `<svg>` root's `width`/`height` (an `<img>` rasterizes at the *declared* size, so the assets' authored `32` would bake a 32px bitmap to upscale), loads it as a data-URI `Image`, `drawImage`s it into a canvas at that size, and wraps the canvas in a `CanvasTexture` with sRGB color space and `GROUND_ICON_ANISOTROPY`. The browser's SVG renderer does the painting, so artwork is a declarative asset rather than imperative canvas code.
- **Output**: a `Map<GroundIconKey, CanvasTexture>`, each with `CanvasTexture`'s inherited full mipmap chain (`minFilter` `LinearMipmapLinear`, `generateMipmaps`) — the chain plus anisotropy is what keeps a fine-lined marker stable when the camera pulls back. Unlike the UAV models these are **not** cloned per scene and are never disposed: scene teardown disposes geometries and materials only (`Material.dispose()` does not touch textures), so a rebuilt scene re-creates its icon materials around the same shared textures.
- **Failure**: a missing asset rejects rather than degrading, so `start()`'s catch surfaces it on the loading overlay.

### Step 5. Fleet source construction (`FleetScene` constructor)
The fleet is no longer expanded by `main.ts`; the `FleetScene` constructor builds one or two **fleet sources** (`src/fleet/`), each of which writes UAV instances (via a shared `UavInstanceWriter` over the per-type meshes) each frame:
- **`DemoFleetSource`** (always present) — runs `createFleet(routes, flows)` (`src/fleet/demoFleet.ts`), expanding each `FlowDefinition` into N `UavSchedule` records (`uavPerHour` → evenly-spaced `departureTimeSeconds` over a cycle). Schedule is **stable planned data**, not state. It also holds the dispatch/active rosters (`pendingUavIndices` sorted by departure time, `activeUavIndices`).
- **`TelemetrySource`** (only for the default telemetry-backed scene) — constructs a `TelemetryClient` (`src/telemetry/client.ts`) over the `/ws` websocket. The client receives a JSON `registry` message (handle→id maps + simulator projection) and binary snapshot frames, buffering the latest few (Side channels).
- **Output (CPU memory)**: `demoSource.fleet: UavSchedule[]` + `fleetById`, the roster index arrays, and (in telemetry mode) the live `TelemetryClient` and its snapshot buffer.

### Step 6. Static scene assembly (`FleetScene.buildScene` + layer builders)
This is where most of the heavy GPU upload happens — once.

| Sub-step | Input | Output (Three.js objects) | Notes about memory/GPU |
|---|---|---|---|
| 6a. Background / fog | `SCENE_BACKGROUND_COLOR`, fog distances | `scene.background`, `scene.fog` | Renderer uniforms only. `SCENE_BACKGROUND_COLOR` is deliberately equal to `SKY_DOME_COLOR` (see 6c + **Underground clipping** below) |
| 6b. Lighting (`createLightingGroup(sceneBounds)`) | `sceneBounds` + constants | `HemisphereLight` + shadow-casting `DirectionalLight` (sun re-centered on the scene via `SUN_OFFSET`) | Sun has its own shadow-map render target (`SUN_SHADOW_MAP_SIZE`² = 2048²) allocated on GPU. Its orthographic frustum is **fitted to the scene** by `fitShadowCameraToBounds` (scene box × `SHADOW_SCENE_HEIGHT_METERS`, projected into light space, padded by `SHADOW_FIT_MARGIN`) rather than a fixed ±bounds, so coverage tracks the loaded preset. Toggleable at runtime via the Shadows control |
| 6c. Sky dome (`createSkyDome`) | radius constant | inward-facing `SphereGeometry` (`BackSide`, `fog:false`) | One small VBO/IBO. The global below-ground clipping plane removes its lower hemisphere; the background matches the dome color so the exposed seam below the horizon is invisible |
| 6d. Ground + grid | padded ground bounds (`gridBounds`) | A `PlaneGeometry` rotated to XZ (`receiveShadow`) via `createGroundGroup`, plus a **standalone** `LineSegments` reference grid (`createGrid`) at user-selectable line spacing (initial pick from scene bounds via `initialGridSpacingIndex`) | Static VBO/IBO uploaded once; the grid is `transparent depthWrite:false` and its own scene layer — toggled independently, and changing **Grid Size** disposes + rebuilds only its line geometry (`setGridSpacing`). The ground material carries a small `polygonOffset` so the coplanar grid lines win the depth test at every distance |
| 6e. Buildings (`createBuildingGroup`) | `BuildingFootprint[]` | Each footprint `ExtrudeGeometry`'d individually then **`mergeGeometries`** into a single `Mesh` (`castShadow` + `receiveShadow`) | One VBO/IBO for the whole city → one draw call. Per-footprint geometries disposed after merge to free heap |
| 6f. Roads (`createRoadGroup`) | `RoadPath[]`, bounds | One vertex-colored mesh: each polyline segment becomes a quad, **Sutherland-Hodgman-clipped** to the scene bounds (`clipHorizontalPolygonToBounds`), all stuffed into shared `position`/`color`/`index` buffers | Single draw call, `MeshBasicMaterial vertexColors depthWrite:false side:DoubleSide polygonOffset:-2 renderOrder:1` (opaque pass): `polygonOffset` lifts the road over the ground, and `depthWrite:false` keeps coplanar quads at intersections/corners from z-fighting each other |
| 6g. Trees (`createTreeGroup`) | `TreePoint[]` | Two `THREE.InstancedMesh`es (trunk cylinder + canopy icosahedron). Per-tree matrix via `setMatrixAt`, per-tree canopy HSL color via `setColorAt` | Two draw calls regardless of tree count. `instanceMatrix` (+ canopy `instanceColor`) live in their own GPU buffers; both cast + receive shadow |
| 6h. Ground icons (`createVertiportGroup` / `createContingencySiteGroup` / `createCnsSiteLayer` → `createGroundIconGroup`) | `VertiportPoint[]` / `ContingencySite[]` / `CnsSite[]` + the preloaded icon textures | One flat `CircleGeometry` ground disc per marker; within a marker group (vertiports, contingency sites, or one group per CNS site category) all discs share **one** geometry + **one** material (`MeshBasicMaterial`). The marking is an **SVG asset** under `public/icons/`, rasterized once at startup into a `GROUND_ICON_TEXTURE_SIZE`² `CanvasTexture` (Phase A Step 4) and shared across scene rebuilds. **Asset convention:** every icon is a circular badge that *fills* its viewBox, because the disc is the artwork's silhouette. An SVG stroke straddles its path, so the outer circle's radius must be `half-viewBox − stroke-width / 2` (e.g. `r=14.5` with `stroke-width=3` in a 32-unit box), not `half-viewBox − stroke-width`. Spun upright per frame (Phase B Step 5) | `renderOrder = GROUND_ICON_RENDER_ORDER` (1). **Fully opaque** — the disc samples only the painted badge, never a transparent texel, so no `alphaTest`/`alphaToCoverage` is involved and the rim is a polygon edge that plain MSAA antialiases. Any alpha cut-out here would dither the ground and road through the icon, because alpha-to-coverage turns sampled alpha into a per-sample coverage mask and mipmapped alpha drops below 1 across the badge as the marker shrinks. `depthFunc:AlwaysDepth` (ignores buildings) + `depthWrite` + `polygonOffset:-4` so roads/ground stay below it but the airspace layer (order 2) still occludes it |
| 6i. Air-path centerlines (`createCorridorGroup` / `createRouteGroup`) | `AirCorridor[]` (corridors) and `AirRoute[]` (routes) | Corridors: every centerline batched into **one** fat-line `LineSegments2` (`LineMaterial`, per-vertex component color) plus **one** `InstancedMesh` of direction cones over a shared `ConeGeometry`. Routes: built per-route instead (one `route:<id>` subgroup each — its own centerline + cones + envelope child) so a single route can be shown/recolored alone. Mechanics detailed in **Air-path geometry — centerlines & flight envelopes** below. | Corridor layer = 2 draws (1 line batch + 1 cone batch) regardless of corridor count. `LineMaterial` strokes in screen pixels, so it needs the viewport resolution — refreshed by `FleetScene.resize` |
| 6j. Flight envelopes (`createFlightEnvelopeGroup`) | `AirCorridor[]` / `AirRoute[]` | **One** watertight, uniform-opacity translucent solid per connected component: chain polylines are Douglas-Peucker-simplified, bisector-miter tubes weld the degree-2 chains, and CSG (`three-bvh-csg`) fuses a sphere at each true junction and at each bend too sharp to miter; components with neither skip CSG entirely. All component solids `mergeGeometries`'d into one vertex-colored mesh. Mechanics detailed in **Air-path geometry — centerlines & flight envelopes** below. | Corridor envelope layer = 1 draw call. `MeshStandardMaterial transparent opacity:0.1 depthWrite:false side:DoubleSide`; transparent pass. Each route's envelope is its own solid (own component) |
| 6k. UAV meshes (`createUavMesh`, one per vehicle type) | per-type model (geometry + materials) | One `THREE.InstancedMesh` **per vehicle type**, each with the model's own materials (a cone + default material when a model is absent); `instanceMatrix` + a pre-allocated `instanceColor`, both `DynamicDrawUsage`, `mesh.count = 0`. Drones do **not** cast into the shadow map (`castShadow = false`) — their thin, fast geometry aliases/shimmers in the city-scale map; their ground shadow is the blob layer (6l). Each material is patched (`onBeforeCompile`) so the instance color *overrides* the base color under `USE_COLOR` (the selection highlight). `frustumCulled = false` and a per-mesh **static bounding sphere** (map bounds + all corridor points) so raycast selection doesn't depend on stale moving-instance bounds | Per-mesh capacity = `max(demo fleet size, TELEMETRY_UAV_MESH_CAPACITY = 10_000)`. Only the dynamic buffers are re-uploaded each frame. `renderOrder = AIRSPACE_RENDER_ORDER` (2) |
| 6l. Drone blob shadows (`createBlobShadowMesh`) | drone world positions + per-type rect profiles (`shadow_profiles.json`) | **One** shared `THREE.InstancedMesh` of a flat unit quad (`PlaneGeometry` baked into XZ), one instance per visible drone written by `UavInstanceWriter`: position = the drone **projected along the sun's parallel rays** onto the receiving surface (`surfaceHeightAt`, v1 flat ground), rotation = the drone's heading, uniform scale = footprint (the drone's per-type span) × altitude growth; `instanceColor.r` = altitude-fade opacity, `.g` = per-type profile index. The `MeshBasicMaterial` is patched (`onBeforeCompile`) with GLSL generated by `layer/shadowProfiles.ts`: each type's silhouette rectangles (baked constants from the profile JSON) are **smooth-min-unioned in SDF space**, then given one soft edge. `transparent`, `depthWrite:false`, `polygonOffset`; `frustumCulled = false`; casts/receives nothing | Capacity = Σ per-type UAV capacities (every drone can have a blob). Transparent pass; high/faint blobs culled. Replaces drones in the shadow pass — cheaper *and* flicker-free |
| 6m. CNS domes + rings (`createCnsSiteLayer`) | `CnsSite[]` with `coverageRadius > 0` | Per site: a ground **ring** plus **two exclusive dome treatments** of the same coverage volume, at most one visible — the **CNS Sites** mode (Off / Intensity / Coverage) picks it by flipping subgroup visibility. **Intensity dome** — a unit proxy sphere scaled to the coverage radius, drawn `BackSide` with a `ShaderMaterial` whose fragment alpha is the **closed-form line integral of a dB-linear signal density** — `ρ(r) ∝ ln(R/r)`, the remaining log-distance link margin, zero at the coverage radius — over the ray's segment through the volume ball ∩ above-ground ∩ ground rectangle, all applied as segment clamps; the fragment only supplies the ray, entry/exit come from the ray/sphere quadratic, and the model matrix carries center + radius, so one material serves a whole category; the proxy mesh contributes pixel coverage only, so tessellation never enters the math. **Coverage shell** — a faint translucent surface (`MeshBasicMaterial`, `DoubleSide` — the camera usually sits inside) marking where effective range ends: the range sphere intersected at build time with a box over the padded ground rectangle (`three-bvh-csg`, the envelopes' CSG pipeline), so the map-edge cut closes with flat vertical walls; the global below-ground clip trims the walls flush with the ground. **Ring** — a `LineLoop` at the exact radius (`fog:false`, and — like the ground icons — `AlwaysDepth` + depth write at `GROUND_ICON_RENDER_ORDER`, so buildings and trees standing on the circle can't chop it into dashes while the airspace layer still occludes it). All take the category color (`CNS_SITE_COLORS`) | Two shared unit geometries across all sites (dome proxy sphere + ring) plus one CSG solid per shell (range sphere ∩ map box, built once at load); one dome + one shell + one ring material per category. Intensity domes: transparent pass at `CNS_DOME_RENDER_ORDER` (composited after every other transparent object, so rotor discs and envelopes sit inside the veil), `depthWrite:false` **and** `depthTest:false` (a depth test would discard the fog on every pixel covered by an object inside the volume, punching untinted cutouts around buildings and drones), no fog/lighting/shadows; alpha peaks at `INTENSITY_DOME_PEAK_ALPHA` on a ground-grazing ray through the site and falls off log-distance style to zero at the rim (the signal-strength read), correct with the camera inside or outside. Coverage shells: the same render-order slot at `COVERAGE_SHELL_OPACITY`, `depthWrite:false` but an ordinary depth test — a shell is a surface, so opaque geometry in front of the shell wall occludes it — and `fog:false` like the ring (a fog-faded wall would read as weaker coverage, not distance). The map-edge cut differs per element: the ring carries four local clipping planes (`renderer.localClippingEnabled`); the intensity dome clamps each ray's **integration segment** to the padded ground rectangle inside its shader — a fragment's alpha carries a whole ray column, so plane-clipping the dome's exit surface would zero columns that still cross the rectangle and keep full columns that mostly lie outside it; the shell bakes the cut into its geometry as real walls — plane-clipping a hollow surface would open arch-shaped holes exposing the interior wherever the sphere crosses the map edge, so the sphere is CSG-intersected with the map box at build time instead, and the box floor sits below the global ground clip so no floor cap survives to z-fight the map. Known limit (intensity): the veil over an object is the ray's full column rather than the camera-to-object portion (and an object in front of a dome is veiled as if inside) — subtle at these alphas |

After Step 6 the WebGL state holds: shadow-map FBO, all static VBO/IBOs (ground, grid, buildings, roads, sky, ground icon discs, CNS domes/shells + rings, corridor centerlines, envelopes), instanced buffers (trees ×2, direction cones, UAVs, drone blob shadows), and shader programs compiled lazily on first draw. The airspace meshes (UAVs, corridors, envelopes, routes) are pushed to `AIRSPACE_RENDER_ORDER` so they draw after — and depth-test against — the ground icon markers.

**Underground clipping.** The `FleetScene` constructor configures the renderer with a single global clipping plane just below the ground — `new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.1)`, which keeps `y ≥ −0.1 m` (the 0.1 m offset drops the cut just below `y=0` so the ground plane and its coplanar grid don't straddle the clip boundary and flicker). It hides all sub-surface geometry — notably the buried envelope ground-terminal stubs (see **Air-path geometry** below) — and, as a side effect, removes the sky dome's lower hemisphere, which is why `SCENE_BACKGROUND_COLOR` equals `SKY_DOME_COLOR` (6a/6c): the background exposed below the horizon then blends invisibly. Global clipping (`renderer.clippingPlanes`) applies to every material regardless of `localClippingEnabled`.

### Step 7. UI scaffolding
- `createSimulationControls()` (`src/scene/control.ts`) — Tweakpane bindings on a shared `SimulationControlState` (running, speed, camera mode, visibility flags incl. grid, grid-spacing index, selected id). The pane mutates that JS-side object directly; rendering reads from it. Scene mutations are delegated back to `FleetScene` through callbacks (`onLayerVisibilityChange`, `onGridSpacingChange`, `onResetView`, `onResetSimulation`, …). Under `vite dev` it also mounts a Config-Files-Override folder and a Demo-presets folder.
- `createReadoutPanels()` (`src/scene/readouts.ts`) — builds four debug `<section>`s (simulation clock, scene debug, camera debug, telemetry debug) and returns their value nodes (`ReadoutPanels`). The scene-debug counts are immutable for the scene's lifetime and are written once here by `writeStaticSceneReadouts`; only the clock/camera/telemetry rows update per frame (Phase B Step 8).
- `createCorridorLabels()` — one `<div class="corridor-label">` per corridor appended to `#label-layer`, plus a `Vector3` anchor above its midpoint.
- `createUavLabels()` — empty `Map`, populated lazily only for the selected UAV.
- `mountStatsPanel()` — attaches the `stats.js` FPS panel to the canvas host.
- `CameraRig` (`src/scene/cameraRig.ts`, constructed with the camera + OrbitControls) — frames the initial view from the scene bounds and caches it as the Reset-view fly-back target; from here on it owns keyboard pan, follow mode, the reset tween, and the ground clamp (Phase B Step 4).

### Step 8. `start()`
- Adds `resize`, `keydown`, `keyup`, `pointerdown`, `contextmenu` listeners.
- Calls `telemetrySource?.start()` (opens the websocket, if present).
- Calls `clock.start()` and the first `requestAnimationFrame(animate)`.

---

## Phase B — Per-frame render loop (`FleetScene.animate`, ~60 Hz)

Every frame is one tick of `requestAnimationFrame`. The order matters: simulation state is computed first, then the camera follows the new state, then the GPU draws, then DOM labels/readouts are repositioned.

### Step 1. Frame-time bookkeeping
- `delta = min(clock.getDelta(), FRAME_DELTA_MAX_SECONDS)` — clamps spikes (e.g. tab refocus) so a single huge step can't teleport UAVs through the whole route.
- If `params.running`, `elapsedSeconds += delta * speedMultiplier`.

### Step 2. Fleet update (`updateFleet`) — the simulation core
`FleetScene` doesn't compute UAV state itself; it builds a `FleetFrameContext` (`{ writer, elapsedSeconds, selectedUavId }`, where `writer` is the shared `UavInstanceWriter` over the per-type meshes) and asks the **fleet sources** for a frame:

1. `telemetrySource?.update(ctx)` runs first. If it has a live snapshot it writes instances and returns a `FleetFrame`; if not, it returns `null`.
2. Otherwise `demoSource.update(ctx)` renders the frontend fleet.
3. The source that produced the frame becomes `activeSource` (click selection is routed back to it). `lastFrame` is stored and `params.selectedUavId` is adopted from the frame; the frame's `selection` pose feeds the camera pass (Step 4).

Each source writes its instances through `ctx.writer` (`begin()` → `write(typeCode, matrix, selected)` per drone → `commit()`) into the per-type meshes, and returns a `FleetFrame` (`activeCount`, `scheduledCount` (number for demo, `null` for telemetry), `simTimeSeconds`, reconciled `selectedUavId`/`selectedRouteId`, follow-camera `selection`, `selectedUavState`, `selectedSummary`).

**Demo source (`DemoFleetSource.update`)** maintains three parallel structures:

| Structure | Lifetime | Role |
|---|---|---|
| `pendingUavIndices` | sorted once at load | dispatch queue, consumed via `nextPendingUavIndex` |
| `activeUavIndices` | grows/shrinks each frame | currently-flying schedule indices |
| `slotToFleetIndexByType` | rebuilt each frame | maps a (vehicle type, GPU instance slot) → `fleet[index]` for click selection |

Sub-steps:
1. **`activateDepartedUavs()`** — pops from the head of `pendingUavIndices` while `departureTimeSeconds <= elapsedSeconds`, pushing into `activeUavIndices`. O(k) per frame where k = newly departed.
2. **Iterate active list**: for each active index, `getUavRoutePosition(uav, route, elapsedSeconds)` → `computeUavState(route, distance)`. This walks the route's segments (via `cumulativeLengths`), interpolates position/tangent linearly, and assigns status:
   - `pending` if flight hasn't started,
   - `active` if still in the air,
   - `destroyed` on route-end or first ground contact after takeoff.
3. **Status branching**:
   - `destroyed` → `removeActiveUavAt` (O(1) swap-pop), the slot is freed; a selection pointing at the destroyed UAV is cleared (returned as `""`), never echoed back as a zombie id.
   - `active` → `setUavYawQuaternion` (yaw-only) → `matrix.compose` → `writer.write(quadrotorTypeCode, matrix, isSelected)`, which sets the matrix and the instance color (selection red if selected, else black = the model's own materials) in the right type's mesh; record the returned (type, slot) in `slotToFleetIndexByType`. The selected UAV's state becomes the frame's `selectedUavState`.

**Telemetry source (`TelemetrySource.update`)** reads `client.latestSnapshot()`; returns `null` when there's none (so the demo source takes over). Otherwise it iterates the snapshot's drones, skips dead ones (`stateCode === 0`), and `writer.write`s each into the mesh for its `vehicleTypeCode` (the writer skips a drone whose type mesh is at capacity); `slotToHandleByType` maps the returned (type, slot) → drone handle. Only the **selected** drone yields a `selectedUavState` and the follow-camera pose; a selection whose drone is merely absent from this snapshot is kept (it may return). The backend owns position/velocity; there is no frontend interpolation.

**Buffer flush** (`writer.commit()`, both sources): for every per-type mesh, `mesh.count` is set to *exactly* how many instances were written to it this frame — meshes a source didn't touch go to 0, which is how a source switch drops stale instances. A mesh with count 0 uploads nothing (saves a wasted PCIe transfer); otherwise `instanceMatrix.addUpdateRange(0, count*16)` + `needsUpdate = true` (and same for `instanceColor`) uploads only the populated prefix, not the full capacity.

**Memory at this point**: matrix data exists in two places — a `Float32Array` on the JS heap (source of truth) and a GPU VBO (mirror, partially uploaded).

### Step 3. Route visibility (`updateRouteVisibility`)
- Hides the whole `routeGroup` unless the Routes toggle is on. When on, only the `route:<selectedRouteId>` subgroup stays visible, and within it the envelope child follows the Envelopes toggle. Cheap: just flips `Object3D.visible` flags.

### Step 4. Camera pass (`cameraRig.update(delta, frame.selection)`)
One `CameraRig` call runs the whole camera frame, in order:
- **Selected-pose intake** — a non-null `selection` from Step 2 refreshes the rig's cached selected position/tangent (a null selection keeps the last pose).
- **Keyboard pan** — only in Free mode: builds a forward/right vector from the camera's world direction and moves both `camera.position` and `controls.target` by the held WASD/arrow keys.
- **Follow mode** — on entry or selection change, snap the camera behind/above the selected pose; on subsequent frames, translate camera + target by the selected position's per-frame delta, so user pan/zoom relative to the UAV is preserved.
- **Reset-view tween** — while a fly-back is active, eases `camera.position`/`controls.target` from the captured start pose toward the initial frame (ease-in-out cubic over `RESET_VIEW_DURATION_SECONDS`) and disables `OrbitControls` for the flight so a drag can't fight it (`resetView()` forces Free mode on entry; the landing re-enables controls).
- **`controls.update()`** — OrbitControls applies damping and the latest mouse/wheel input.
- **Ground clamp** — `camera.position.y >= CAMERA_MIN_Y` so the user can't dive below ground.

### Step 5. Ground icon billboards (`updateGroundIconBillboards`)
- Projects the camera's look direction onto the ground plane and sets every marker's `rotation.y` so its artwork stays upright and readable. The discs stay flat; one shared rotation for all markers in the group. Pure transform update. Applied to the vertiport group, the contingency site group, and each CNS site marker group; icons that should stay locked to the world simply never get this call.

### Step 6. Label projection (`updateLabels` in `src/scene/labels.ts`)
- Toggles the layer's `--uav-visible` class.
- Corridor labels are **gated**: their anchors are static, so FleetScene re-projects them only when the camera matrix, viewport, or visibility flags changed since the last projection (`reprojectCorridorLabels`) — an idle camera skips every per-label DOM write (this was the profiled `setStyle` hot spot). When re-projecting, `toScreenPosition(anchor, camera, host)` sets `transform: translate3d(...)` per `<div>`, hidden if labels are off or both corridors & envelopes are hidden.
- For UAV labels: only the **selected** UAV gets a label (from `lastFrame.selectedUavState`); it's created lazily, updated every frame (the UAV moves), and pruned when selection changes or the UAV leaves the frame.
- **Output**: pure DOM mutations; no GPU work.

### Step 7. Three.js render (`renderer.render(scene, camera)`)
This is the WebGL submission for the frame. Roughly the order of work the GPU sees:
1. **Shadow pass** — the directional sun renders all `castShadow:true` meshes (buildings, trees) into the shadow-map render target. UAVs are **excluded** — their shadow is the blob-shadow decal layer (drawn in the transparent pass) instead.
2. **Opaque pass** — sky dome, ground + grid, buildings, roads, trees (two instanced draws), ground icon markers, the CNS coverage rings, the corridor centerline fat-line + direction-cone instanced mesh, and the per-type UAV instanced meshes' opaque parts (each bound to its freshly uploaded `instanceMatrix`/`instanceColor`). Render order keeps the airspace layer above the ground icon markers.
3. **Transparent pass** — the drone blob-shadow decals (`blobShadowMesh`), the merged flight-envelope mesh (`transparent depthWrite:false`), the UAVs' translucent rotor-disc material groups, and — last, at `CNS_DOME_RENDER_ORDER` — whichever CNS dome treatment the mode shows: the intensity fog domes (back-face signal-density volumes; they draw without a depth test, so paint order alone decides what their fog veils, and compositing them after every other transparent object keeps rotor discs and envelopes inside the veil like the opaque scene) or the coverage shells (depth-tested translucent range surfaces sharing the same slot).

What's "in the cache"/GPU buffers at this point:
- **Static VBO/IBOs** (uploaded once at load): ground, grid, buildings (merged), roads (merged), sky dome, ground icon discs, corridor centerlines (merged fat lines, vertex-colored), envelopes (merged, vertex-colored), tree trunk + canopy geometries, shared cone geometry.
- **Per-instance buffers** (uploaded once at load, immutable): tree trunk + canopy `instanceMatrix` + canopy `instanceColor`, direction-cone `instanceMatrix` + `instanceColor`.
- **Per-instance buffers** (re-uploaded each frame, partial range only): UAV `instanceMatrix` + `instanceColor`, sized by `activeCount`.
- **Render target**: shadow map, refreshed every frame the sun sees the scene.
- **Shader programs**: compiled once, cached by Three.js's program cache keyed on material defines.

### Step 8. HUD + readout updates
- `updateHud()` writes the status/speed/active-count/selection value nodes in `#hud-stats`.
- `updateReadoutPanels()` writes only the live rows: simulation clock, camera position/look-at, and the telemetry debug block (connection, Hz, sequence, age, parse time, dropped, error). The scene-debug counts are static and were written once at construction (`writeStaticSceneReadouts`, Phase A Step 7).
- These are direct `textContent` assignments — cheap, browser handles layout asynchronously.

### Step 9. End of frame
- `performanceStats.end()` records frame time for the FPS panel.
- Loop returns to Step 1 on next rAF.

---

## Side channels (event-driven, not in the rAF loop)

- **Resize** → `resize()` updates camera aspect + renderer size, and refreshes every `LineMaterial.resolution` in the corridor/route groups (fat lines stroke in screen pixels); affects the next render.
- **Pointerdown (left click)** → builds an NDC pointer, raycasts against **all per-type UAV meshes** (each using its static bounding sphere + current `instanceMatrix`). The nearest hit's mesh is resolved back to its vehicle type, and `activeSource.resolveId(typeCode, instanceId)` maps the slot to its canonical id (`null` when it maps to nothing); FleetScene then applies the toggle policy (clicking the already-selected UAV clears). `params.selectedUavId` is updated; the next `updateFleet` paints that instance red.
- **Contextmenu** → `preventDefault` so right-drag is free to rotate the orbit camera.
- **Tweakpane bindings** → mutate `params` directly. Visibility flags (including the grid) flow through `onLayerVisibilityChange` → `applyLayerVisibility`, flipping `Object3D.visible` (no buffer churn). The **Grid Size** slider flows through `onGridSpacingChange` → `setGridSpacing`, which disposes and rebuilds only the grid's line geometry at the new spacing. Play/speed changes are also forwarded to the telemetry source as backend commands.
- **Reset view button** → `cameraRig.resetView()`: captures the current camera pose and arms an animated fly-back to the initial framing (advanced each frame inside the camera pass, Step 4); forces Free mode. Client-side only — no backend call.
- **Reset button** → `resetSimulation()`: zeros `elapsedSeconds`, resets both sources, clears selection + UAV labels, sets every per-type `uavMesh.count = 0`, and snaps the camera back via `cameraRig.resetToInitialFrame()`.
- **Scene reload / demo preset** (`main.ts`) → `dispose()` the running scene (detaches listeners, stops telemetry, frees GPU resources) and mount a fresh `FleetScene` from new source texts.
- **Telemetry websocket** (`TelemetryClient`, telemetry mode only) → background, off the rAF loop: receives a JSON `registry` message (handle→id maps + simulator projection) and binary snapshot frames. Each binary frame (16-byte header + 64-byte drone records, little-endian) is decoded by `parseTelemetrySnapshotFrame`, converted from simulator coords (east, north, up) into the scene frame by `convertTelemetrySnapshotToScene`, and pushed into the latest-snapshot holder (`TelemetrySnapshotBuffer`, sequence-deduped: a stale frame is rejected and counted as dropped; only the newest snapshot is kept since rendering never interpolates). Malformed frames throw and are recorded in `lastError` without being buffered. On socket close it reconnects after ~1.5 s. `TelemetrySource.update` reads `latestSnapshot()` each frame.

---

## Quick mental model

- **CPU heap, immutable for the run**: `SceneData` (corridors, routes, buildings, roads, trees, vertiports, contingency sites, sites, flows), `demoSource.fleet: UavSchedule[]`, label DOM nodes, corridor anchors.
- **CPU heap, mutated each frame**: `elapsedSeconds`, the demo source's `activeUavIndices` / `slotToFleetIndexByType` (or the telemetry source's `slotToHandleByType` + latest snapshot), the writer's per-type slot cursors, and the `Matrix4`/`Quaternion`/`Vector3` scratch objects in each source.
- **GPU, uploaded once**: every static map/corridor/envelope/tree/ground-marker/CNS-dome buffer + shadow-map FBO + shader programs.
- **GPU, partially re-uploaded each frame**: each per-type UAV mesh's `instanceMatrix` + `instanceColor`, prefix length = that type's active count. A type with no active drones uploads nothing.
- **DOM, updated each frame**: HUD values, the live readout rows (clock/camera/telemetry), and the selected UAV's label; corridor-label transforms are rewritten only when the camera/viewport/visibility changed.

The whole architecture is "static map, instanced fleet": the city is built once and never touched, and only a tiny prefix of the UAV instance buffer crosses the JS↔GPU boundary per frame — whether that prefix comes from the local schedule (demo) or a backend snapshot (telemetry).

---

## Air-path geometry — centerlines & flight envelopes

Corridors and routes are both `AirPath`s — a colored 3D polyline carrying per-node OSM ids and vertiport flags, grouped into connected components (`componentId`). Three builders in `src/layer/airPath.ts` turn them into Three.js objects, delegating the actual geometry to `src/geometry/centerline.ts` and `src/geometry/envelope.ts`. Everything here runs **once at load** (Phase A, step 6i–6j); the air-path layers are static for the scene's lifetime.

`createCorridorGroup` + `createFlightEnvelopeGroup` build the corridor layer from `sceneData.corridors`. `createRouteGroup` builds the selected-route overlay from `sceneData.routes`: one subgroup named `route:<id>` per route, each holding its own centerline (`createCorridorGroup([route])`) plus an envelope child named `route-envelope` (`ROUTE_ENVELOPE_CHILD_NAME`). Keeping routes unbatched is exactly what lets `FleetScene.updateRouteVisibility` show a single route's subgroup and gate its envelope on the Envelopes toggle independently of the centerline.

### Centerlines (`geometry/centerline.ts`)

A centerline is drawn as a **fat line** plus a trail of **direction-arrow cones**.

- **Batched fat line.** `createCorridorGroup` walks every corridor's projected `points`, pushing each segment's two endpoints into one shared `positions` array and the corridor's component `color` into a parallel `colors` array. `buildAirPathLines` wraps them in a `LineSegmentsGeometry` + `LineSegments2` driven by a `LineMaterial` (`vertexColors`, `worldUnits:false`, `linewidth = AIR_PATH_LINE_WIDTH_PIXELS`). Fat lines stroke in **screen pixels**, so the material needs the viewport size — set at build time and kept current by `FleetScene.resize`, which traverses `corridorGroup`/`routeGroup` updating every `LineMaterial.resolution`.
- **Direction cones.** `appendDirectionCones` marches each polyline by arc length, dropping a cone every `AIR_PATH_DIRECTION_CONE_SPACING_METERS` (120 m). Each cone's orientation is a quaternion rotating the cone's local +Y axis onto the local segment direction. `buildConeInstancedMesh` packs all cones (across all corridors) into **one** `InstancedMesh` over a shared `ConeGeometry`, with a per-instance matrix + color and an unlit `MeshBasicMaterial`.
- **Cost & tradeoff.** The corridor centerline layer is **two draw calls** — one fat-line batch + one cone instance batch — regardless of corridor count. The batching tradeoff is documented in `airPath.ts`: per-corridor visibility filtering or recolor would require a draw-range trick / attribute mask / full rebuild of the merged buffers. Fine while corridors are static. Routes pay a few extra draws each (built individually), negligible for the handful a scene carries.

### Flight envelopes (`geometry/envelope.ts`)

The envelope is a fat translucent tube (radius `ENVELOPE_RADIUS_METERS`, ~35 m) around each air path. Two hard constraints shape the whole build:

1. **No double-blend.** Overlapping translucent tubes blend into a darker, busier soup, so a whole connected component must read as **one** uniform-opacity solid.
2. **Watertight joins.** That single solid must have no gaps where air paths meet.

`buildComponentEnvelopeGeometries` groups air paths by `componentId` and builds one fused geometry per component. The work is split **by whether the cheap bisector miter can handle a node** — it solves everything except true junctions and corners too sharp for their neighboring segments:

1. **Shared-node graph** (`buildAirPathGraph`) — node positions, a vertiport flag per node (OR'd across the paths sharing it), one `edge` per polyline segment carrying its `envelopeRadius`, and an `adjacency` map whose entry length is each node's **degree**.
2. **Chains** (`extractChains`) — edges are stitched into maximal chains that flow **through** every degree-2 non-vertiport "through-node" (crossing air-path boundaries where two paths join end-to-end) and break at a junction (degree > 2), a degree-1 terminal, or a vertiport. A pure loop of through-nodes (no break node to root it) is cut at an arbitrary node.
3. **Ground terminals** (`groundTerminalPoints`) — a chain end resting on the ground (`|y| ≤ GROUND_PLANE_EPSILON_METERS`, and degree-1 or a vertiport) is extended straight down by `UNDERGROUND_STUB_DEPTH_RADII` × radius into a buried stub. The terminal becomes an interior miter vertex, so the tube bends to vertical and its flat end cap is hidden below the opaque ground instead of leaving an open disk straddling `y=0`. The global below-ground clipping plane (see **Underground clipping** in Phase A) additionally cuts the buried stub outright, so nothing sub-surface renders even from a grazing camera angle.
4. **Simplify + split** (`simplifyPolyline` + `splitUnmiterableChain`) — each chain polyline (buried stub points included) is Douglas-Peucker-simplified to `ENVELOPE_SIMPLIFY_TOLERANCE_METERS` (0.5 m, invisible under a ~35 m tube). Smoothed networks sample corridors every ~10 m, so this collapses the collinear runs (~20× fewer rings) and — critically — restores long segments around real corners. The miter (step 5) shifts a ring by up to `radius·tan(turn/2)` along each tangent, and a segment whose two endpoint shifts sum past its length folds the tube inside-out into large fins; any interior vertex whose shift would claim more than `MAX_MITER_SHIFT_SEGMENT_FRACTION` (½) of either adjacent segment therefore **splits the chain** there (U-turns, which have no bisector plane, always split). Split points join the junction list for sphere-fusing, sized to the chain's radius. Without this, an authored sharp corner between two smoothed corridors — pinned by per-corridor smoothing, flanked by ~10 m samples — folds (the pre-2026-08 fin artifact).
5. **Miter tubes** (`createSimpleTubeGeometry`) — each fold-free run becomes a tube via **parallel-transport frames** (a stable normal/binormal carried along the polyline, one per edge) plus a **bisector miter**: at each interior vertex every ring vertex is shifted along the edge tangent onto the vertex's bisector plane, so the two adjacent edges' rings coincide vertex-for-vertex — one shared ring per vertex, no bevel band and no corner gap. Both ends are closed with a triangle-fan cap, and faces wind outward, so the result is a closed, outward-oriented solid (correct for translucent lighting *and* CSG inside/outside tests). `ENVELOPE_RADIAL_SEGMENTS` (18) ring vertices per polyline vertex.
6. **Junction spheres** (`collectJunctionNodes`) — a junction (degree > 2, non-vertiport: a T, X, or diverging point) has no single bisector plane, so it gets a `SphereGeometry` sized to its widest incident `envelopeRadius`. The unmiterable split points from step 4 get the same sphere treatment.
7. **Fuse** (`buildComponentEnvelope`):
   - **No junctions and no splits →** the miter tubes already read as one solid, so they're `mergeGeometries`'d directly — **no CSG paid**.
   - **Otherwise →** chain tubes + spheres are wrapped as `three-bvh-csg` `Brush`es and **CSG-unioned** (`ADDITION`, via a shared `Evaluator` restricted to `position`+`normal`) into one watertight blob. If the evaluator throws on degenerate input, it falls back to a plain (overlapping) `mergeGeometries` so a single bad junction never blanks the whole layer.

   Splitting by miterability is what keeps this cheap: only true junctions and genuinely unmiterable corners pay for CSG, cutting brush count ~10× versus the old per-edge-cylinder + per-node-sphere approach — and simplification typically makes sharp joints miterable again, so splits stay rare. Vertiport nodes never get a sphere and always end a chain, so a vertiport terminal is just a clean flat cap.

**Materialization** (`createFlightEnvelopeGroup`). Each component geometry gets a flat per-vertex `color` attribute (`setUniformVertexColor`, so the component color survives the merge), then all components are `mergeGeometries`'d into **one** mesh with a single `MeshStandardMaterial` (`vertexColors`, `transparent`, `opacity = ENVELOPE_OPACITY = 0.1`, `roughness = ENVELOPE_ROUGHNESS = 0.45`, `metalness 0`, `depthWrite:false`, `side: DoubleSide`). The corridor envelope layer is therefore **one draw call**, drawn in the transparent pass. Source geometries are disposed after the merge. Each route, being its own component, produces an independent envelope solid that never fuses with another route's or a corridor's.

### Key constants

The air-path/envelope tunables (`AIR_PATH_*`, `ENVELOPE_*`) live in `src/constant.ts` — the single source of truth; each value's role is documented inline there. Four are module-local to `geometry/envelope.ts`: `GROUND_PLANE_EPSILON_METERS` (the "rests on the ground" threshold), `UNDERGROUND_STUB_DEPTH_RADII` (buried-stub depth at a ground terminal), `ENVELOPE_SIMPLIFY_TOLERANCE_METERS` (chain-simplification tolerance), and `MAX_MITER_SHIFT_SEGMENT_FRACTION` (the miter-fold limit past which a chain splits for sphere-fusing).
