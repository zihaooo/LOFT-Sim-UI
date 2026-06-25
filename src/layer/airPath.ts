import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AirPath } from "../types";
import { ENVELOPE_OPACITY, ENVELOPE_ROUGHNESS } from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { buildComponentEnvelopeGeometries } from "../geometry/envelope";
import { appendDirectionCones, buildConeInstancedMesh, buildAirPathLines } from "../geometry/centerline";

// Layout tradeoff: every corridor's centerline is batched into one LineSegments, and every
// direction cone into one InstancedMesh, to keep the corridor layer at a constant ~3 draw calls
// regardless of corridor count. Two consequences callers should know about:
//
//   1. Per-corridor visibility filtering is not supported. Today only the whole `corridorGroup` /
//      `envelopeGroup` toggles, so this is fine. Showing a single corridor would require a
//      draw-range trick, an attribute-mask in a custom shader, or rebuilding the merged
//      buffer with a subset of corridors.
//
//   2. Per-corridor runtime updates require rebuilding the whole merged buffer. Corridors are static
//      today, so this never happens. If a corridor's polyline ever changes at runtime, you cannot
//      update only that corridor's slice — you must rebuild and re-upload the merged geometry
//      (and rebuild the cone InstancedMesh).
//
// If either capability becomes a requirement, prefer adding a per-vertex `corridorId` attribute
// (or a parallel cone-instance → corridorId table) over reverting the merge.

/** Builds one batched centerline LineSegments for all paths plus one InstancedMesh containing every direction cone. */
export function createCorridorGroup(corridors: AirPath[]): THREE.Group {
  const group = new THREE.Group();
  const linePositions: number[] = [];
  const lineColors: number[] = [];
  const conePositions: THREE.Vector3[] = [];
  const coneQuaternions: THREE.Quaternion[] = [];
  const coneColors: THREE.Color[] = [];

  corridors.forEach((corridor) => {
    const points = corridor.points.map(toVector3);
    if (points.length < 2) {
      return;
    }

    const corridorColor = new THREE.Color(corridor.color);
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      linePositions.push(start.x, start.y, start.z, end.x, end.y, end.z);
      lineColors.push(
        corridorColor.r, corridorColor.g, corridorColor.b,
        corridorColor.r, corridorColor.g, corridorColor.b,
      );
    }

    appendDirectionCones(points, corridorColor, conePositions, coneQuaternions, coneColors);
  });

  if (linePositions.length > 0) {
    group.add(buildAirPathLines(linePositions, lineColors));
  }

  if (conePositions.length > 0) {
    group.add(buildConeInstancedMesh(conePositions, coneQuaternions, coneColors));
  }

  return group;
}

/**
 * Builds one merged translucent mesh containing every corridor's flight envelope. Each connected
 * component (same `componentId`) is emitted as a single watertight, uniform-opacity solid in the
 * component color, so overlapping fat tubes never double-blend where they meet. The heavy lifting is in
 * buildComponentEnvelopeGeometries: degree-2 chains are welded with a bisector miter, and only true
 * junctions (degree > 2, non-vertiport) are fused with CSG — junction-free components use no CSG at all.
 */
export function createFlightEnvelopeGroup(corridors: AirPath[]): THREE.Group {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  buildComponentEnvelopeGeometries(corridors).forEach(({ geometry, color }) => {
    setUniformVertexColor(geometry, new THREE.Color(color));
    geometries.push(geometry);
  });

  const mesh = buildMergedMesh(geometries, () => new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    opacity: ENVELOPE_OPACITY,
    roughness: ENVELOPE_ROUGHNESS,
    metalness: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  if (mesh) {
    group.add(mesh);
  }
  return group;
}

/**
 * Builds one subgroup per route (named `route:<id>`), each holding that route's own centerline and
 * envelope. Routes are kept as separate objects rather than one merged batch so a single route can
 * later be shown/hidden (`subgroup.visible`) or recolored independently — at the cost of a few extra
 * draw calls, which is negligible for the handful of routes a scene carries.
 */
export function createRouteGroup(routes: AirPath[]): THREE.Group {
  const group = new THREE.Group();

  routes.forEach((route) => {
    const subgroup = new THREE.Group();
    subgroup.name = `route:${route.id}`;
    subgroup.add(createCorridorGroup([route]));
    subgroup.add(createFlightEnvelopeGroup([route]));
    group.add(subgroup);
  });

  return group;
}

/** Merges the source geometries into one mesh with the given material; disposes the sources. */
function buildMergedMesh(
  geometries: THREE.BufferGeometry[],
  createMaterial: () => THREE.Material,
): THREE.Mesh | null {
  if (geometries.length === 0) {
    return null;
  }
  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());
  if (!merged) {
    return null;
  }
  return new THREE.Mesh(merged, createMaterial());
}

/** Writes a flat per-vertex color attribute onto the geometry so it can survive a merge. */
function setUniformVertexColor(geometry: THREE.BufferGeometry, color: THREE.Color): void {
  const positionAttribute = geometry.getAttribute("position");
  if (!positionAttribute) {
    return;
  }
  const vertexCount = positionAttribute.count;
  const colors = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount; index += 1) {
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
}
