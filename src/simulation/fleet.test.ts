import { describe, expect, it } from "vitest";
import type { AirRoute } from "../types";
import { createFleet, getUavRoutePosition, sampleRoutePosition } from "./fleet";

const route: AirRoute = {
  id: "A",
  name: "Route A",
  from: "Start",
  to: "End",
  color: "#47c2ff",
  envelopeRadius: 15,
  geoPoints: [],
  points: [
    { x: 0, y: 10, z: 0 },
    { x: 100, y: 10, z: 0 },
    { x: 100, y: 10, z: 100 },
  ],
  length: 200,
  segmentLengths: [100, 100],
  cumulativeLengths: [0, 100, 200],
};

describe("fleet creation", () => {
  it("creates one visible UAV per hourly flow unit for demo-scale density", () => {
    const fleet = createFleet([route], [{ flowId: "1", routeId: "A", uavPerHour: 12 }]);

    expect(fleet).toHaveLength(12);
    expect(fleet[0]).toMatchObject({
      id: "UAV-1-001",
      routeId: "A",
      platoonId: "P-1",
      status: "active",
    });
    expect(fleet[11].offsetMeters).toBeCloseTo((200 * 11) / 12);
  });

  it("ignores flows with missing routes", () => {
    const fleet = createFleet([route], [{ flowId: "2", routeId: "missing", uavPerHour: 50 }]);

    expect(fleet).toHaveLength(0);
  });
});

describe("route sampling", () => {
  it("samples positions across route segments", () => {
    expect(sampleRoutePosition(route, 50).position).toEqual({ x: 50, y: 10, z: 0 });
    expect(sampleRoutePosition(route, 150).position).toEqual({ x: 100, y: 10, z: 50 });
  });

  it("loops distances beyond the route length", () => {
    expect(sampleRoutePosition(route, 250).position).toEqual({ x: 50, y: 10, z: 0 });
    expect(sampleRoutePosition(route, -50).position).toEqual({ x: 100, y: 10, z: 50 });
  });

  it("samples a UAV using elapsed time and speed multiplier", () => {
    const uav = createFleet([route], [{ flowId: "1", routeId: "A", uavPerHour: 1 }])[0];
    const sampled = getUavRoutePosition(uav, route, 2, 2);
    const expectedDistance = uav.offsetMeters + 2 * uav.speedMetersPerSecond * 2;

    expect(sampled.position.x).toBe(expectedDistance);
    expect(sampled.progress).toBeCloseTo(expectedDistance / route.length);
  });
});
