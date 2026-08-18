import * as THREE from "three";
import { Brush, Evaluator, INTERSECTION } from "three-bvh-csg";
import type { CnsSite, SceneBounds } from "../types";
import {
  CNS_DOME_HEIGHT_SEGMENTS,
  CNS_DOME_RENDER_ORDER,
  CNS_DOME_WIDTH_SEGMENTS,
  CNS_SITE_COLORS,
  CNS_SITE_ICON_SIZE_METERS,
  CNS_SITE_TYPES,
  COVERAGE_RING_SEGMENTS,
  COVERAGE_RING_Y_OFFSET_METERS,
  COVERAGE_SHELL_OPACITY,
  GROUND_ICON_RENDER_ORDER,
  INTENSITY_DOME_PEAK_ALPHA,
  type CnsSiteType,
} from "../constant";
import type { GroundIconKey, GroundIconTextures } from "../geometry/groundIcon";
import { createGroundIconGroup } from "./groundIcon";

/** Site category -> its badge artwork key in GROUND_ICON_ASSETS. */
const ICON_KEY_BY_SITE_TYPE: Record<CnsSiteType, GroundIconKey> = {
  navigation_site: "navSite",
  communication_site: "commSite",
  surveillance_site: "survSite",
};

/**
 * Vertical padding of the coverage shell's CSG box: the floor sinks below the renderer's global
 * y ≥ −0.1 ground clip (so the boolean's floor cap never survives to z-fight the map) and the top
 * clears the sphere apex (a box face tangent to the apex would make the boolean chew on degenerate
 * slivers).
 */
const SHELL_BOX_MARGIN_METERS = 5;

export type CnsSiteLayer = {
  /** The whole layer — markers, rings, and both dome groups; the Off mode hides this one node. */
  root: THREE.Group;
  /** Flat marker groups (one per site category present) that need the per-frame billboard update. */
  iconGroups: THREE.Group[];
  /** The signal-intensity fog domes; visible only in Intensity mode. */
  intensityGroup: THREE.Group;
  /** The effective-range shells; visible only in Coverage mode. */
  coverageGroup: THREE.Group;
};

