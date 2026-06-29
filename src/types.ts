export type GeoPoint = {
  lat: number;
  lon: number;
  altitude: number;
};

export type ScenePoint = {
  x: number;
  y: number;
  z: number;
};

export type ProjectionOrigin = {
  lat: number;
  lon: number;
};

export type SceneBounds = {
  min: ScenePoint;
  max: ScenePoint;
  width: number;
  depth: number;
};

/**
 * A colored 3D polyline with the per-node metadata the centerline + envelope builders consume.
 * Corridors and routes are both AirPaths; the two aliases below mark intent and can diverge later.
 */
export type AirPath = {
  id: string;
  name: string;
  from: string;
  to: string;
  color: string;
  envelopeRadius: number;
  /** Index of the connected component this path belongs to; all paths in a component share one color. */
  componentId: number;
  points: ScenePoint[];
  geoPoints: GeoPoint[];
  /** OSM node id per point (aligned with `points`); used to detect shared junction nodes across paths. */
  nodeIds: string[];
  /** Per-point flag (aligned with `points`): true when the node is a vertiport terminal, which never connects onward. */
  vertiportFlags: boolean[];
  length: number;
  segmentLengths: number[];
  cumulativeLengths: number[];
};

/** An air corridor: a path UAVs fly along, grouped into components by shared (non-vertiport) nodes. */
export type AirCorridor = AirPath;

/** A route: a sequence of corridor ways merged into one path; each route is its own component. */
export type AirRoute = AirPath;

export type BuildingFootprint = {
  id: string;
  points: ScenePoint[];
  height: number;
};

export type RoadPath = {
  id: string;
  kind: string;
  points: ScenePoint[];
  width: number;
  color: string;
};

export type TreePoint = {
  id: string;
  position: ScenePoint;
  radius: number;
  height: number;
};

/** A vertiport terminal rendered as a flat, camera-oriented helipad marker on the ground. */
export type VertiportPoint = {
  id: string;
  name: string;
  position: ScenePoint;
};

export type FlowDefinition = {
  flowId: string;
  routeId: string;
  uavPerHour: number;
};

export type UavSchedule = {
  id: string;
  type: string;
  routeId: string;
  platoonId: string;
  speedMetersPerSecond: number;
  offsetMeters: number;
  departureTimeSeconds: number;
  cycleSeconds: number;
};

export type UavState = {
  position: ScenePoint;
  tangent: ScenePoint;
  distance: number;
  progress: number;
  status: "pending" | "active" | "destroyed";
};

export type SceneData = {
  origin: ProjectionOrigin;
  sceneBounds: SceneBounds;
  corridors: AirCorridor[];
  routes: AirRoute[];
  buildings: BuildingFootprint[];
  roads: RoadPath[];
  trees: TreePoint[];
  vertiports: VertiportPoint[];
  flows: FlowDefinition[];
};
