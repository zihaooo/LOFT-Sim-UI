import { METERS_PER_DEGREE_LAT } from "../constant";
import type { ProjectionOrigin, ScenePoint } from "../types";

export const TELEMETRY_HEADER_BYTES = 16;
export const TELEMETRY_DRONE_RECORD_BYTES = 52;
export const TELEMETRY_SNAPSHOT_BUFFER_SIZE = 3;

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
  routeHandle: number;
  position: SimulatorPoint;
  velocity: SimulatorPoint;
  yaw: number;
  pitch: number;
  roll: number;
  speedMetersPerSecond: number;
};

export type SimulatorTelemetrySnapshot = {
  sequence: number;
  simTimeSeconds: number;
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
  drones: TelemetryDroneState[];
};

export type TelemetryRegistryDrone = {
  handle: number;
  id: string;
  vehicleType: string;
};

export type TelemetryRegistryRoute = {
  handle: number;
  id: string;
};

export type TelemetryRegistry = {
  dronesByHandle: Map<number, TelemetryRegistryDrone>;
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
    const routeHandle = view.getUint32(offset + 8, true);
    const x = view.getFloat32(offset + 12, true);
    const y = view.getFloat32(offset + 16, true);
    const z = view.getFloat32(offset + 20, true);
    const vx = view.getFloat32(offset + 24, true);
    const vy = view.getFloat32(offset + 28, true);
    const vz = view.getFloat32(offset + 32, true);
    const yaw = view.getFloat32(offset + 36, true);
    const pitch = view.getFloat32(offset + 40, true);
    const roll = view.getFloat32(offset + 44, true);
    const speedMetersPerSecond = view.getFloat32(offset + 48, true);

    drones.push({
      handle,
      stateCode,
      vehicleTypeCode,
      routeHandle,
      position: { x, y, z },
      velocity: { x: vx, y: vy, z: vz },
      yaw,
      pitch,
      roll,
      speedMetersPerSecond,
    });

    offset += TELEMETRY_DRONE_RECORD_BYTES;
  }

  return { sequence, simTimeSeconds, drones };
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
    drones: snapshot.drones.map((drone) => ({
      ...drone,
      position: simulatorPointToScenePoint(drone.position, frontendOrigin, simulatorProjection),
      velocity: simulatorVelocityToScenePoint(drone.velocity),
    })),
  };
}

export class TelemetrySnapshotBuffer {
  private readonly snapshots: TelemetrySnapshot[] = [];

  constructor(private readonly maxSize = TELEMETRY_SNAPSHOT_BUFFER_SIZE) {}

  push(snapshot: TelemetrySnapshot): boolean {
    const latest = this.latest();
    if (latest && snapshot.sequence <= latest.sequence) {
      return false;
    }

    this.snapshots.push(snapshot);
    while (this.snapshots.length > this.maxSize) {
      this.snapshots.shift();
    }
    return true;
  }

  latest(): TelemetrySnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  size(): number {
    return this.snapshots.length;
  }

  clear(): void {
    this.snapshots.length = 0;
  }
}
