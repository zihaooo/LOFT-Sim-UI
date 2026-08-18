import * as THREE from "three";

// Data parsing and projection
export const METERS_PER_DEGREE_LAT = 111_320;
export const CORRIDOR_COLORS = ["#47c2ff"];
export const ROUTE_COLORS = ["#f7b955", "#8fd15a", "#ff6f91", "#b892ff"];
export const ROAD_STYLES: Record<string, { width: number; color: string }> = {
  motorway: { width: 13, color: "#d5c9b9" },
  motorway_link: { width: 8, color: "#d5c9b9" },
  trunk: { width: 11, color: "#d5c9b9" },
  trunk_link: { width: 7, color: "#d5c9b9" },
  primary: { width: 10, color: "#d4ccba" },
  primary_link: { width: 6.5, color: "#d4ccba" },
  secondary: { width: 8.5, color: "#d0caba" },
  secondary_link: { width: 5.5, color: "#d0caba" },
  tertiary: { width: 7, color: "#cbc7b7" },
  tertiary_link: { width: 5, color: "#cbc7b7" },
  residential: { width: 5.2, color: "#c2c3b4" },
  unclassified: { width: 5, color: "#c2c3b4" },
  living_street: { width: 4.2, color: "#c2c3b4" },
  road: { width: 4.5, color: "#c2c3b4" },
  service: { width: 3.4, color: "#b3baac" },
  track: { width: 2.6, color: "#adb9a0" },
  pedestrian: { width: 2.8, color: "#adb9a0" },
  footway: { width: 1.7, color: "#98aa8a" },
  path: { width: 1.6, color: "#98aa8a" },
  cycleway: { width: 1.7, color: "#98aa8a" },
  steps: { width: 1.5, color: "#98aa8a" },
};

// Draw priority per highway class: higher = more important. Roads are sorted by this so
// minor roads are drawn first and major roads (motorway, trunk, ...) are drawn last, letting
// the higher class paint over the lower one at intersections instead of bleeding through.
// Derived from ROAD_STYLES insertion order, which already runs most-important → least-important.
const ROAD_KINDS_BY_IMPORTANCE = Object.keys(ROAD_STYLES);
export const ROAD_DRAW_PRIORITY: Record<string, number> = Object.fromEntries(
  ROAD_KINDS_BY_IMPORTANCE.map((kind, index) => [kind, ROAD_KINDS_BY_IMPORTANCE.length - index]),
);

// Simulation scheduling
export const DEFAULT_UAV_SPEED_METERS_PER_SECOND = 12;

// Camera modes and movement
export const CAMERA_MODES = {
  FREE: "Free",
  FOLLOW_SELECTED_UAV: "Follow selected UAV",
} as const;
export const CAMERA_FOV_DEGREES = 52;
export const CAMERA_NEAR_METERS = 1;
export const CAMERA_FAR_METERS = 65_000;
export const CAMERA_MIN_Y = 0;
export const FREE_CAMERA_PAN_METERS_PER_SECOND = 360;
export const FOLLOW_CAMERA_DISTANCE_METERS = 95;
export const FOLLOW_CAMERA_HEIGHT_METERS = 58;
export const INITIAL_CAMERA_HEIGHT_METERS = 3_000;
export const INITIAL_CAMERA_X_OFFSET_METERS = -1;
// Duration of the "Reset view" camera fly-back to the initial framing.
export const RESET_VIEW_DURATION_SECONDS = 0.9;
// Scene bounds padding (the ground plane is padded an extra GROUND_PADDING_METERS beyond the scene bounds)
export const BBOX_PADDING_METERS = 500;
export const GROUND_PADDING_METERS = 150;

// Renderer and orbit controls
export const MAX_DEVICE_PIXEL_RATIO = 2;
export const ORBIT_DAMPING_FACTOR = 0.08;
export const ORBIT_MAX_DISTANCE_METERS = 40_000;
export const ORBIT_MIN_DISTANCE_METERS = 45;
export const ORBIT_MOUSE_BUTTONS = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
} as const;
export const FRAME_DELTA_MAX_SECONDS = 0.08;
export const SIMULATION_SPEED_LEVELS = [1, 2, 5, 10, 100] as const;