const INTENSITY_DOME_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;
  varying vec3 vCenter;
  varying float vRadius;

  void main() {
    // The mesh is a unit sphere scaled by the coverage radius, so the model matrix carries the
    // sphere parameters — translation = center, basis length = radius — letting one material serve
    // every site of a category without per-site uniforms.
    vCenter = modelMatrix[3].xyz;
    vRadius = length(modelMatrix[0].xyz);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const INTENSITY_DOME_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 color;
  uniform float peakAlpha;
  uniform vec2 rectMin; // padded ground rectangle in world (x, z)
  uniform vec2 rectMax;
  varying vec3 vWorldPosition;
  varying vec3 vCenter;
  varying float vRadius;

  // Antiderivative, in signed arc length s from the ray's closest approach to the site (impact
  // parameter b, so r(s)^2 = b^2 + s^2), of the dB-linear signal density ln(R / r):
  //   F(s) = s * (ln(R / r) + 1) - b * atan(s / b),   dF/ds = ln(R / r)
  float densityIntegral(float s, float b) {
    float r = sqrt(b * b + s * s);
    return s * (log(vRadius / r) + 1.0) - b * atan(s / b);
  }

  // Intersects the ray interval [range.x, range.y] with one axis-aligned slab of the coverage
  // volume. A near-zero direction component would blow up 1/d, so such a ray is treated as
  // slab-parallel: kept or emptied by its origin alone. An emptied interval (y < x) stays empty.
  vec2 clampToSlab(vec2 range, float origin, float direction, float minEdge, float maxEdge) {
    if (abs(direction) < 1e-6) {
      return (origin < minEdge || origin > maxEdge) ? vec2(1.0, 0.0) : range;
    }
    float t1 = (minEdge - origin) / direction;
    float t2 = (maxEdge - origin) / direction;
    return vec2(max(range.x, min(t1, t2)), min(range.y, max(t1, t2)));
  }

  void main() {
    // The proxy sphere's back faces rasterize one candidate fragment per pixel — BackSide still
    // works with the camera inside the volume, where it usually is. The fragment only supplies the
    // ray; entry and exit come from the ray/sphere quadratic, exact regardless of tessellation, with
    // entry clamped to the camera when it sits inside.
    vec3 rayDirection = normalize(vWorldPosition - cameraPosition);
    vec3 centerToCamera = cameraPosition - vCenter;
    float halfB = dot(centerToCamera, rayDirection);
    float discriminant = halfB * halfB - dot(centerToCamera, centerToCamera) + vRadius * vRadius;
    float halfChord = sqrt(max(discriminant, 0.0));

    // The coverage volume is ball ∩ above-ground ∩ map rectangle, all expressed as clamps on the
    // ray's integration segment. The cut is never made on the fragment: a fragment's alpha carries a
    // whole ray column, so discarding by the proxy surface's position would zero columns that still
    // cross the volume and keep full columns that mostly lie outside it.
    vec2 segment = vec2(max(-halfB - halfChord, 0.0), -halfB + halfChord);
    segment = clampToSlab(segment, cameraPosition.y, rayDirection.y, 0.0, 1e9);
    segment = clampToSlab(segment, cameraPosition.x, rayDirection.x, rectMin.x, rectMax.x);
    segment = clampToSlab(segment, cameraPosition.z, rayDirection.z, rectMin.y, rectMax.y);

    // Alpha is the dB-linear signal density ln(R / r) — the remaining link margin of a log-distance
    // path-loss model, zero at the coverage radius — integrated in closed form over the segment.
    // Normalizing by the largest possible integral (2R, from a ground-grazing ray through the site)
    // cancels the density's arbitrary dB reference distance and pins peakAlpha to the densest ray.
    // The impact-parameter clamp only avoids atan(+-inf); the ln singularity at the site itself is
    // integrable, so near-center rays stay finite. The clamp's error is sub-meter at km-scale radii.
    float closestApproach = -halfB;
    float impact = max(sqrt(max(dot(centerToCamera, centerToCamera) - halfB * halfB, 0.0)), 1e-4 * vRadius);
    float integral = segment.y > segment.x
      ? densityIntegral(segment.y - closestApproach, impact) - densityIntegral(segment.x - closestApproach, impact)
      : 0.0;
    gl_FragColor = vec4(color, peakAlpha * clamp(integral / (2.0 * vRadius), 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Builds the CNS site layer: one ground marker per site (the shared ground-icon treatment, grouped per
 * category so each keeps its own badge texture) plus, for every site with a coverage radius, a ground
 * ring marking the exact extent and two exclusive dome treatments of the same volume — the intensity
 * fog (how strong is the signal here?) and the coverage shell (where does effective range end?). Each
 * treatment lives in its own subgroup so the CNS Sites mode switches by flipping visibility flags,
 * while markers and rings hang off the root and accompany both modes. Dome, shell, and ring take the
 * category's color so a site's elements read as one object.
 *
 * A null texture map yields an empty layer rather than partial markers; the loader treats a missing
 * asset as fatal, so this only covers a scene constructed without the preload.
 */
export function createCnsSiteLayer(
  sites: CnsSite[],
  textures: GroundIconTextures | null,
  groundBounds: SceneBounds,
): CnsSiteLayer {
  const root = new THREE.Group();
  const iconGroups: THREE.Group[] = [];
  const intensityGroup = new THREE.Group();
  const coverageGroup = new THREE.Group();
  root.add(intensityGroup, coverageGroup);
  if (sites.length === 0 || !textures) {
    return { root, iconGroups, intensityGroup, coverageGroup };
  }

  // Unit-radius geometries shared by every site. The intensity dome scales the shared sphere per
  // mesh and uses it as a rasterization proxy (its shader defines the coverage volume analytically,
  // so tessellation affects nothing but the silhouette's smoothness); the coverage shell clones it
  // as the source solid for its per-site CSG cut.
  const domeGeometry = new THREE.SphereGeometry(1, CNS_DOME_WIDTH_SEGMENTS, CNS_DOME_HEIGHT_SEGMENTS);
  const ringGeometry = createUnitRingGeometry();
  // Coverage from edge sites extends past the loaded map, and each element cuts at the map rectangle
  // its own way: the ring by per-material clipping planes (needs renderer.localClippingEnabled), the
  // intensity dome by clamping each ray's integration segment in its shader, and the coverage shell
  // by baking the cut into its geometry as real walls (see createCoverageShellGeometry).
  const ringClippingPlanes = createGroundRectangleClippingPlanes(groundBounds);
  // One evaluator serves every shell cut. useGroups off merges sphere and box faces into a
  // single-material geometry; only positions survive, since the unlit shell has no use for normals.
  const evaluator = new Evaluator();
  evaluator.useGroups = false;
  evaluator.attributes = ["position"];

  for (const type of CNS_SITE_TYPES) {
    const sitesOfType = sites.filter((site) => site.type === type);
    const texture = textures.get(ICON_KEY_BY_SITE_TYPE[type]) ?? null;
    if (sitesOfType.length === 0 || !texture) {
      continue;
    }

    const iconGroup = createGroundIconGroup(
      texture,
      sitesOfType.map((site) => site.position),
      CNS_SITE_ICON_SIZE_METERS,
    );
    iconGroups.push(iconGroup);
    root.add(iconGroup);

    const coveredSites = sitesOfType.filter((site) => site.coverageRadius > 0);
    if (coveredSites.length === 0) {
      continue;
    }
    const domeMaterial = createIntensityDomeMaterial(CNS_SITE_COLORS[type], groundBounds);
    const shellMaterial = createCoverageShellMaterial(CNS_SITE_COLORS[type]);
    const ringMaterial = new THREE.LineBasicMaterial({
      color: CNS_SITE_COLORS[type],
      // The ring's whole job is marking the exact coverage extent, so it must stay readable: fog
      // would wash it out at km distances, and an ordinary depth test would let every building and
      // tree standing on the circle chop it into dashes. Like the ground icons, it draws over map
      // geometry while still writing depth, so the airspace layer (later render order) occludes it.
      fog: false,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
      clippingPlanes: ringClippingPlanes,
    });
    for (const site of coveredSites) {
      const dome = new THREE.Mesh(domeGeometry, domeMaterial);
      dome.position.set(site.position.x, site.position.y, site.position.z);
      dome.scale.setScalar(site.coverageRadius);
      // The fog is composited after every other transparent object (rotor discs, envelopes, blob
      // shadows), so they sit inside the veil like the opaque scene instead of painting over it.
      dome.renderOrder = CNS_DOME_RENDER_ORDER;
      intensityGroup.add(dome);
      // World position is baked into the shell's CSG geometry, so the mesh stays at the origin.
      const shell = new THREE.Mesh(createCoverageShellGeometry(site, domeGeometry, groundBounds, evaluator), shellMaterial);
      // Shares the fog's last-composited transparent slot; at this opacity the blend-order error
      // against other translucent objects is imperceptible from either side of the shell wall.
      shell.renderOrder = CNS_DOME_RENDER_ORDER;
      coverageGroup.add(shell);
      const ring = new THREE.LineLoop(ringGeometry, ringMaterial);
      ring.position.set(site.position.x, site.position.y + COVERAGE_RING_Y_OFFSET_METERS, site.position.z);
      ring.scale.setScalar(site.coverageRadius);
      ring.renderOrder = GROUND_ICON_RENDER_ORDER;
      root.add(ring);
    }
  }

  return { root, iconGroups, intensityGroup, coverageGroup };
}

/**
 * The intensity dome material: a translucent volume whose alpha is the signal a view ray accumulates —
 * a dB-linear density (the remaining log-distance link margin, proportional to ln(radius / distance to
 * the site), zero at the coverage radius) integrated in closed form over the ray's segment through the
 * volume: ball ∩ above-ground ∩ the padded ground rectangle, so no coverage is counted below ground or
 * past the map edge. The mesh contributes only pixel coverage — one back-face fragment per pixel, which
 * works identically with the camera outside or deep inside the dome (where it usually is, since
 * coverage radii are scene-sized). Raw ShaderMaterial keeps the dome out of fog, lighting, and the
 * shadow pass, all of which would only wash out or darken a volume this large.
 *
 * Known limit of this single-surface approach: without a depth test (see the material flags) the veil
 * over an object is the ray's full column through the volume rather than just the camera-to-object
 * portion, and an object standing in front of a dome is veiled as if it were inside. Both errors are
 * subtle at these alphas — the domes engulf the scene, so the camera and everything else sit inside
 * them almost always — and the exact fix (a depth-aware volumetric pass) costs far more than they
 * warrant.
 */
function createIntensityDomeMaterial(color: string, groundBounds: SceneBounds): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) },
      peakAlpha: { value: INTENSITY_DOME_PEAK_ALPHA },
      rectMin: { value: new THREE.Vector2(groundBounds.min.x, groundBounds.min.z) },
      rectMax: { value: new THREE.Vector2(groundBounds.max.x, groundBounds.max.z) },
    },
    vertexShader: INTENSITY_DOME_VERTEX_SHADER,
    fragmentShader: INTENSITY_DOME_FRAGMENT_SHADER,
    transparent: true,
    // The dome is a see-through volume, so it neither writes depth nor tests it. Writing would
    // occlude the scene inside it; testing would discard the fog on every pixel covered by an object
    // inside the volume (the proxy's back face lies behind such objects), punching untinted cutouts
    // around buildings and drones. With both off, everything inside the footprint gets the ray's veil.
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
  });
}

