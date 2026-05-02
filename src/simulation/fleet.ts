import type { AirRoute, FlowDefinition, SampledRoutePosition, ScenePoint, UavState } from "../types";
import { DEFAULT_UAV_SPEED_METERS_PER_SECOND } from "../constant";

/** Expands flow definitions into one scheduled UavState per departure in a repeating flow cycle. */
export function createFleet(routes: AirRoute[], flows: FlowDefinition[]): UavState[] {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const fleet: UavState[] = [];

  flows.forEach((flow, flowIndex) => {
    const route = routeById.get(flow.routeId);
    if (!route || route.length <= 0 || flow.uavPerHour <= 0) {
      return;
    }

    const speedMetersPerSecond = DEFAULT_UAV_SPEED_METERS_PER_SECOND + flowIndex * 3;
    const departureIntervalSeconds = 3600 / flow.uavPerHour;
    const count = Math.max(1, Math.ceil(flow.uavPerHour));
    const cycleSeconds = count * departureIntervalSeconds;

    for (let index = 0; index < count; index += 1) {
      fleet.push({
        id: `UAV-${flow.flowId}-${String(index + 1).padStart(3, "0")}`,
        type: index % 5 === 0 ? "cargo" : "inspection",
        routeId: route.id,
        platoonId: `P-${flow.flowId}`,
        speedMetersPerSecond,
        offsetMeters: 0,
        departureTimeSeconds: index * departureIntervalSeconds,
        cycleSeconds,
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
      active: false,
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
        active: true,
      };
    }
  }

  const lastPoint = route.points[route.points.length - 1];
  return {
    position: lastPoint,
    tangent: { x: 1, y: 0, z: 0 },
    distance: loopedDistance,
    progress: loopedDistance / route.length,
    active: true,
  };
}

/** Computes a UAV's current route sample from its scheduled departure cadence and elapsed sim time. */
export function getUavRoutePosition(
  uav: UavState,
  route: AirRoute,
  elapsedSeconds: number,
  speedMultiplier: number,
): SampledRoutePosition {
  const scheduledSeconds = positiveModulo(elapsedSeconds * speedMultiplier - uav.departureTimeSeconds, uav.cycleSeconds);
  const flightDurationSeconds = route.length / uav.speedMetersPerSecond;

  if (scheduledSeconds >= flightDurationSeconds) {
    return {
      position: route.points[0] ?? { x: 0, y: 0, z: 0 },
      tangent: route.points.length > 1 ? normalize(subtractPoints(route.points[1], route.points[0])) : { x: 1, y: 0, z: 0 },
      distance: 0,
      progress: 0,
      active: false,
    };
  }

  return sampleRoutePosition(route, scheduledSeconds * uav.speedMetersPerSecond);
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

function subtractPoints(a: ScenePoint, b: ScenePoint): ScenePoint {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
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