// Shared vector math
export const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Scene environment
export const SKY_DOME_COLOR = "#c8dced";
export const SKY_DOME_RADIUS_METERS = 40_000;
// Matches the sky dome: the below-ground clipping plane removes the dome's lower hemisphere, so the
// background shows through below the horizon — keeping the two equal hides that seam.
export const SCENE_BACKGROUND_COLOR = SKY_DOME_COLOR;
export const SCENE_FOG_NEAR_METERS = 1_500;
export const SCENE_FOG_FAR_METERS = 60_000;
export const HEMISPHERE_SKY_COLOR = "#f2f8ff";
export const HEMISPHERE_GROUND_COLOR = "#879281";
export const HEMISPHERE_LIGHT_INTENSITY = 2.6;
export const SUN_COLOR = "#ffffff";
export const SUN_INTENSITY = 2.4;
// Sun placement is an offset from the active scene's center (encodes the sun's direction + distance),
// so the light + its shadow frustum re-center on whichever preset is loaded.
export const SUN_OFFSET = new THREE.Vector3(-900, 1_400, 700);
export const SUN_SHADOW_MAP_SIZE = 2_048;
// Vertical extent (metres) the shadow frustum must span so tall buildings/trees stay inside it as casters.
export const SHADOW_SCENE_HEIGHT_METERS = 300;
// Fractional padding added to the fitted shadow frustum so soft (PCF) edges are not clipped at the scene rim.
export const SHADOW_FIT_MARGIN = 0.05;

// Drone blob shadows. Drones use a cheap ground decal — a per-type composite of rectangles fitted to each
// model's silhouette (see scripts/compute_shadow_params.py + layer/shadowProfiles) — instead of casting into
// the shared shadow map (which flickers on their small, thin, fast geometry). The shadow is sized to the
// drone's footprint, oriented to its heading, and grows + fades with altitude, mimicking how a small high
// object loses its ground shadow in reality.
export const BLOB_SHADOW_GROWTH_PER_METER = 0.001; // gentle widening of the shadow with altitude (m per m)
export const BLOB_SHADOW_FADE_HEIGHT_METERS = 1_000; // altitude at which the shadow has fully faded out
export const BLOB_SHADOW_MAX_OPACITY = 0.1; // a soft grey contact shadow, not ink-black
export const BLOB_SHADOW_MIN_OPACITY = 0.001; // blobs fainter than this are skipped (culled), bounding transparent fill
export const BLOB_SHADOW_Y_OFFSET_METERS = 0.03; // lifts the decal above ground (0) and roads (0.02), below vertiports (0.04)
// Half-size of the shadow quad in normalized profile units (1 = the drone's footprint half-span). Must
// exceed the widest rect (~1.14 for the quad arms) plus the soft band (EDGE_BLUR), or the edge gets clipped
// at the quad. It only enlarges the (mostly transparent) quad margin — the shadow's world size is
// independent of it.
export const BLOB_SHADOW_QUAD_HALF_EXTENT = 1.5;
// Half-width of the soft band straddling each rectangle edge, in profile units (1 = footprint half-span):
// alpha ramps from 1 just inside to 0 just outside. Larger = blurrier; the 50% edge stays on the rect.
export const BLOB_SHADOW_EDGE_BLUR = 0.12;
// Smooth-union radius (profile units) for joining a type's rects: the rectangles are merged with a
// smooth-min in distance space so the joints (the X crossing, wing/fuselage) round over instead of
// creasing. Larger = rounder joints.
export const BLOB_SHADOW_UNION_SMOOTH = 0.1;
// Horizontal ground offset per metre of altitude when projecting a point along the sun's parallel rays.
// Derived from SUN_OFFSET so it tracks the sun; the ray length cancels, leaving a simple component ratio.
export const SHADOW_OFFSET_X_PER_M = -SUN_OFFSET.x / SUN_OFFSET.y;
export const SHADOW_OFFSET_Z_PER_M = -SUN_OFFSET.z / SUN_OFFSET.y;

