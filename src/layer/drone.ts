import * as THREE from "three";
import { UAV_COLOR, UAV_METALNESS, UAV_ROUGHNESS } from "../constant";
import { createFallbackUavGeometry } from "../geometry/drone";

/**
 * Builds the InstancedMesh that renders one UAV model. When a loaded model is supplied its own gltf
 * geometry + materials are used (so each drone shows its real colors); otherwise a plain cone fallback is
 * used. Every material is patched so the per-instance color OVERRIDES the base color (black = the model's
 * own look, any non-black = a solid selection highlight) instead of multiplying it, which would barely show
 * on the mostly-dark models.
 */
export function createUavMesh(
  capacity: number,
  geometry: THREE.BufferGeometry | null,
  materials: THREE.Material[] | null,
): THREE.InstancedMesh {
  const useModel = geometry !== null && materials !== null && materials.length > 0;
  const meshGeometry = geometry ?? createFallbackUavGeometry();
  const meshMaterial: THREE.Material | THREE.Material[] = useModel
    ? materials.map(patchMaterialForSelection)
    : patchMaterialForSelection(new THREE.MeshStandardMaterial({
        color: UAV_COLOR,
        roughness: UAV_ROUGHNESS,
        metalness: UAV_METALNESS,
      }));

  const count = Math.max(capacity, 1);
  const mesh = new THREE.InstancedMesh(meshGeometry, meshMaterial, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Pre-allocate the per-instance color buffer (zero-filled = black = "no highlight") so the selection
  // shader patch is compiled in from the first frame and no instance defaults to white.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  return mesh;
}

/**
 * Rewrites the material's color stage so the instance color replaces (rather than multiplies) the base
 * color when it is non-black. Black instances keep the model's own materials; the selected instance is set
 * to red and is painted solidly. Mutates and returns the material.
 *
 * The guard is `USE_COLOR`, not `USE_INSTANCING_COLOR`: three.js only emits `USE_INSTANCING_COLOR` into the
 * vertex prefix, and surfaces an InstancedMesh's instanceColor to the *fragment* shader by force-defining
 * `USE_COLOR` there (WebGLProgram prefixFragment). `vColor` is likewise declared under `USE_COLOR` in the
 * fragment, so guarding on `USE_INSTANCING_COLOR` would compile the override out entirely.
 */
function patchMaterialForSelection<T extends THREE.Material>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#ifdef USE_COLOR
         if (vColor.r + vColor.g + vColor.b > 0.0001) {
           diffuseColor.rgb = vColor;
         }
       #endif`,
    );
  };
  return material;
}
