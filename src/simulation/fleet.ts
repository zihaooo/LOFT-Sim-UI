import type { AirRoute, FlowDefinition, SampledRoutePosition, ScenePoint, UavState } from "../types";

const DEFAULT_UAV_SPEED_METERS_PER_SECOND = 12;

/** Expands flow definitions into one UavState per hourly UAV, spaced evenly along their route. */
export function createFleet(routes: AirRoute[], flows: FlowDefinition[]): UavState[] {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const fleet: UavState[] = [];

  flows.forEach((flow, flowIndex) => {
    const route = routeById.get(flow.routeId);
    if (!route || route.length <= 0 || flow.uavPerHour <= 0) {
      return;
    }

    const count = Math.round(flow.uavPerHour);
    const speedMetersPerSecond = DEFAULT_UAV_SPEED_METERS_PER_SECOND + flowIndex * 3;

    for (let index = 0; index < count; index += 1) {
      fleet.push({
        id: `UAV-${flow.flowId}-${String(index + 1).padStart(3, "0")}`,
        type: index % 5 === 0 ? "cargo" : "inspection",
        routeId: route.id,
        platoonId: `P-${flow.flowId}`,
        speedMetersPerSecond,
        offsetMeters: (route.length * index) / count,
        status: "active",
      });
    }
  });

  return fleet;
}

/** Returns the position and tangent at a given arc-length along the route, looping when distance exceeds route length. */
export function sampleRoutePosition(route: AirRoute, distance: number): SampledRoutePosition {
  if (route.points.length === 0 || route.length <= 0) {
    return {
      position: { x: 0, y: 0, z: 0 },
      tangent: { x: 1, y: 0, z: 0 },
      distance: 0,
      progress: 0,
    };
  }

  const loopedDistance = positiveModulo(distance, route.length);

  for (let index = 1; index < route.points.length; index += 1) {
    const segmentStartDistance = route.cumulativeLengths[index - 1];
    const segmentEndDistance = route.cumulativeLengths[index];

    if (loopedDistance <= segmentEndDistance || index === route.points.length - 1) {
      const start = route.points[index - 1];
      const end = route.points[index];
      const segmentLength = Math.max(segmentEndDistance - segmentStartDistance, 0.0001);
      const t = (loopedDistance - segmentStartDistance) / segmentLength;
      const tangent = normalize({
        x: end.x - start.x,
        y: end.y - start.y,
        z: end.z - start.z,
      });

      return {
        position: lerpPoint(start, end, t),
        tangent,
        distance: loopedDistance,
        progress: loopedDistance / route.length,
      };
    }
  }

  const lastPoint = route.points[route.points.length - 1];
  return {
    position: lastPoint,
    tangent: { x: 1, y: 0, z: 0 },
    distance: loopedDistance,
    progress: loopedDistance / route.length,
  };
}

/** Computes a UAV's current route sample by converting elapsed sim time + speed multiplier into arc-length. */
export function getUavRoutePosition(
  uav: UavState,
  route: AirRoute,
  elapsedSeconds: number,
  speedMultiplier: number,
): SampledRoutePosition {
  return sampleRoutePosition(route, uav.offsetMeters + elapsedSeconds * uav.speedMetersPerSecond * speedMultiplier);
}

/** Returns a remainder always in [0, divisor) — JS `%` returns negative results for negative operands. */
function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Componentwise linear interpolation between two scene points. */
function lerpPoint(start: ScenePoint, end: ScenePoint, t: number): ScenePoint {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t,
  };
}

/** Returns a unit vector for the given point, falling back to +X for zero-length input to avoid NaN tangents. */
function normalize(point: ScenePoint): ScenePoint {
  const length = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z);
  if (length === 0) {
    return { x: 1, y: 0, z: 0 };
  }

  return {
    x: point.x / length,
    y: point.y / length,
    z: point.z / length,
  };
}
