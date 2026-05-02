import * as THREE from "three";
import {
  HEMISPHERE_GROUND_COLOR,
  HEMISPHERE_LIGHT_INTENSITY,
  HEMISPHERE_SKY_COLOR,
  SKY_DOME_COLOR,
  SKY_DOME_RADIUS_METERS,
  SUN_COLOR,
  SUN_INTENSITY,
  SUN_POSITION,
  SUN_SHADOW_BOUNDS_METERS,
  SUN_SHADOW_MAP_SIZE,
} from "../constant";

export function createLightingGroup(): THREE.Group {
  const group = new THREE.Group();
  const hemisphere = new THREE.HemisphereLight(HEMISPHERE_SKY_COLOR, HEMISPHERE_GROUND_COLOR, HEMISPHERE_LIGHT_INTENSITY);
  group.add(hemisphere);

  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.position.copy(SUN_POSITION);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE);
  sun.shadow.camera.left = -SUN_SHADOW_BOUNDS_METERS;
  sun.shadow.camera.right = SUN_SHADOW_BOUNDS_METERS;
  sun.shadow.camera.top = SUN_SHADOW_BOUNDS_METERS;
  sun.shadow.camera.bottom = -SUN_SHADOW_BOUNDS_METERS;
  group.add(sun);

  return group;
}

export function createSkyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_DOME_RADIUS_METERS, 32, 16);
  const material = new THREE.MeshBasicMaterial({
    color: SKY_DOME_COLOR,
    side: THREE.BackSide,
    fog: false,
  });
  return new THREE.Mesh(geometry, material);
}
