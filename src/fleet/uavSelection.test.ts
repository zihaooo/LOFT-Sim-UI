import * as THREE from "three";
import { describe, it, expect } from "vitest";
import { createUavMesh } from "../layer/drone";
import { UavInstanceWriter } from "./uavInstanceWriter";
import { SELECTED_UAV_COLOR } from "../constant";

/**
 * Guards the UAV selection highlight. The original bug: the selection material patch guarded the per-instance
 * color override with `#ifdef USE_INSTANCING_COLOR`, but three.js only emits that macro into the vertex
 * prefix and surfaces instanceColor to the fragment via `USE_COLOR` — so the override compiled out and the
 * selected drone never turned red. These tests lock the data path and the macro the patch must use.
 */
describe("UAV selection highlight", () => {
  it("writes the selection color to the selected instance and black to the rest", () => {
    const mesh = createUavMesh(8, null, null); // cone fallback; instanceColor pre-allocated
    const writer = new UavInstanceWriter(new Map([[1, mesh]]), 1);
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
    // The original bug guarded on USE_INSTANCING_COLOR, which the fragment never receives.
    expect(shader.fragmentShader).not.toContain("USE_INSTANCING_COLOR");
  });
});
