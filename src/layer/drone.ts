import * as THREE from "three";
import { UAV_COLOR, UAV_METALNESS, UAV_ROUGHNESS } from "../constant";
import { createFallbackUavGeometry } from "../geometry/drone";

/** Builds the InstancedMesh that renders all UAVs, sized to the fleet and using the loaded model or fallback. */
export function createUavMesh(fleetSize: number, customGeometry: THREE.BufferGeometry | null): THREE.InstancedMesh {
  const geometry = customGeometry ?? createFallbackUavGeometry();
  const material = new THREE.MeshStandardMaterial({
    color: UAV_COLOR,
    roughness: UAV_ROUGHNESS,
    metalness: UAV_METALNESS,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(fleetSize, 1));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  return mesh;
}
