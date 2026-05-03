export type GeoPoint = {
  lat: number;
  lon: number;
  elevation: number;
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

export type AirRoute = {
  id: string;
  name: string;
  from: string;
  to: string;
  color: string;
  envelopeRadius: number;
  points: ScenePoint[];
  geoPoints: GeoPoint[];
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
  mapBounds: SceneBounds;
  routes: AirRoute[];
  buildings: BuildingFootprint[];
  roads: RoadPath[];
  trees: TreePoint[];
  flows: FlowDefinition[];
};
