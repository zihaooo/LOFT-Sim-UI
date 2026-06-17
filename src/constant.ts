import * as THREE from "three";

// Data parsing and projection
export const METERS_PER_DEGREE_LAT = 111_320;
export const CORRIDOR_COLORS = ["#47c2ff", "#f7b955", "#8fd15a", "#ff6f91", "#b892ff"];
export const ROAD_STYLES: Record<string, { width: number; color: string }> = {
  motorway: { width: 13, color: "#d4c7b6" },
  motorway_link: { width: 8, color: "#d4c7b6" },
  trunk: { width: 11, color: "#d4c7b6" },
  trunk_link: { width: 7, color: "#d4c7b6" },
  primary: { width: 10, color: "#d3cab8" },
  primary_link: { width: 6.5, color: "#d3cab8" },
  secondary: { width: 8.5, color: "#cfc8b8" },
  secondary_link: { width: 5.5, color: "#cfc8b8" },
  tertiary: { width: 7, color: "#c9c5b4" },
  tertiary_link: { width: 5, color: "#c9c5b4" },
  residential: { width: 5.2, color: "#bfc0b1" },
  unclassified: { width: 5, color: "#bfc0b1" },
  living_street: { width: 4.2, color: "#bfc0b1" },
  road: { width: 4.5, color: "#bfc0b1" },
  service: { width: 3.4, color: "#afb6a8" },
  track: { width: 2.6, color: "#a8b59b" },
  pedestrian: { width: 2.8, color: "#a8b59b" },
  footway: { width: 1.7, color: "#91a482" },
  path: { width: 1.6, color: "#91a482" },
  cycleway: { width: 1.7, color: "#91a482" },
  steps: { width: 1.5, color: "#91a482" },
};

// Simulation scheduling
export const DEFAULT_UAV_SPEED_METERS_PER_SECOND = 12;

// Camera modes and movement
export const CAMERA_MODES = {
  FREE: "Free",
  FOLLOW_SELECTED_UAV: "Follow selected UAV",
} as const;
export const CAMERA_FOV_DEGREES = 52;
export const CAMERA_NEAR_METERS = 1;
export const CAMERA_FAR_METERS = 20_000;
export const CAMERA_MIN_Y = 0;
export const FREE_CAMERA_PAN_METERS_PER_SECOND = 360;
export const FOLLOW_CAMERA_DISTANCE_METERS = 95;
export const FOLLOW_CAMERA_HEIGHT_METERS = 58;
export const INITIAL_CAMERA_HEIGHT_METERS = 3_000;
export const INITIAL_CAMERA_X_OFFSET_METERS = -1;

// Renderer and orbit controls
export const MAX_DEVICE_PIXEL_RATIO = 2;
export const ORBIT_DAMPING_FACTOR = 0.08;
export const ORBIT_MAX_DISTANCE_METERS = 4_500;
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
export const HIDDEN_UAV_SCALE = new THREE.Vector3(0, 0, 0);

// Scene environment
export const SCENE_BACKGROUND_COLOR = "#dce7ef";
export const SCENE_FOG_NEAR_METERS = 1_500;
export const SCENE_FOG_FAR_METERS = 7_500;
export const HEMISPHERE_SKY_COLOR = "#f2f8ff";
export const HEMISPHERE_GROUND_COLOR = "#879281";
export const HEMISPHERE_LIGHT_INTENSITY = 2.6;
export const SUN_COLOR = "#ffffff";
export const SUN_INTENSITY = 2.4;
export const SUN_POSITION = new THREE.Vector3(-900, 1_400, 700);
export const SUN_SHADOW_BOUNDS_METERS = 2_500;
export const SUN_SHADOW_MAP_SIZE = 2_048;
export const SKY_DOME_COLOR = "#c8dced";
export const SKY_DOME_RADIUS_METERS = 8_000;
export const GROUND_COLOR = "#d9ddcf";
export const GROUND_SEGMENTS = 24;
export const GRID_COLOR = "#9da79b";
export const GRID_Y_OFFSET_METERS = 0.04;
export const GRID_OPACITY = 0.28;

// Static scene geometry
export const BUILDING_COLOR = "#aeb9bc";
export const BUILDING_ROUGHNESS = 0.72;
export const BUILDING_METALNESS = 0.04;
export const ROAD_MIN_SEGMENT_LENGTH_METERS = 0.01;
export const ROAD_OPACITY = 0.9;
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

// Corridor and envelope rendering
export const CORRIDOR_LINE_RADIUS_METERS = 0.3;
/** Centerline screen-space width in CSS pixels (Line2 fat lines; tune freely). */
export const CORRIDOR_LINE_WIDTH_PIXELS = 1.5;
export const CORRIDOR_DIRECTION_CONE_RADIUS_METERS = 1.2;
export const CORRIDOR_DIRECTION_CONE_HEIGHT_METERS = 3.2;
export const CORRIDOR_DIRECTION_CONE_RADIAL_SEGMENTS = 8;
/** Arrow cones are dropped at this arc-length spacing along each corridor; smaller = more arrows. */
export const CORRIDOR_DIRECTION_CONE_SPACING_METERS = 120;
export const ENVELOPE_RADIAL_SEGMENTS = 18;
export const ENVELOPE_OPACITY = 0.1;
export const ENVELOPE_ROUGHNESS = 0.45;

// UAV rendering
export const DRONE_MODEL_CANDIDATES = ["/data/model/drone.gltf"] as const;
export const DRONE_MODEL_SPAN_METERS = 22;
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