export const GROUND_COLOR = "#d9ddcf";
export const GROUND_SEGMENTS = 24;
export const GRID_COLOR = "#9da79b";
export const GRID_Y_OFFSET_METERS = 0.04;
export const GRID_OPACITY = 0.4;
// Selectable grid-line spacings (meters) for the "Grid Size" slider; the initial pick is bbox-derived.
export const GRID_SPACING_TICKS = [100, 200, 500, 1000, 2000, 5000, 10_000] as const;
// Target number of grid cells across the scene's longest dimension when choosing the initial spacing.
export const GRID_TARGET_CELL_COUNT = 15;

// Static scene geometry
export const BUILDING_COLOR = "#aeb9bc";
export const BUILDING_ROUGHNESS = 0.72;
export const BUILDING_METALNESS = 0.04;
export const ROAD_MIN_SEGMENT_LENGTH_METERS = 0.01;
/** Lifts road quads above the ground plane to resolve z-fighting. */
export const ROAD_Y_OFFSET_METERS = 0.02;
export const TREE_TRUNK_COLOR = "#6f563a";
export const TREE_TRUNK_ROUGHNESS = 0.86;
export const TREE_TRUNK_RADIUS_TOP = 0.55;
export const TREE_TRUNK_RADIUS_BOTTOM = 0.7;
export const TREE_TRUNK_GEOMETRY_HEIGHT = 1;
export const TREE_TRUNK_RADIAL_SEGMENTS = 5;
export const TREE_TRUNK_HEIGHT_RATIO = 0.42;
export const TREE_TRUNK_MIN_HEIGHT_METERS = 2.4;
export const TREE_TRUNK_RADIUS_RATIO = 0.14;
export const TREE_TRUNK_MIN_RADIUS_METERS = 0.22;
export const TREE_CANOPY_COLOR = "#537c4f";
export const TREE_CANOPY_ROUGHNESS = 0.94;
export const TREE_CANOPY_DETAIL = 1;
export const TREE_CANOPY_MIN_HEIGHT_RADIUS_RATIO = 1.6;
export const TREE_CANOPY_HUE_BASE = 0.29;
export const TREE_CANOPY_HUE_STEP = 0.008;
export const TREE_CANOPY_HUE_VARIANTS = 7;
export const TREE_CANOPY_SATURATION = 0.28;
export const TREE_CANOPY_LIGHTNESS_BASE = 0.34;
export const TREE_CANOPY_LIGHTNESS_STEP = 0.03;
export const TREE_CANOPY_LIGHTNESS_VARIANTS = 3;

// Air path (corridor and route) and envelope rendering
/** Centerline screen-space width in CSS pixels (Line2 fat lines; tune freely). */
export const AIR_PATH_LINE_WIDTH_PIXELS = 1.5;
export const AIR_PATH_DIRECTION_CONE_RADIUS_METERS = 1.2;
export const AIR_PATH_DIRECTION_CONE_HEIGHT_METERS = 3.2;
export const AIR_PATH_DIRECTION_CONE_RADIAL_SEGMENTS = 8;
/** Arrow cones are dropped at this arc-length spacing along each air path; smaller = more arrows. */
export const AIR_PATH_DIRECTION_CONE_SPACING_METERS = 120;
export const ENVELOPE_RADIAL_SEGMENTS = 18;
export const ENVELOPE_OPACITY = 0.1;
export const ENVELOPE_ROUGHNESS = 0.45;
/** Tube radius of a flight envelope, in meters. */
export const ENVELOPE_RADIUS_METERS = 35;

