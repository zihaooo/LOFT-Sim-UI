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
  it("creates one scheduled UAV per departure in the hourly flow cycle", () => {
    const fleet = createFleet([route], [{ flowId: "1", routeId: "A", uavPerHour: 12 }]);

    expect(fleet).toHaveLength(12);
    expect(fleet[0]).toMatchObject({
      id: "UAV-1-001",
      routeId: "A",
      platoonId: "P-1",
      departureTimeSeconds: 0,
      cycleSeconds: 3600,
      status: "active",
    });
    expect(fleet[1].departureTimeSeconds).toBe(300);
    expect(fleet[11].departureTimeSeconds).toBe(3300);
    expect(fleet.every((uav) => uav.offsetMeters === 0)).toBe(true);
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
    const expectedDistance = 2 * uav.speedMetersPerSecond * 2;

    expect(sampled.position.x).toBe(expectedDistance);
    expect(sampled.progress).toBeCloseTo(expectedDistance / route.length);
    expect(sampled.active).toBe(true);
  });

  it("marks scheduled UAVs inactive outside their route travel window", () => {
    const uav = createFleet([route], [{ flowId: "1", routeId: "A", uavPerHour: 12 }])[1];
    const beforeDeparture = getUavRoutePosition(uav, route, 10, 1);
    const afterDeparture = getUavRoutePosition(uav, route, 302, 1);
    const afterArrival = getUavRoutePosition(uav, route, 330, 1);

    expect(beforeDeparture.active).toBe(false);
    expect(afterDeparture.active).toBe(true);
    expect(afterDeparture.position.x).toBe(24);
    expect(afterArrival.active).toBe(false);
  });
});
