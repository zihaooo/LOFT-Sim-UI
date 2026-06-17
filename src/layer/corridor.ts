import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AirCorridor } from "../types";
import {
  ENVELOPE_OPACITY,
  ENVELOPE_RADIAL_SEGMENTS,
  ENVELOPE_ROUGHNESS,
  CORRIDOR_DIRECTION_CONE_HEIGHT_METERS,
  CORRIDOR_DIRECTION_CONE_RADIAL_SEGMENTS,
  CORRIDOR_DIRECTION_CONE_RADIUS_METERS,
  CORRIDOR_DIRECTION_CONE_STEP,
  CORRIDOR_LINE_RADIUS_METERS,
  CORRIDOR_TUBE_RADIAL_SEGMENTS,
} from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { createPolylineTubeGeometry } from "../geometry/corridor";

// Layout tradeoff: every corridor's centerline geometry is baked into one merged mesh, and every
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

const CONE_AXIS = new THREE.Vector3(0, 1, 0);

/** Builds one merged centerline mesh for all corridors plus one InstancedMesh containing every direction cone. */
export function createCorridorGroup(corridors: AirCorridor[]): THREE.Group {
  const group = new THREE.Group();
  const centerlineGeometries: THREE.BufferGeometry[] = [];
  const conePositions: THREE.Vector3[] = [];
  const coneQuaternions: THREE.Quaternion[] = [];
  const coneColors: THREE.Color[] = [];

  corridors.forEach((corridor) => {
    const points = corridor.points.map(toVector3);
    if (points.length < 2) {
      return;
    }

    const tubeGeometry = createPolylineTubeGeometry(
      points,
      CORRIDOR_LINE_RADIUS_METERS,
      CORRIDOR_TUBE_RADIAL_SEGMENTS,
    );
    if (!tubeGeometry) {
      return;
    }
    const corridorColor = new THREE.Color(corridor.color);
    setUniformVertexColor(tubeGeometry, corridorColor);
    centerlineGeometries.push(tubeGeometry);

    for (let index = 2; index < points.length; index += CORRIDOR_DIRECTION_CONE_STEP) {
      const start = points[index - 1];
      const end = points[index];
      const direction = end.clone().sub(start).normalize();
      const offset = direction.clone().multiplyScalar(CORRIDOR_DIRECTION_CONE_HEIGHT_METERS / 2 + CORRIDOR_LINE_RADIUS_METERS);
      conePositions.push(end.clone().sub(offset));
      coneQuaternions.push(new THREE.Quaternion().setFromUnitVectors(CONE_AXIS, direction));
      coneColors.push(corridorColor);
    }
  });

  const centerlineMesh = buildMergedMesh(
    centerlineGeometries,
    () => new THREE.MeshBasicMaterial({ vertexColors: true }),
  );
  if (centerlineMesh) {
    group.add(centerlineMesh);
  }

  if (conePositions.length > 0) {
    group.add(buildConeInstancedMesh(conePositions, coneQuaternions, coneColors));
  }

  return group;
}

/** Builds one merged translucent tube mesh containing every corridor's flight envelope. */
export function createFlightEnvelopeGroup(corridors: AirCorridor[]): THREE.Group {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  corridors.forEach((corridor) => {
    const geometry = createPolylineTubeGeometry(
      corridor.points.map(toVector3),
      corridor.envelopeRadius,
      ENVELOPE_RADIAL_SEGMENTS,
    );
    if (!geometry) {
      return;
    }
    setUniformVertexColor(geometry, new THREE.Color(corridor.color));
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

/** Packs every corridor's direction cones into one InstancedMesh with per-instance transform and color. */
function buildConeInstancedMesh(
  positions: THREE.Vector3[],
  quaternions: THREE.Quaternion[],
  colors: THREE.Color[],
): THREE.InstancedMesh {
  const geometry = new THREE.ConeGeometry(
    CORRIDOR_DIRECTION_CONE_RADIUS_METERS,
    CORRIDOR_DIRECTION_CONE_HEIGHT_METERS,
    CORRIDOR_DIRECTION_CONE_RADIAL_SEGMENTS,
  );
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3(1, 1, 1);

  for (let index = 0; index < positions.length; index += 1) {
    matrix.compose(positions[index], quaternions[index], scale);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, colors[index]);
  }

  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
  return mesh;
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