// Ground icon markers (SVG artwork laid flat on the map, spun to stay readable)
/** Icon SVG assets under public/icons. Adding an icon type starts with an entry here. */
export const GROUND_ICON_ASSETS = {
  vertiport: "/icons/vertiport.svg",
  navSite: "/icons/nav_site.svg",
  commSite: "/icons/comm_site.svg",
  survSite: "/icons/surv_site.svg",
} as const;
/**
 * Raster resolution of an icon texture (power-of-two for mipmapping). The assets are authored at 32px, so
 * the loader stamps this size into the markup before rasterizing rather than upscaling a 32px bitmap.
 */
export const GROUND_ICON_TEXTURE_SIZE = 512;
/** Tessellation of the icon disc. The rim is a polygon edge, so this is what MSAA antialiases. */
export const GROUND_ICON_CIRCLE_SEGMENTS = 48;
/** Requested anisotropy; three clamps it to the hardware max. Ground decals are read at grazing angles. */
export const GROUND_ICON_ANISOTROPY = 16;
/** Lifts icon markers above the ground plane (above the road) to resolve z-fighting. */
export const GROUND_ICON_Y_OFFSET_METERS = 0.04;
/** Diameter of the vertiport icon disc, in meters. */
export const VERTIPORT_ICON_SIZE_METERS = 70;
/**
 * Scene layering by render order. Map geometry (ground, buildings, roads, trees) stays at the default
 * 0; ground icons render just above it so buildings can't hide them; the airspace layer (drones,
 * corridors, routes, envelopes) renders above the icons so it occludes them when in front. The CNS
 * domes (the intensity fog or the coverage shell, whichever mode is active) composite last: the fog
 * draws without a depth test, so paint order alone decides what it veils — and everything, including
 * the airspace layer's translucent parts (rotor discs, envelopes), must be painted before the fog to
 * sit inside it.
 */
export const GROUND_ICON_RENDER_ORDER = 1;
export const AIRSPACE_RENDER_ORDER = 2;
export const CNS_DOME_RENDER_ORDER = 3;

// CNS sites (navigation / communication / surveillance ground stations)
/**
 * node_type tag value -> coverage tint. Each color matches its icon's accent (see public/icons) so a
 * site's marker, dome, and ring read as one object. The keys are the single source of truth for the
 * closed set of site categories (see {@link CnsSiteType}).
 */
export const CNS_SITE_COLORS = {
  nav_site: "#16a34a",
  comm_site: "#2563eb",
  surv_site: "#7c3aed",
} as const;
/** The closed set of CNS site categories (`node_type` values), derived from the color table above. */
export type CnsSiteType = keyof typeof CNS_SITE_COLORS;
export const CNS_SITE_TYPES = Object.keys(CNS_SITE_COLORS) as readonly CnsSiteType[];
/** Diameter of a CNS site icon disc, in meters (the same footprint as the vertiport disc). */
export const CNS_SITE_ICON_SIZE_METERS = 70;
/**
 * Intensity-dome alpha of the densest possible view ray (a ground-grazing ray through the site). The
 * dB-linear density concentrates alpha near the site, so most of the dome reads at a small fraction of
 * this. Kept moderate because coverage radii are scene-sized and the domes overlap — the camera usually
 * sits inside them, so their tint lies over everything.
 */
export const INTENSITY_DOME_PEAK_ALPHA = 0.5;
/**
 * Coverage-shell opacity. The shell is a flat-alpha surface, not a signal read — its one job is
 * marking the effective-range boundary — so it stays faint enough that overlapping shells and the
 * shell wall (usually seen from inside, since radii are scene-sized) never bury the scene.
 */
export const COVERAGE_SHELL_OPACITY = 0.05;
/**
 * Unit-sphere tessellation shared by the intensity dome (a rasterization proxy, where only the
 * silhouette shows segments) and the coverage shell (the CSG source of a real surface at the same
 * radius). The rim is the dome's silhouette at km scale, so it gets fine segments.
 */
