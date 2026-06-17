import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AirCorridor } from "../types";
import { ENVELOPE_OPACITY, ENVELOPE_ROUGHNESS } from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { buildComponentEnvelopeGeometries } from "../geometry/corridorEnvelope";
import { appendDirectionCones, buildConeInstancedMesh, buildCorridorLines } from "../geometry/corridorCenterline";

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

/** Builds one batched centerline LineSegments for all corridors plus one InstancedMesh containing every direction cone. */
export function createCorridorGroup(corridors: AirCorridor[]): THREE.Group {
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
    group.add(buildCorridorLines(linePositions, lineColors));
  }

  if (conePositions.length > 0) {
    group.add(buildConeInstancedMesh(conePositions, coneQuaternions, coneColors));
  }

  return group;
}

/**
 * Builds one merged translucent mesh containing every corridor's flight envelope. Connected corridors
 * (same `componentId`) are CSG-unioned into a single watertight blob per component so their fat tubes
 * read as one uniform-opacity solid through junctions, sharing the component color.
 */
export function createFlightEnvelopeGroup(corridors: AirCorridor[]): THREE.Group {
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
