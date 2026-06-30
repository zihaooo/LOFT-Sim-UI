import * as THREE from "three";
import { UAV_COLOR, UAV_METALNESS, UAV_ROUGHNESS } from "../constant";
import { createFallbackUavGeometry } from "../geometry/drone";
import { buildShadowAlphaGLSL } from "./shadowProfiles";

const SHADOW_ALPHA_GLSL = buildShadowAlphaGLSL();

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
  // Drones don't cast into the shared shadow map (their small, thin geometry shimmers in it); their ground
  // shadow is the altitude-faded blob layer instead (createBlobShadowMesh). Buildings/trees still cast.
  mesh.castShadow = false;
  return mesh;
}

/**
 * Builds the shared InstancedMesh that draws drones' ground shadows as soft round decals — one instance
 * per visible drone, written by {@link UavInstanceWriter}. The flat unit quad is sized + placed per instance
 * via its matrix (position projected along the sun's rays, scale = blob radius), and its altitude fade rides
 * in `instanceColor.r` (see the alpha patch below). It receives/casts nothing — it is a fake shadow, not lit.
 */
export function createBlobShadowMesh(capacity: number): THREE.InstancedMesh {
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // lie flat in XZ, normal up (+Y)
  const material = patchMaterialForBlobShadow(new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Lift over the ground/road planes (also via the y-offset) so grazing-angle views don't z-fight.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }));

  const count = Math.max(capacity, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Per-instance opacity rides in instanceColor.r; pre-allocate (zero-filled) so the alpha patch — which is
  // guarded on USE_COLOR, force-defined by the presence of instanceColor — compiles in from the first frame.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  // Instances span the whole scene, so the mesh's own (unit-quad) bounds would wrongly cull it.
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  return mesh;
}

/**
 * Shapes the flat quad into a drone's shadow: `shadowAlpha` (generated from the per-type rect profiles)
 * unions the type's rectangles into a soft mask, selected by the per-instance type index in `instanceColor.g`
 * and faded by the per-instance opacity in `instanceColor.r`. The planar coordinate comes from the built-in
 * `position` attribute (always declared, scale-invariant) rather than three's `USE_UV` machinery.
 */
function patchMaterialForBlobShadow<T extends THREE.Material>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `varying vec2 vBlobPlane;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n\tvBlobPlane = position.xz;",
    );
    shader.fragmentShader = `varying vec2 vBlobPlane;\n${SHADOW_ALPHA_GLSL}\n${shader.fragmentShader}`.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
       #ifdef USE_COLOR
         diffuseColor.a *= shadowAlpha(vBlobPlane, vColor.g) * vColor.r; // per-type shape × altitude fade
       #else
         diffuseColor.a *= shadowAlpha(vBlobPlane, 0.0);
       #endif`,
    );
  };
  return material;
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