export const CNS_DOME_WIDTH_SEGMENTS = 96;
export const CNS_DOME_HEIGHT_SEGMENTS = 48;
/** Segments of the ground ring marking a site's exact coverage extent. */
export const COVERAGE_RING_SEGMENTS = 128;
/** Lifts the coverage ring above the ground plane (same clearance as the grid) to resolve z-fighting. */
export const COVERAGE_RING_Y_OFFSET_METERS = 0.04;

// UAV rendering
// Vehicle type codes mirror the simulator wire protocol (LOFT-Sim loft/telemetry/protocol.py):
// 1 = quadrotor, 2 = fixed-wing, 3 = hybrid (tilt-rotor). Each maps to its own gltf model.
export const VEHICLE_TYPE_QUADROTOR = 1;
export const VEHICLE_TYPE_FIXED_WING = 2;
export const VEHICLE_TYPE_HYBRID = 3;
/** Used when a drone's vehicleTypeCode is missing or unrecognized (and for the demo fleet). */
export const DEFAULT_VEHICLE_TYPE_CODE = VEHICLE_TYPE_QUADROTOR;
/**
 * vehicleTypeCode -> model asset path. The keys define the full set of per-type instanced meshes and are
 * the single source of truth for the closed set of vehicle type codes (see {@link VehicleTypeCode}).
 * `as const satisfies` keeps the keys narrow (so `keyof` yields the exact code union) while validating values.
 */
export const DRONE_MODEL_PATHS_BY_TYPE = {
  [VEHICLE_TYPE_QUADROTOR]: "/data/model/quadrotor.gltf",
  [VEHICLE_TYPE_FIXED_WING]: "/data/model/fixedwing.gltf",
  [VEHICLE_TYPE_HYBRID]: "/data/model/hybrid.gltf",
} as const satisfies Record<number, string>;
/** The closed set of vehicle type codes the app renders, derived from the model set above. */
export type VehicleTypeCode = keyof typeof DRONE_MODEL_PATHS_BY_TYPE;
/** vehicleTypeCode -> human-readable name, used for debug/readout display. */
export const VEHICLE_TYPE_NAMES_BY_CODE: Readonly<Record<number, string>> = {
  [VEHICLE_TYPE_QUADROTOR]: "quadrotor",
  [VEHICLE_TYPE_FIXED_WING]: "fixed-wing",
  [VEHICLE_TYPE_HYBRID]: "hybrid",
};
/** Comma-separated names of the UAV types the app can render, derived from the model set. */
export const SUPPORTED_VEHICLE_TYPE_NAMES = Object.keys(DRONE_MODEL_PATHS_BY_TYPE)
  .map((code) => VEHICLE_TYPE_NAMES_BY_CODE[Number(code)] ?? `type ${code}`)
  .join(", ");
/**
 * vehicleTypeCode -> widest horizontal span (m). Drives geometry normalization and the blob-shadow footprint,
 * so a drone's shadow matches its body. `satisfies Record<VehicleTypeCode, number>` makes a missing entry a compile error.
 */
export const DRONE_MODEL_SPAN_METERS_BY_TYPE: Readonly<Record<number, number>> = {
  [VEHICLE_TYPE_QUADROTOR]: 22,
  [VEHICLE_TYPE_FIXED_WING]: 34,
  [VEHICLE_TYPE_HYBRID]: 28,
} satisfies Record<VehicleTypeCode, number>;
export const FALLBACK_UAV_RADIUS_METERS = 7;
export const FALLBACK_UAV_HEIGHT_METERS = 22;
export const FALLBACK_UAV_RADIAL_SEGMENTS = 8;
export const UAV_COLOR = "#ffffff";
export const SELECTED_UAV_COLOR = "#ff2f2f";
export const UAV_ROUGHNESS = 0.38;
export const UAV_METALNESS = 0.15;
export const TELEMETRY_UAV_MESH_CAPACITY = 10_000;

// Labels and readouts
export const LABEL_SCREEN_Y_OFFSET_METERS = 16;
export const STATS_PANEL_TOP_PX = "24px";
export const STATS_PANEL_LEFT_PX = "24px";
export const STATS_PANEL_Z_INDEX = "2";
