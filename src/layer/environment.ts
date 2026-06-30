import * as THREE from "three";
import type { SceneBounds } from "../types";
import {
  HEMISPHERE_GROUND_COLOR,
  HEMISPHERE_LIGHT_INTENSITY,
  HEMISPHERE_SKY_COLOR,
  SHADOW_FIT_MARGIN,
  SHADOW_SCENE_HEIGHT_METERS,
  SKY_DOME_COLOR,
  SKY_DOME_RADIUS_METERS,
  SUN_COLOR,
  SUN_INTENSITY,
  SUN_OFFSET,
  SUN_SHADOW_MAP_SIZE,
} from "../constant";

/**
 * Combines hemisphere ambient light and a shadow-casting directional sun into one group, with the
 * sun re-centered on `sceneBounds` and its shadow frustum tightly fitted so shadows track the loaded preset.
 */
export function createLightingGroup(sceneBounds: SceneBounds): THREE.Group {
  const group = new THREE.Group();
  const hemisphere = new THREE.HemisphereLight(HEMISPHERE_SKY_COLOR, HEMISPHERE_GROUND_COLOR, HEMISPHERE_LIGHT_INTENSITY);
  group.add(hemisphere);

  const center = new THREE.Vector3(
    (sceneBounds.min.x + sceneBounds.max.x) / 2,
    0,
    (sceneBounds.min.z + sceneBounds.max.z) / 2,
  );

  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.position.copy(center).add(SUN_OFFSET); // keep the sun's direction + distance, re-centered on the scene
  sun.target.position.copy(center);
  group.add(sun.target); // the target must be in the scene graph for its world matrix (and the sun's aim) to update
  sun.castShadow = true;
  sun.shadow.mapSize.set(SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE);
  fitShadowCameraToBounds(sun, sceneBounds, center);
  group.add(sun);

  return group;
}

/**
 * Tightly fits the directional light's orthographic shadow frustum to the scene's bounding box
 * (footprint × building height) by projecting its eight corners into light-view space and taking the
 * min/max extent. This keeps every shadow-map texel covering as little ground as possible (sharpest
 * shadows per texel) while guaranteeing the whole scene stays inside the frustum.
 */
function fitShadowCameraToBounds(sun: THREE.DirectionalLight, bounds: SceneBounds, center: THREE.Vector3): void {
  const camera = sun.shadow.camera;
  // Aim the shadow camera exactly as the renderer will at draw time, so the fitted extents match the real frustum.
  camera.position.copy(sun.position);
  camera.lookAt(center);
  camera.updateMatrixWorld();

  // Collect the scene box's eight corners in light-view space.
  const lightSpaceBounds = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [0, SHADOW_SCENE_HEIGHT_METERS]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        lightSpaceBounds.expandByPoint(corner.set(x, y, z).applyMatrix4(camera.matrixWorldInverse));
      }
    }
  }

  // The camera looks down -Z, so a corner's distance in front of it is -z (near = nearest, far = farthest).
  const padX = (lightSpaceBounds.max.x - lightSpaceBounds.min.x) * SHADOW_FIT_MARGIN;
  const padY = (lightSpaceBounds.max.y - lightSpaceBounds.min.y) * SHADOW_FIT_MARGIN;
  const padZ = (lightSpaceBounds.max.z - lightSpaceBounds.min.z) * SHADOW_FIT_MARGIN;
  camera.left = lightSpaceBounds.min.x - padX;
  camera.right = lightSpaceBounds.max.x + padX;
  camera.bottom = lightSpaceBounds.min.y - padY;
  camera.top = lightSpaceBounds.max.y + padY;
  camera.near = -lightSpaceBounds.max.z - padZ;
  camera.far = -lightSpaceBounds.min.z + padZ;
  camera.updateProjectionMatrix();
}

/** Returns a large inward-facing sphere that paints the sky color behind the scene. */
export function createSkyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_DOME_RADIUS_METERS, 32, 16);
  const material = new THREE.MeshBasicMaterial({
    color: SKY_DOME_COLOR,
    side: THREE.BackSide,
    fog: false,
  });
  return new THREE.Mesh(geometry, material);
}
