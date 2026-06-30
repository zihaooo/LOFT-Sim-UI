import * as THREE from "three";
import { describe, it, expect } from "vitest";
import { createBlobShadowMesh, createUavMesh } from "../layer/drone";
import { UavInstanceWriter } from "./uavInstanceWriter";
import {
  BLOB_SHADOW_FADE_HEIGHT_METERS,
  SELECTED_UAV_COLOR,
  SHADOW_OFFSET_X_PER_M,
  SHADOW_OFFSET_Z_PER_M,
} from "../constant";

const flatGround = (): number => 0;

/**
 * Guards the UAV selection highlight. The selection material patch must guard its per-instance color
 * override with `USE_COLOR`, not `USE_INSTANCING_COLOR`: three.js emits the latter only into the vertex
 * prefix and surfaces instanceColor to the fragment via `USE_COLOR`, so guarding on `USE_INSTANCING_COLOR`
 * compiles the override out and leaves the selected drone unpainted. These tests lock the data path and
 * the macro the patch must use.
 */
describe("UAV selection highlight", () => {
  it("writes the selection color to the selected instance and black to the rest", () => {
    const mesh = createUavMesh(8, null, null); // cone fallback; instanceColor pre-allocated
    const writer = new UavInstanceWriter(new Map([[1, mesh]]), 1, createBlobShadowMesh(8), flatGround);
    const matrix = new THREE.Matrix4();

    writer.begin();
    writer.write(1, matrix, false); // slot 0 — not selected
    writer.write(1, matrix, true); // slot 1 — selected
    writer.write(1, matrix, false); // slot 2 — not selected
    writer.commit();

    expect(mesh.count).toBe(3);
    const colors = mesh.instanceColor;
    expect(colors).not.toBeNull();

    const selected = new THREE.Color().fromBufferAttribute(colors!, 1);
    expect(selected.getHexString()).toBe(new THREE.Color(SELECTED_UAV_COLOR).getHexString());

    expect(new THREE.Color().fromBufferAttribute(colors!, 0).getHexString()).toBe("000000");
    expect(new THREE.Color().fromBufferAttribute(colors!, 2).getHexString()).toBe("000000");
  });

  it("patches <color_fragment> to override under USE_COLOR (the macro three exposes to the fragment)", () => {
    const mesh = createUavMesh(1, null, null);
    const material = mesh.material as THREE.Material;
    expect(typeof material.onBeforeCompile).toBe("function");

    const shader = { fragmentShader: "void main() {\n\t#include <color_fragment>\n}" };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);

    expect(shader.fragmentShader).not.toContain("#include <color_fragment>");
    expect(shader.fragmentShader).toContain("diffuseColor.rgb = vColor");
    expect(shader.fragmentShader).toContain("#ifdef USE_COLOR");
    // The fragment never receives USE_INSTANCING_COLOR, so the patch must not guard on it.
    expect(shader.fragmentShader).not.toContain("USE_INSTANCING_COLOR");
  });
});

/**
 * Locks the blob-shadow writer: one blob per visible drone, positioned by projecting along the sun's rays
 * (not straight down), sized + faded by altitude, and culled once it has fully faded out at altitude.
 */
describe("blob shadow writer", () => {
  const droneAt = (x: number, y: number, z: number): THREE.Matrix4 =>
    new THREE.Matrix4().setPosition(x, y, z);

  it("projects the blob along the sun's rays, offset from directly below by altitude", () => {
    const uav = createUavMesh(4, null, null);
    const blob = createBlobShadowMesh(4);
    const writer = new UavInstanceWriter(new Map([[1, uav]]), 1, blob, flatGround);

    const droneX = 100;
    const droneZ = -50;
    const altitude = 30;
    writer.begin();
    writer.write(1, droneAt(droneX, altitude, droneZ), false);
    writer.commit();

    expect(blob.count).toBe(1);
    const placed = new THREE.Matrix4().fromArray(blob.instanceMatrix.array, 0);
    const pos = new THREE.Vector3().setFromMatrixPosition(placed);
    expect(pos.x).toBeCloseTo(droneX + altitude * SHADOW_OFFSET_X_PER_M, 4);
    expect(pos.z).toBeCloseTo(droneZ + altitude * SHADOW_OFFSET_Z_PER_M, 4);
    expect(pos.y).toBeCloseTo(0.03, 4); // on the flat ground, lifted by the y-offset
    // Displaced from straight-below — the whole point of the sun projection.
    expect(Math.hypot(pos.x - droneX, pos.z - droneZ)).toBeGreaterThan(1);

    // instanceColor carries data: .r = fade opacity (non-zero), .g = profile index (quadrotor type 1 → 0).
    const data = new THREE.Color().fromBufferAttribute(blob.instanceColor!, 0);
    expect(data.r).toBeGreaterThan(0);
    expect(data.g).toBe(0);
  });

  it("culls a blob once the drone has climbed past the fade height", () => {
    const uav = createUavMesh(4, null, null);
    const blob = createBlobShadowMesh(4);
    const writer = new UavInstanceWriter(new Map([[1, uav]]), 1, blob, flatGround);

    writer.begin();
    writer.write(1, droneAt(0, 0, 0), false); // on the ground → strongest shadow, kept
    writer.write(1, droneAt(0, BLOB_SHADOW_FADE_HEIGHT_METERS + 10, 0), false); // above fade → culled
    writer.commit();

    expect(uav.count).toBe(2); // both drones still rendered
    expect(blob.count).toBe(1); // only the low one gets a shadow
  });
});