/**
 * The coverage shell material: a plain translucent surface over the effective-range solid — the
 * yes/no companion to the intensity dome's how-strong read. The map-edge cut is baked into the
 * geometry as real wall faces (see createCoverageShellGeometry), so no clipping planes apply here;
 * only the renderer's global below-ground plane trims the strip the CSG box leaves under the ground.
 * DoubleSide because the camera usually sits inside (coverage radii are scene-sized), where only
 * interior faces show. Unlike the fog, the shell is a surface, so the ordinary depth test is
 * correct — opaque geometry in front of the shell wall occludes it — and only depth writing is off,
 * as for any translucent surface. Like the ring, it stays out of scene fog: a fog-faded wall would
 * read as weaker coverage, not distance.
 */
function createCoverageShellMaterial(color: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: COVERAGE_SHELL_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
}

/**
 * The coverage shell geometry: the site's range sphere intersected with a box over the padded ground
 * rectangle, so where coverage crosses the map edge the shell closes with a flat vertical wall
 * instead of an open rim exposing the interior. The box floor sits below the global ground clip
 * (see SHELL_BOX_MARGIN_METERS), which trims the walls flush with the ground at render time and
 * leaves no floor cap to z-fight the map. World position and radius are baked into the geometry —
 * the evaluator expects world-space brushes — so the caller's mesh stays at the origin. Falls back
 * to the uncut sphere (overhanging the map edge) if the boolean throws on degenerate input, so a bad
 * site never blanks the layer.
 */
