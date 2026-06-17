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

export type AirCorridor = {
  id: string;
  name: string;
  from: string;
  to: string;
  color: string;
  envelopeRadius: number;
  /** Index of the connected component this corridor belongs to; all corridors in a component share one color. */
  componentId: number;
  points: ScenePoint[];
  geoPoints: GeoPoint[];
  /** OSM node id per point (aligned with `points`); used to detect shared junction nodes across corridors. */
  nodeIds: string[];
  /** Per-point flag (aligned with `points`): true when the node is a vertiport terminal, which never connects onward. */
  vertiportFlags: boolean[];
  length: number;
  segmentLengths: number[];
  cumulativeLengths: number[];
};

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

export type FlowDefinition = {
  flowId: string;
  corridorId: string;
  uavPerHour: number;
};

export type UavSchedule = {
  id: string;
  type: string;
  corridorId: string;
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
  mapBounds: SceneBounds;
  corridors: AirCorridor[];
  buildings: BuildingFootprint[];
  roads: RoadPath[];
  trees: TreePoint[];
  flows: FlowDefinition[];
};
