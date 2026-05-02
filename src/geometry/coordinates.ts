import * as THREE from "three";
import type { ScenePoint } from "../types";
import { LABEL_SCREEN_Y_OFFSET_METERS } from "../constant";

/** Adapts a plain ScenePoint into a THREE.Vector3 for math/geometry use. */
export function toVector3(point: ScenePoint): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z);
}

/** Projects a world-space position to host-pixel coordinates, lifted so labels float above their anchor. */
export function toScreenPosition(position: THREE.Vector3, camera: THREE.Camera, host: HTMLElement): { x: number; y: number } {
  const projected = position.clone();
  projected.y += LABEL_SCREEN_Y_OFFSET_METERS;
  projected.project(camera);

  return {
    x: Math.round(((projected.x + 1) / 2) * host.clientWidth),
    y: Math.round(((-projected.y + 1) / 2) * host.clientHeight),
  };
}
