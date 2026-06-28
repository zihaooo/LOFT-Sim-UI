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
    // Opaque material: the geometry samples only the painted disc, never the texture's transparent corners,
    // so the marker renders in the opaque pass — ahead of the airspace layer that must occlude it.
    //
    // depthFunc = Always + depthWrite (not depthTest:false): Always draws the disc over ground and buildings
    // whatever is in front of it, while still writing depth. depthTest:false would also suppress those
    // writes (depth is stored only on a passing test), leaving nothing for the airspace layer (later
    // renderOrder) to test against — so a drone or corridor in front could no longer occlude the marker.
    //
    // polygonOffset: the disc and the road are coplanar (both y=0) and in different passes (opaque vs the
    // road's transparent), so renderOrder can't order them — only this depth bias keeps the road off the
    // disc. The bias unit is implementation-defined, so a sub-2-unit gap is unreliable: it can hold on
    // native GL (Linux) yet collapse on ANGLE/Metal (macOS Chrome) and leak the road through. The road
    // clears the ground by 2 units (0 vs -2) reliably on both, so the disc takes the same margin over the
    // road (-4 vs -2) — microscopic in NDC, nowhere near enough to stop an airborne drone (far nearer)
    // from occluding it.
    side: THREE.DoubleSide,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetUnits: -4,
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
