import { describe, expect, it } from "vitest";
import type { AirRoute } from "../types";
import { computeUavState, createFleet, getUavRoutePosition } from "./demoFleet";

const route: AirRoute = {
  id: "A",
  name: "Route A",
  from: "Start",
  to: "End",
  color: "#47c2ff",
  envelopeRadius: 15,
  componentId: 0,
  geoPoints: [],
  points: [
    { x: 0, y: 10, z: 0 },
    { x: 100, y: 10, z: 0 },
    { x: 100, y: 10, z: 100 },
  ],
  nodeIds: ["n0", "n1", "n2"],
  vertiportFlags: [true, false, true],
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
    });
    expect(fleet[1].departureTimeSeconds).toBe(300);
    expect(fleet[11].departureTimeSeconds).toBe(3300);
    expect(fleet.every((uav) => uav.offsetMeters === 0)).toBe(true);
    expect(fleet[0]).not.toHaveProperty("status");
  });

  it("ignores flows with missing routes", () => {
    const fleet = createFleet([route], [{ flowId: "2", routeId: "missing", uavPerHour: 50 }]);

    expect(fleet).toHaveLength(0);
  });
});

describe("route state computation", () => {
  it("computes positions across route segments", () => {
    expect(computeUavState(route, 50).position).toEqual({ x: 50, y: 10, z: 0 });
    expect(computeUavState(route, 150).position).toEqual({ x: 100, y: 10, z: 50 });
  });

  it("does not loop distances outside the one-shot route travel window", () => {
    const afterArrival = computeUavState(route, 250);
    const beforeDeparture = computeUavState(route, -50);

    expect(afterArrival.position).toEqual({ x: 100, y: 10, z: 100 });
    expect(afterArrival.progress).toBe(1);
    expect(afterArrival.status).toBe("destroyed");
    expect(beforeDeparture.position).toEqual({ x: 0, y: 10, z: 0 });
    expect(beforeDeparture.status).toBe("pending");
  });

  it("marks route state destroyed at the first ground contact", () => {
    const landingRoute: AirRoute = {
      ...route,
      points: [
        { x: 0, y: 10, z: 0 },
        { x: 100, y: -10, z: 0 },
        { x: 200, y: 10, z: 0 },
      ],
      length: 200,
      segmentLengths: [100, 100],
      cumulativeLengths: [0, 100, 200],
    };

    const beforeContact = computeUavState(landingRoute, 25);
    const afterContact = computeUavState(landingRoute, 175);

    expect(beforeContact.status).toBe("active");
    expect(afterContact.status).toBe("destroyed");
    expect(afterContact.position).toEqual({ x: 50, y: 0, z: 0 });
  });

  it("computes a UAV using elapsed time and speed multiplier", () => {
    const uav = createFleet([route], [{ flowId: "1", routeId: "A", uavPerHour: 1 }])[0];
    const uavState = getUavRoutePosition(uav, route, 2, 2);
    const expectedDistance = 2 * uav.speedMetersPerSecond * 2;

    expect(uavState.position.x).toBe(expectedDistance);
    expect(uavState.progress).toBeCloseTo(expectedDistance / route.length);
    expect(uavState.status).toBe("active");
  });

  it("marks scheduled UAVs pending or destroyed outside their route travel window", () => {
    const uav = createFleet([route], [{ flowId: "1", routeId: "A", uavPerHour: 12 }])[1];
    const beforeDeparture = getUavRoutePosition(uav, route, 10, 1);
    const afterDeparture = getUavRoutePosition(uav, route, 302, 1);
    const afterArrival = getUavRoutePosition(uav, route, 330, 1);

    expect(beforeDeparture.status).toBe("pending");
    expect(afterDeparture.status).toBe("active");
    expect(afterDeparture.position.x).toBe(24);
    expect(afterArrival.status).toBe("destroyed");
  });
});
