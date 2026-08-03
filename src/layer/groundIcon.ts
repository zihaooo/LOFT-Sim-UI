import * as THREE from "three";
import type { ScenePoint } from "../types";
import { GROUND_ICON_RENDER_ORDER, GROUND_ICON_Y_OFFSET_METERS } from "../constant";
import { createGroundIconGeometry } from "../geometry/groundIcon";

/**
 * Builds one flat marker per position, all sharing a single disc geometry and one material, so a layer
 * stays cheap however many markers it holds; only the per-marker position and runtime spin differ. Callers
 * that want their icons to stay readable pass the returned group to {@link updateGroundIconBillboards}
 * each frame; icons that should stay locked to the world simply never do.
 */
export function createGroundIconGroup(
  texture: THREE.Texture,
  positions: readonly ScenePoint[],
  sizeMeters: number,
): THREE.Group {
  const group = new THREE.Group();
  if (positions.length === 0) {
    return group;
  }

  const geometry = createGroundIconGeometry(sizeMeters);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    // Opaque material: the disc samples only the painted badge, never the texture's transparent corners, so
    // the marker renders in the opaque pass — ahead of the airspace layer that must occlude it — and its rim
    // is a polygon edge that MSAA antialiases. Keeping the material free of any alpha cut-out matters:
    // alpha-to-coverage would turn the sampled alpha into a per-sample coverage mask, and mipmapped alpha
    // falls below 1 as the marker shrinks, which lets the ground and road dither through the icon.
    //
    // depthFunc = Always + depthWrite (not depthTest:false): Always draws the icon over ground and
    // buildings whatever is in front of it, while still writing depth. depthTest:false would also suppress
    // those writes (depth is stored only on a passing test), leaving nothing for the airspace layer (later
    // renderOrder) to test against — so a drone or corridor in front could not occlude the icon.
    //
    // polygonOffset: the icon and the road are coplanar (both y=0) and in different passes (opaque vs the
    // road's transparent), so renderOrder can't order them — only this depth bias keeps the road off the
    // icon. The bias unit is implementation-defined, so a sub-2-unit gap is unreliable: it can hold on
    // native GL (Linux) yet collapse on ANGLE/Metal (macOS Chrome) and leak the road through. The road
    // clears the ground by 2 units (0 vs -2) reliably on both, so the icon takes the same margin over the
    // road (-4 vs -2) — microscopic in NDC, nowhere near enough to stop an airborne drone (far nearer)
    // from occluding it.
    side: THREE.DoubleSide,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetUnits: -4,
  });

  positions.forEach((position) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position.x, position.y + GROUND_ICON_Y_OFFSET_METERS, position.z);
    mesh.renderOrder = GROUND_ICON_RENDER_ORDER;
    group.add(mesh);
  });

  return group;
}

/**
 * Orients every marker in a group identically so the artwork stays parallel instead of fanning out toward
 * the camera. The camera's look direction is projected onto the ground plane, and each icon is laid out so
 * its bottom points along the negative of that projected vector — which puts the artwork's top into the
 * view, keeping it upright and readable. The orientation is therefore the same for all markers in the
 * group and is computed once per frame. The discs stay flat; only `rotation.y` changes.
 *
 * Geometry mapping: at `rotation.y = 0` the artwork's bottom faces world +Z (its top faces -Z, see the
 * geometry's UV note), and a Y-rotation of `a` sends that direction to `(sin a, 0, cos a)`. Setting it to
 * the negated ground-projected forward `(-fx, 0, -fz)` gives `a = atan2(-fx, -fz)`.
 */
export function updateGroundIconBillboards(group: THREE.Group, camera: THREE.Camera): void {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const rotationY = Math.atan2(-forward.x, -forward.z);
  for (const marker of group.children) {
    marker.rotation.y = rotationY;
  }
}
