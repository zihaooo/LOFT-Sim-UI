import type { AirCorridor, FlowDefinition, ScenePoint, UavSchedule, UavState } from "../types";
import { DEFAULT_UAV_SPEED_METERS_PER_SECOND } from "../constant";

/** Expands flow definitions into one UavSchedule per departure in the configured hour. */
export function createFleet(corridors: AirCorridor[], flows: FlowDefinition[]): UavSchedule[] {
  const corridorById = new Map(corridors.map((corridor) => [corridor.id, corridor]));
  const fleet: UavSchedule[] = [];

  flows.forEach((flow, flowIndex) => {
    const corridor = corridorById.get(flow.corridorId);
    if (!corridor || corridor.length <= 0 || flow.uavPerHour <= 0) {
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
        corridorId: corridor.id,
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
export function computeUavState(corridor: AirCorridor, distance: number): UavState {
  if (corridor.points.length === 0 || corridor.length <= 0) {
    return {
      position: { x: 0, y: 0, z: 0 },
      tangent: { x: 1, y: 0, z: 0 },
      distance: 0,
      progress: 0,
      status: "destroyed",
    };
  }

  if (distance < 0) {
    return createNonActiveUavState(corridor, 0, "pending");
  }

  const targetDistance = Math.min(distance, corridor.length);
  let hasBeenAirborne = corridor.points[0]?.y > 0;

  for (let index = 1; index < corridor.points.length; index += 1) {
    const segmentStartDistance = corridor.cumulativeLengths[index - 1];
    const segmentEndDistance = corridor.cumulativeLengths[index];
    const start = corridor.points[index - 1];
    const end = corridor.points[index];

    if (hasBeenAirborne) {
      const groundContactDistance = getGroundContactDistance(start, end, segmentStartDistance, segmentEndDistance);
      if (groundContactDistance !== null && groundContactDistance <= targetDistance) {
        return {
          ...interpolateUavState(corridor, index, groundContactDistance),
          status: "destroyed",
        };
      }
    }

    if (targetDistance <= segmentEndDistance || index === corridor.points.length - 1) {
      const uavState = interpolateUavState(corridor, index, targetDistance);
      const status =
        distance < corridor.length && (uavState.position.y > 0 || (targetDistance === 0 && uavState.position.y === 0))
          ? "active"
          : "destroyed";
      return {
        ...uavState,
        status,
      };
    }

    hasBeenAirborne = hasBeenAirborne || start.y > 0 || end.y > 0;
  }

  return createNonActiveUavState(corridor, corridor.length, "destroyed");
}

/** Computes a UAV's one-shot corridor position from its scheduled departure time and elapsed sim time. */
export function getUavCorridorPosition(
  uavSchedule: UavSchedule,
  corridor: AirCorridor,
  elapsedSeconds: number,
  speedMultiplier: number,
): UavState {
  const flightSeconds = elapsedSeconds * speedMultiplier - uavSchedule.departureTimeSeconds;

  if (flightSeconds < 0) {
    return createNonActiveUavState(corridor, 0, "pending");
  }

  return computeUavState(corridor, flightSeconds * uavSchedule.speedMetersPerSecond);
}

/** Builds a UavState with the given non-active status, sampled at the clamped distance along the corridor. */
function createNonActiveUavState(
  corridor: AirCorridor,
  distance: number,
  status: UavState["status"],
): UavState {
  return {
    ...interpolateUavState(corridor, findSegmentIndex(corridor, distance), Math.min(Math.max(distance, 0), corridor.length)),
    status,
  };
}

/** Interpolates position, tangent, and progress within a single corridor segment at the given arc-length. */
function interpolateUavState(
  corridor: AirCorridor,
  segmentIndex: number,
  distance: number,
): Omit<UavState, "status"> {
  const start = corridor.points[Math.max(segmentIndex - 1, 0)] ?? { x: 0, y: 0, z: 0 };
  const end = corridor.points[segmentIndex] ?? start;
  const segmentStartDistance = corridor.cumulativeLengths[Math.max(segmentIndex - 1, 0)] ?? 0;
  const segmentEndDistance = corridor.cumulativeLengths[segmentIndex] ?? segmentStartDistance;
  const segmentLength = Math.max(segmentEndDistance - segmentStartDistance, 0.0001);
  const t = Math.min(Math.max((distance - segmentStartDistance) / segmentLength, 0), 1);
  const tangent = normalize(subtractPoints(end, start));

  return {
    position: lerpPoint(start, end, t),
    tangent,
    distance,
    progress: corridor.length > 0 ? distance / corridor.length : 0,
  };
}

/** Returns the index of the corridor segment containing the given arc-length distance. */
function findSegmentIndex(corridor: AirCorridor, distance: number): number {
  const clampedDistance = Math.min(Math.max(distance, 0), corridor.length);

  for (let index = 1; index < corridor.points.length; index += 1) {
    const segmentEndDistance = corridor.cumulativeLengths[index];
    if (clampedDistance <= segmentEndDistance || index === corridor.points.length - 1) {
      return index;
    }
  }

  return Math.max(corridor.points.length - 1, 0);
}

/** Returns the arc-length where the segment crosses y=0 (ground), or null if it never descends to ground. */
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

/** Componentwise vector subtraction (a - b) between two scene points. */
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
