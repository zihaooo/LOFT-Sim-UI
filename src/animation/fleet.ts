import type { AirRoute, FlowDefinition, ScenePoint, UavSchedule, UavState } from "../types";
import { DEFAULT_UAV_SPEED_METERS_PER_SECOND } from "../constant";

/** Expands flow definitions into one UavSchedule per departure in the configured hour. */
export function createFleet(routes: AirRoute[], flows: FlowDefinition[]): UavSchedule[] {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const fleet: UavSchedule[] = [];

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
      });
    }
  });

  return fleet;
}

/** Returns the position and tangent at a given arc-length; non-active status means the one-shot flight has not started or has ended. */
export function sampleRoutePosition(route: AirRoute, distance: number): UavState {
  if (route.points.length === 0 || route.length <= 0) {
    return {
      position: { x: 0, y: 0, z: 0 },
      tangent: { x: 1, y: 0, z: 0 },
      distance: 0,
      progress: 0,
      status: "destroyed",
    };
  }

  if (distance < 0) {
    return createInactiveRouteSample(route, 0, "pending");
  }

  const targetDistance = Math.min(distance, route.length);
  let hasBeenAirborne = route.points[0]?.y > 0;

  for (let index = 1; index < route.points.length; index += 1) {
    const segmentStartDistance = route.cumulativeLengths[index - 1];
    const segmentEndDistance = route.cumulativeLengths[index];
    const start = route.points[index - 1];
    const end = route.points[index];

    if (hasBeenAirborne) {
      const groundContactDistance = getGroundContactDistance(start, end, segmentStartDistance, segmentEndDistance);
      if (groundContactDistance !== null && groundContactDistance <= targetDistance) {
        return {
          ...sampleRouteSegment(route, index, groundContactDistance),
          status: "destroyed",
        };
      }
    }

    if (targetDistance <= segmentEndDistance || index === route.points.length - 1) {
      const sample = sampleRouteSegment(route, index, targetDistance);
      const status =
        distance < route.length && (sample.position.y > 0 || (targetDistance === 0 && sample.position.y === 0))
          ? "active"
          : "destroyed";
      return {
        ...sample,
        status,
      };
    }

    hasBeenAirborne = hasBeenAirborne || start.y > 0 || end.y > 0;
  }

  return createInactiveRouteSample(route, route.length, "destroyed");
}

/** Computes a UAV's one-shot route position from its scheduled departure time and elapsed sim time. */
export function getUavRoutePosition(
  uav: UavSchedule,
  route: AirRoute,
  elapsedSeconds: number,
  speedMultiplier: number,
): UavState {
  const flightSeconds = elapsedSeconds * speedMultiplier - uav.departureTimeSeconds;

  if (flightSeconds < 0) {
    return createInactiveRouteSample(route, 0, "pending");
  }

  return sampleRoutePosition(route, flightSeconds * uav.speedMetersPerSecond);
}

function createInactiveRouteSample(
  route: AirRoute,
  distance: number,
  status: UavState["status"],
): UavState {
  return {
    ...sampleRouteSegment(route, findSegmentIndex(route, distance), Math.min(Math.max(distance, 0), route.length)),
    status,
  };
}

function sampleRouteSegment(
  route: AirRoute,
  segmentIndex: number,
  distance: number,
): Omit<UavState, "status"> {
  const start = route.points[Math.max(segmentIndex - 1, 0)] ?? { x: 0, y: 0, z: 0 };
  const end = route.points[segmentIndex] ?? start;
  const segmentStartDistance = route.cumulativeLengths[Math.max(segmentIndex - 1, 0)] ?? 0;
  const segmentEndDistance = route.cumulativeLengths[segmentIndex] ?? segmentStartDistance;
  const segmentLength = Math.max(segmentEndDistance - segmentStartDistance, 0.0001);
  const t = Math.min(Math.max((distance - segmentStartDistance) / segmentLength, 0), 1);
  const tangent = normalize(subtractPoints(end, start));

  return {
    position: lerpPoint(start, end, t),
    tangent,
    distance,
    progress: route.length > 0 ? distance / route.length : 0,
  };
}

function findSegmentIndex(route: AirRoute, distance: number): number {
  const clampedDistance = Math.min(Math.max(distance, 0), route.length);

  for (let index = 1; index < route.points.length; index += 1) {
    const segmentEndDistance = route.cumulativeLengths[index];
    if (clampedDistance <= segmentEndDistance || index === route.points.length - 1) {
      return index;
    }
  }

  return Math.max(route.points.length - 1, 0);
}

function getGroundContactDistance(
  start: ScenePoint,
  end: ScenePoint,
  segmentStartDistance: number,
  segmentEndDistance: number,
): number | null {
  if (start.y <= 0 || end.y > 0) {
    return null;
  }

  const t = start.y / (start.y - end.y);
  return segmentStartDistance + (segmentEndDistance - segmentStartDistance) * t;
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
