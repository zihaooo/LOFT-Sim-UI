import { METERS_PER_DEGREE_LAT } from "../constant";
import type { ProjectionOrigin, ScenePoint } from "../types";

export const TELEMETRY_HEADER_BYTES = 52;
export const TELEMETRY_DRONE_RECORD_BYTES = 64;

/** Human-readable labels for the wire state codes (code 0 covers both IDLE and COMPLETED). */
export const TELEMETRY_STATE_LABELS: Record<number, string> = {
  0: "Idle",
  1: "Takeoff",
  2: "Cruise",
  3: "Landing",
  4: "Waiting",
};

export type SimulatorPoint = {
  x: number;
  y: number;
  z: number;
};

export type TelemetryProjection = {
  originLat: number;
  originLon: number;
  metersPerDegreeLat: number;
  metersPerDegreeLon: number;
};

export type SimulatorTelemetryDrone = {
  handle: number;
  stateCode: number;
  vehicleTypeCode: number;
  corridorHandle: number;
  routeHandle: number;
  position: SimulatorPoint;
  velocity: SimulatorPoint;
  yaw: number;
  pitch: number;
  roll: number;
  speedMetersPerSecond: number;
  energyJoules: number;
  powerWatts: number;
};

/**
 * Sim-computed fleet aggregates carried in the snapshot header. Definitions match the
 * simulator's SummaryWriter: counts cover the drones currently in the run (arrived/spawned
 * are cumulative), holds are tactical holds, and total energy sums the current drones only —
 * it dips when a vehicle completes, exactly as in the summary output file.
 */
export type TelemetryFleetStats = {
  takeoffCount: number;
  cruiseCount: number;
  landingCount: number;
  waitingCount: number;
  holdCount: number;
  arrivedCount: number;
  spawnedCount: number;
  totalEnergyJoules: number;
};

export type SimulatorTelemetrySnapshot = {
  sequence: number;
  simTimeSeconds: number;
  stats: TelemetryFleetStats;
  drones: SimulatorTelemetryDrone[];
};

export type TelemetryDroneState = Omit<SimulatorTelemetryDrone, "position" | "velocity"> & {
  position: ScenePoint;
  velocity: ScenePoint;
};

export type TelemetrySnapshot = {
  sequence: number;
  simTimeSeconds: number;
  receivedAtMs: number;
  stats: TelemetryFleetStats;
  drones: TelemetryDroneState[];
};

export type TelemetryRegistryDrone = {
  handle: number;
  id: string;
  vehicleType: string;
  /** Node ids of the drone's start/end nodes; optional at the wire boundary, "" when unknown. */
  origin?: string;
  destination?: string;
};

export type TelemetryRegistryCorridor = {
  handle: number;
  id: string;
};

export type TelemetryRegistryRoute = {
  handle: number;
  id: string;
};

export type TelemetryRegistry = {
  dronesByHandle: Map<number, TelemetryRegistryDrone>;
  corridorsByHandle: Map<number, TelemetryRegistryCorridor>;
  routesByHandle: Map<number, TelemetryRegistryRoute>;
};

