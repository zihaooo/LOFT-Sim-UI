import { describe, expect, it } from "vitest";
import type { AirCorridor } from "../types";
import { computeUavState, createFleet, getUavCorridorPosition } from "./fleet";

const corridor: AirCorridor = {
  id: "A",
  name: "Corridor A",
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
    const fleet = createFleet([corridor], [{ flowId: "1", corridorId: "A", uavPerHour: 12 }]);

    expect(fleet).toHaveLength(12);
    expect(fleet[0]).toMatchObject({
      id: "UAV-1-001",
      corridorId: "A",
      platoonId: "P-1",
      departureTimeSeconds: 0,
      cycleSeconds: 3600,
    });
    expect(fleet[1].departureTimeSeconds).toBe(300);
    expect(fleet[11].departureTimeSeconds).toBe(3300);
    expect(fleet.every((uav) => uav.offsetMeters === 0)).toBe(true);
    expect(fleet[0]).not.toHaveProperty("status");
  });

  it("ignores flows with missing corridors", () => {
    const fleet = createFleet([corridor], [{ flowId: "2", corridorId: "missing", uavPerHour: 50 }]);

    expect(fleet).toHaveLength(0);
  });
});

describe("corridor state computation", () => {
  it("computes positions across corridor segments", () => {
    expect(computeUavState(corridor, 50).position).toEqual({ x: 50, y: 10, z: 0 });
    expect(computeUavState(corridor, 150).position).toEqual({ x: 100, y: 10, z: 50 });
  });

  it("does not loop distances outside the one-shot corridor travel window", () => {
    const afterArrival = computeUavState(corridor, 250);
    const beforeDeparture = computeUavState(corridor, -50);

    expect(afterArrival.position).toEqual({ x: 100, y: 10, z: 100 });
    expect(afterArrival.progress).toBe(1);
    expect(afterArrival.status).toBe("destroyed");
    expect(beforeDeparture.position).toEqual({ x: 0, y: 10, z: 0 });
    expect(beforeDeparture.status).toBe("pending");
  });

  it("marks corridor state destroyed at the first ground contact", () => {
    const landingCorridor: AirCorridor = {
      ...corridor,
      points: [
        { x: 0, y: 10, z: 0 },
        { x: 100, y: -10, z: 0 },
        { x: 200, y: 10, z: 0 },
      ],
      length: 200,
      segmentLengths: [100, 100],
      cumulativeLengths: [0, 100, 200],
    };

    const beforeContact = computeUavState(landingCorridor, 25);
    const afterContact = computeUavState(landingCorridor, 175);

    expect(beforeContact.status).toBe("active");
    expect(afterContact.status).toBe("destroyed");
    expect(afterContact.position).toEqual({ x: 50, y: 0, z: 0 });
  });

  it("computes a UAV using elapsed time and speed multiplier", () => {
    const uav = createFleet([corridor], [{ flowId: "1", corridorId: "A", uavPerHour: 1 }])[0];
    const uavState = getUavCorridorPosition(uav, corridor, 2, 2);
    const expectedDistance = 2 * uav.speedMetersPerSecond * 2;

    expect(uavState.position.x).toBe(expectedDistance);
    expect(uavState.progress).toBeCloseTo(expectedDistance / corridor.length);
    expect(uavState.status).toBe("active");
  });

  it("marks scheduled UAVs pending or destroyed outside their corridor travel window", () => {
    const uav = createFleet([corridor], [{ flowId: "1", corridorId: "A", uavPerHour: 12 }])[1];
    const beforeDeparture = getUavCorridorPosition(uav, corridor, 10, 1);
    const afterDeparture = getUavCorridorPosition(uav, corridor, 302, 1);
    const afterArrival = getUavCorridorPosition(uav, corridor, 330, 1);

    expect(beforeDeparture.status).toBe("pending");
    expect(afterDeparture.status).toBe("active");
    expect(afterDeparture.position.x).toBe(24);
    expect(afterArrival.status).toBe("destroyed");
  });
});