function createCoverageShellGeometry(
  site: CnsSite,
  unitSphere: THREE.SphereGeometry,
  groundBounds: SceneBounds,
  evaluator: Evaluator,
): THREE.BufferGeometry {
  const sphere = unitSphere.clone();
  sphere.scale(site.coverageRadius, site.coverageRadius, site.coverageRadius);
  sphere.translate(site.position.x, site.position.y, site.position.z);

  const boxTop = site.position.y + site.coverageRadius + SHELL_BOX_MARGIN_METERS;
  const boxBottom = -SHELL_BOX_MARGIN_METERS;
  const box = new THREE.BoxGeometry(
    groundBounds.max.x - groundBounds.min.x,
    boxTop - boxBottom,
    groundBounds.max.z - groundBounds.min.z,
  );
  box.translate(
    (groundBounds.min.x + groundBounds.max.x) / 2,
    (boxTop + boxBottom) / 2,
    (groundBounds.min.z + groundBounds.max.z) / 2,
  );

  try {
    const sphereBrush = new Brush(sphere);
    sphereBrush.updateMatrixWorld();
    const boxBrush = new Brush(box);
    boxBrush.updateMatrixWorld();
    const geometry = evaluator.evaluate(sphereBrush, boxBrush, INTERSECTION).geometry;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  } catch (error) {
    console.warn("Coverage shell CSG failed; falling back to the uncut sphere for this site.", error);
    return sphere;
  }
}

/** Four vertical planes keeping fragments inside the padded ground rectangle (n·p + c ≥ 0 is kept). */
function createGroundRectangleClippingPlanes(bounds: SceneBounds): THREE.Plane[] {
  return [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -bounds.min.x),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), bounds.max.x),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -bounds.min.z),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), bounds.max.z),
  ];
}

/** A unit-radius circle of line segments on the ground plane (XZ), closed by the LineLoop that draws it. */
function createUnitRingGeometry(): THREE.BufferGeometry {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index < COVERAGE_RING_SEGMENTS; index += 1) {
    const angle = (index / COVERAGE_RING_SEGMENTS) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}
