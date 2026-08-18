import * as THREE from "three";
import type { ContingencySite } from "../types";
import { CONT_SITE_ICON_SIZE_METERS } from "../constant";
import { createGroundIconGroup } from "./groundIcon";

/**
 * Places the contingency landing site marking on the map. Everything about how a ground icon renders — the
 * flat disc, the opaque material, the depth strategy that lifts it over buildings — lives in the shared
 * ground-icon layer; this holds only what is specific to contingency sites: their footprint and where they
 * sit.
 *
 * The texture is preloaded once (see loadGroundIconTextures) and passed in, so scene rebuilds reuse it.
 * A null texture yields an empty group rather than an untextured placeholder; the loader treats a missing
 * asset as fatal, so this only covers a scene constructed without the preload.
 *
 * Markers are spun upright each frame by updateGroundIconBillboards, called from the render loop.
 */
export function createContingencySiteGroup(
  sites: ContingencySite[],
  texture: THREE.Texture | null,
): THREE.Group {
  if (!texture) {
    return new THREE.Group();
  }

  return createGroundIconGroup(
    texture,
    sites.map((site) => site.position),
    CONT_SITE_ICON_SIZE_METERS,
  );
}
