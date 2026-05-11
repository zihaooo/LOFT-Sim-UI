import { describe, expect, it } from "vitest";
import {
  TELEMETRY_DRONE_RECORD_BYTES,
  TELEMETRY_HEADER_BYTES,
  TelemetrySnapshotBuffer,
  convertTelemetrySnapshotToScene,
  parseTelemetrySnapshotFrame,
  simulatorPointToScenePoint,
} from "./protocol";

function makeFrame(droneCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(TELEMETRY_HEADER_BYTES + droneCount * TELEMETRY_DRONE_RECORD_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, 7, true);
  view.setFloat64(4, 12.5, true);
  view.setUint32(12, droneCount, true);

  for (let index = 0; index < droneCount; index += 1) {
    const offset = TELEMETRY_HEADER_BYTES + index * TELEMETRY_DRONE_RECORD_BYTES;
    view.setUint32(offset, index + 1, true);
    view.setUint16(offset + 4, 1, true);
    view.setUint16(offset + 6, 2, true);
    view.setUint32(offset + 8, 3, true);
    view.setFloat32(offset + 12, 10 + index, true);
    view.setFloat32(offset + 16, 20 + index, true);
    view.setFloat32(offset + 20, 30 + index, true);
    view.setFloat32(offset + 24, 1, true);
    view.setFloat32(offset + 28, 2, true);
    view.setFloat32(offset + 32, 3, true);
    view.setFloat32(offset + 36, 0.5, true);
    view.setFloat32(offset + 40, 0.25, true);
    view.setFloat32(offset + 44, 0.125, true);
    view.setFloat32(offset + 48, 42, true);
  }

  return buffer;
}

describe("telemetry binary protocol", () => {
  it("decodes a valid snapshot frame", () => {
    const snapshot = parseTelemetrySnapshotFrame(makeFrame(2));

    expect(snapshot.sequence).toBe(7);
    expect(snapshot.simTimeSeconds).toBe(12.5);
    expect(snapshot.drones).toHaveLength(2);
    expect(snapshot.drones[0]).toMatchObject({
      handle: 1,
      stateCode: 1,
      vehicleTypeCode: 2,
      routeHandle: 3,
      position: { x: 10, y: 20, z: 30 },
      velocity: { x: 1, y: 2, z: 3 },
      speedMetersPerSecond: 42,
    });
  });

  it("decodes an empty snapshot", () => {
    const snapshot = parseTelemetrySnapshotFrame(makeFrame(0));

    expect(snapshot.sequence).toBe(7);
    expect(snapshot.drones).toHaveLength(0);
  });

  it("rejects a truncated header", () => {
    expect(() => parseTelemetrySnapshotFrame(new ArrayBuffer(4))).toThrow(/header/);
  });

  it("rejects a frame whose byte length does not match drone_count", () => {
    const buffer = makeFrame(1).slice(0, TELEMETRY_HEADER_BYTES + 4);

    expect(() => parseTelemetrySnapshotFrame(buffer)).toThrow(/length mismatch/);
  });
});

describe("telemetry coordinate conversion", () => {
  it("maps simulator east/north/altitude axes into frontend north/altitude/east axes", () => {
    const point = simulatorPointToScenePoint(
      { x: 10, y: 20, z: 30 },
      { lat: 0, lon: 0 },
    );

    expect(point).toEqual({ x: 20, y: 30, z: 10 });
  });

  it("converts through projection metadata when simulator and frontend origins differ", () => {
    const point = simulatorPointToScenePoint(
      { x: 111_320, y: 111_320, z: 50 },
      { lat: 1, lon: 1 },
      {
        originLat: 0,
        originLon: 0,
        metersPerDegreeLat: 111_320,
        metersPerDegreeLon: 111_320,
      },
    );

    expect(point.x).toBeCloseTo(0);
    expect(point.y).toBe(50);
    expect(point.z).toBeCloseTo(0);
  });

  it("converts all drones in a snapshot", () => {
    const sceneSnapshot = convertTelemetrySnapshotToScene(
      parseTelemetrySnapshotFrame(makeFrame(1)),
      { lat: 0, lon: 0 },
      undefined,
      100,
    );

    expect(sceneSnapshot.receivedAtMs).toBe(100);
    expect(sceneSnapshot.drones[0].position).toEqual({ x: 20, y: 30, z: 10 });
    expect(sceneSnapshot.drones[0].velocity).toEqual({ x: 2, y: 3, z: 1 });
  });
});

describe("telemetry snapshot buffer", () => {
  it("keeps only the newest snapshots up to its fixed capacity", () => {
    const buffer = new TelemetrySnapshotBuffer(2);
    const base = convertTelemetrySnapshotToScene(parseTelemetrySnapshotFrame(makeFrame(0)), { lat: 0, lon: 0 });

    buffer.push({ ...base, sequence: 1 });
    buffer.push({ ...base, sequence: 2 });
    buffer.push({ ...base, sequence: 3 });

    expect(buffer.size()).toBe(2);
    expect(buffer.latest()?.sequence).toBe(3);
  });

  it("ignores stale snapshots", () => {
    const buffer = new TelemetrySnapshotBuffer(3);
    const base = convertTelemetrySnapshotToScene(parseTelemetrySnapshotFrame(makeFrame(0)), { lat: 0, lon: 0 });

    buffer.push({ ...base, sequence: 5 });
    buffer.push({ ...base, sequence: 4 });

    expect(buffer.size()).toBe(1);
    expect(buffer.latest()?.sequence).toBe(5);
  });
});
