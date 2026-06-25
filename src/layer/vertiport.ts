import * as THREE from "three";
import type { VertiportPoint } from "../types";
import { VERTIPORT_RENDER_ORDER } from "../constant";
import { createVertiportGeometry, createVertiportTexture } from "../geometry/vertiport";

/**
 * Builds one ground marker per vertiport. All markers share a single flat disc geometry and one
 * marking material (the texture is the same for every vertiport), so the layer stays cheap; only the
 * per-marker position and runtime spin differ. Each mesh lies flat on the ground and is later rotated
 * about the world up axis by {@link updateVertiportBillboards} so its "V" stays readable.
 */
export function createVertiportGroup(vertiports: VertiportPoint[]): THREE.Group {
  const group = new THREE.Group();
  if (vertiports.length === 0) {
    return group;
  }

  const geometry = createVertiportGeometry();
  const material = new THREE.MeshBasicMaterial({
    map: createVertiportTexture(),
    // The disc is fully opaque (the circle geometry only samples the marking, never the transparent
    // texture corners), so it renders in the opaque pass — before the airspace layer that must occlude it.
    //
    // We keep the depth test ENABLED but force it to always pass (depthFunc = Always) rather than setting
    // depthTest:false. Disabling the depth test also disables depth WRITES (a fragment can only update the
    // depth buffer as part of a passing test), so with depthTest:false the marker would never store its
    // own depth — roads would then test against the ground depth behind it and draw on top. With Always +
    // depthWrite the marker still ignores buildings yet writes its depth, biased toward the camera past the
    // roads' -2 via polygonOffset, so ground decals stay below it while the airspace layer (drawn later at
    // AIRSPACE_RENDER_ORDER) still depth-tests against it and draws in front.
    side: THREE.DoubleSide,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetUnits: -3,
  });

  vertiports.forEach((vertiport) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(vertiport.position.x, vertiport.position.y, vertiport.position.z);
    mesh.renderOrder = VERTIPORT_RENDER_ORDER;
    group.add(mesh);
  });

  return group;
}

/**
 * Orients every marker identically so the letters stay parallel to each other instead of fanning out
 * toward the camera. The camera's look direction is projected onto the ground plane, and each letter is
 * laid out so it points (its vertex, the "down" of the glyph) along the negative of that projected
 * vector — which puts the letter's top into the view, keeping the "V" upright and readable. The
 * orientation is therefore the same for all markers and is computed once per frame. The discs stay flat;
 * only `rotation.y` changes.
 *
 * Geometry mapping: at `rotation.y = 0` the letter's vertex faces world +Z (its top faces -Z, see the
 * geometry's UV note), and a Y-rotation of `a` sends that vertex direction to `(sin a, 0, cos a)`.
 * Setting it to the negated ground-projected forward `(-fx, 0, -fz)` gives `a = atan2(-fx, -fz)`.
 */
export function updateVertiportBillboards(group: THREE.Group, camera: THREE.Camera): void {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const rotationY = Math.atan2(-forward.x, -forward.z);
  for (const marker of group.children) {
    marker.rotation.y = rotationY;
  }
}
