import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { setUavAttitudeQuaternion, setUavYawQuaternion } from "./drone";

const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);
const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);

describe("setUavAttitudeQuaternion", () => {
  // The backend integrates velocity as speed*(cos yaw, sin yaw) in its East/North plane and the sim->scene
  // map sends East->z, North->x, so a UAV with body yaw θ travels along the scene direction (sin θ, 0, cos θ).
  it("maps backend yaw 1:1 to the scene heading the legacy tangent formula produces", () => {
    const attitude = new THREE.Quaternion();
    const legacy = new THREE.Quaternion();

    for (const yaw of [0, Math.PI / 6, Math.PI / 2, (3 * Math.PI) / 4, -Math.PI / 3]) {
      const sceneTangent = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      setUavAttitudeQuaternion(attitude, yaw, 0, 0);
      setUavYawQuaternion(legacy, sceneTangent);

      // Same orientation as the velocity-derived heading...
      expect(attitude.angleTo(legacy)).toBeCloseTo(0, 6);
      // ...and the model's forward (+Z) points along the travel direction.
      const forward = LOCAL_FORWARD.clone().applyQuaternion(attitude);
      expect(forward.x).toBeCloseTo(sceneTangent.x, 6);
      expect(forward.y).toBeCloseTo(0, 6);
      expect(forward.z).toBeCloseTo(sceneTangent.z, 6);
    }
  });

  it("tilts the nose up for positive pitch", () => {
    const attitude = new THREE.Quaternion();
    setUavAttitudeQuaternion(attitude, 0, 0.3, 0);
    const forward = LOCAL_FORWARD.clone().applyQuaternion(attitude);
    expect(forward.y).toBeGreaterThan(0);
  });

  it("drops the right wing for positive roll", () => {
    const attitude = new THREE.Quaternion();
    setUavAttitudeQuaternion(attitude, 0, 0, 0.3);
    const right = LOCAL_RIGHT.clone().applyQuaternion(attitude);
    expect(right.y).toBeLessThan(0);
  });

  it("leaves the UAV level (identity) when all angles are zero", () => {
    const attitude = new THREE.Quaternion();
    setUavAttitudeQuaternion(attitude, 0, 0, 0);
    expect(attitude.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
  });
});