/** Decodes the minimal little-endian binary snapshot frame used by mock and simulator telemetry. */
export function parseTelemetrySnapshotFrame(frame: ArrayBuffer): SimulatorTelemetrySnapshot {
  if (frame.byteLength < TELEMETRY_HEADER_BYTES) {
    throw new Error("Telemetry snapshot frame is shorter than the header.");
  }

  const view = new DataView(frame);
  const sequence = view.getUint32(0, true);
  const simTimeSeconds = view.getFloat64(4, true);
  const droneCount = view.getUint32(12, true);
  const stats: TelemetryFleetStats = {
    takeoffCount: view.getUint32(16, true),
    cruiseCount: view.getUint32(20, true),
    landingCount: view.getUint32(24, true),
    waitingCount: view.getUint32(28, true),
    holdCount: view.getUint32(32, true),
    arrivedCount: view.getUint32(36, true),
    spawnedCount: view.getUint32(40, true),
    totalEnergyJoules: view.getFloat64(44, true),
  };
  const expectedBytes = TELEMETRY_HEADER_BYTES + droneCount * TELEMETRY_DRONE_RECORD_BYTES;

  if (frame.byteLength !== expectedBytes) {
    throw new Error(`Telemetry snapshot length mismatch: expected ${expectedBytes}, got ${frame.byteLength}.`);
  }

  const drones: SimulatorTelemetryDrone[] = [];
  let offset = TELEMETRY_HEADER_BYTES;

  for (let index = 0; index < droneCount; index += 1) {
    const handle = view.getUint32(offset, true);
    const stateCode = view.getUint16(offset + 4, true);
    const vehicleTypeCode = view.getUint16(offset + 6, true);
    const corridorHandle = view.getUint32(offset + 8, true);
    const routeHandle = view.getUint32(offset + 12, true);
    const x = view.getFloat32(offset + 16, true);
    const y = view.getFloat32(offset + 20, true);
    const z = view.getFloat32(offset + 24, true);
    const vx = view.getFloat32(offset + 28, true);
    const vy = view.getFloat32(offset + 32, true);
    const vz = view.getFloat32(offset + 36, true);
    const yaw = view.getFloat32(offset + 40, true);
    const pitch = view.getFloat32(offset + 44, true);
    const roll = view.getFloat32(offset + 48, true);
    const speedMetersPerSecond = view.getFloat32(offset + 52, true);
    const energyJoules = view.getFloat32(offset + 56, true);
    const powerWatts = view.getFloat32(offset + 60, true);

    drones.push({
      handle,
      stateCode,
      vehicleTypeCode,
      corridorHandle,
      routeHandle,
      position: { x, y, z },
      velocity: { x: vx, y: vy, z: vz },
      yaw,
      pitch,
      roll,
      speedMetersPerSecond,
      energyJoules,
      powerWatts,
    });

    offset += TELEMETRY_DRONE_RECORD_BYTES;
  }

  return { sequence, simTimeSeconds, stats, drones };
}

/** Converts simulator coordinates (east, north, altitude) into the frontend's (north, altitude, east) scene frame. */
export function simulatorPointToScenePoint(
  point: SimulatorPoint,
  frontendOrigin: ProjectionOrigin,
  simulatorProjection?: TelemetryProjection,
): ScenePoint {
  if (!simulatorProjection) {
    return { x: point.y, y: point.z, z: point.x };
  }

  const lat = simulatorProjection.originLat + point.y / simulatorProjection.metersPerDegreeLat;
  const lon = simulatorProjection.originLon + point.x / simulatorProjection.metersPerDegreeLon;
  const frontendMetersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((frontendOrigin.lat * Math.PI) / 180);

  return {
    x: (lat - frontendOrigin.lat) * METERS_PER_DEGREE_LAT,
    y: point.z,
    z: (lon - frontendOrigin.lon) * frontendMetersPerDegreeLon,
  };
}

/** Velocity is already in meters per second, so it only needs the simulator-to-scene axis mapping. */
export function simulatorVelocityToScenePoint(velocity: SimulatorPoint): ScenePoint {
  return { x: velocity.y, y: velocity.z, z: velocity.x };
}

export function convertTelemetrySnapshotToScene(
  snapshot: SimulatorTelemetrySnapshot,
  frontendOrigin: ProjectionOrigin,
  simulatorProjection?: TelemetryProjection,
  receivedAtMs = performance.now(),
): TelemetrySnapshot {
  return {
    sequence: snapshot.sequence,
    simTimeSeconds: snapshot.simTimeSeconds,
    receivedAtMs,
    stats: snapshot.stats,
    drones: snapshot.drones.map((drone) => ({
      ...drone,
      position: simulatorPointToScenePoint(drone.position, frontendOrigin, simulatorProjection),
      velocity: simulatorVelocityToScenePoint(drone.velocity),
    })),
  };
}

/**
 * Holds the single most recent snapshot, deduped by sequence: push() rejects (returns false for) a
 * frame at or behind the held one, which the client counts as a drop. Rendering only ever consumes
 * the latest state — there is no interpolation — so no history is kept.
 */
export class TelemetrySnapshotBuffer {
  private snapshot: TelemetrySnapshot | undefined;

  push(snapshot: TelemetrySnapshot): boolean {
    if (this.snapshot && snapshot.sequence <= this.snapshot.sequence) {
      return false;
    }

    this.snapshot = snapshot;
    return true;
  }

  latest(): TelemetrySnapshot | undefined {
    return this.snapshot;
  }

  clear(): void {
    this.snapshot = undefined;
  }
}
