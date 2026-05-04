import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AirRoute } from "../types";
import {
  ENVELOPE_OPACITY,
  ENVELOPE_RADIAL_SEGMENTS,
  ENVELOPE_ROUGHNESS,
  ROUTE_DIRECTION_CONE_HEIGHT_METERS,
  ROUTE_DIRECTION_CONE_RADIAL_SEGMENTS,
  ROUTE_DIRECTION_CONE_RADIUS_METERS,
  ROUTE_DIRECTION_CONE_STEP,
  ROUTE_LINE_RADIUS_METERS,
  ROUTE_MIN_TUBE_SEGMENTS,
  ROUTE_SEGMENTS_PER_POINT,
  ROUTE_TUBE_RADIAL_SEGMENTS,
} from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { createPolylineTubeGeometry } from "../geometry/route";

// Layout tradeoff: every route's centerline geometry is baked into one merged mesh, and every
// direction cone into one InstancedMesh, to keep the route layer at a constant ~3 draw calls
// regardless of route count. Two consequences callers should know about:
//
//   1. Per-route visibility filtering is not supported. Today only the whole `routeGroup` /
//      `envelopeGroup` toggles, so this is fine. Showing a single route would require a
//      draw-range trick, an attribute-mask in a custom shader, or rebuilding the merged
//      buffer with a subset of routes.
//
//   2. Per-route runtime updates require rebuilding the whole merged buffer. Routes are static
//      today, so this never happens. If a route's polyline ever changes at runtime, you cannot
//      update only that route's slice — you must rebuild and re-upload the merged geometry
//      (and rebuild the cone InstancedMesh).
//
// If either capability becomes a requirement, prefer adding a per-vertex `routeId` attribute
// (or a parallel cone-instance → routeId table) over reverting the merge.

const CONE_AXIS = new THREE.Vector3(0, 1, 0);

/** Builds one merged centerline mesh for all routes plus one InstancedMesh containing every direction cone. */
export function createRouteGroup(routes: AirRoute[]): THREE.Group {
  const group = new THREE.Group();
  const centerlineGeometries: THREE.BufferGeometry[] = [];
  const conePositions: THREE.Vector3[] = [];
  const coneQuaternions: THREE.Quaternion[] = [];
  const coneColors: THREE.Color[] = [];

  routes.forEach((route) => {
    const points = route.points.map(toVector3);
    if (points.length < 2) {
      return;
    }

    const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0);
    const tubeGeometry = new THREE.TubeGeometry(
      curve,
      Math.max(route.points.length * ROUTE_SEGMENTS_PER_POINT, ROUTE_MIN_TUBE_SEGMENTS),
      ROUTE_LINE_RADIUS_METERS,
      ROUTE_TUBE_RADIAL_SEGMENTS,
      false,
    );
    const routeColor = new THREE.Color(route.color);
    setUniformVertexColor(tubeGeometry, routeColor);
    centerlineGeometries.push(tubeGeometry);

    for (let index = 2; index < points.length; index += ROUTE_DIRECTION_CONE_STEP) {
      const start = points[index - 1];
      const end = points[index];
      const direction = end.clone().sub(start).normalize();
      const offset = direction.clone().multiplyScalar(ROUTE_DIRECTION_CONE_HEIGHT_METERS / 2 + ROUTE_LINE_RADIUS_METERS);
      conePositions.push(end.clone().sub(offset));
      coneQuaternions.push(new THREE.Quaternion().setFromUnitVectors(CONE_AXIS, direction));
      coneColors.push(routeColor);
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

/** Builds one merged translucent tube mesh containing every route's flight envelope. */
export function createFlightEnvelopeGroup(routes: AirRoute[]): THREE.Group {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  routes.forEach((route) => {
    const geometry = createPolylineTubeGeometry(
      route.points.map(toVector3),
      route.envelopeRadius,
      ENVELOPE_RADIAL_SEGMENTS,
    );
    if (!geometry) {
      return;
    }
    setUniformVertexColor(geometry, new THREE.Color(route.color));
    geometries.push(geometry);
  });

  const mesh = buildMergedMesh(geometries, () => new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    opacity: ENVELOPE_OPACITY,
    roughness: ENVELOPE_ROUGHNESS,
    metalness: 0,
    depthWrite: false,
    side: THREE.FrontSide,
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

/** Packs every route's direction cones into one InstancedMesh with per-instance transform and color. */
function buildConeInstancedMesh(
  positions: THREE.Vector3[],
  quaternions: THREE.Quaternion[],
  colors: THREE.Color[],
): THREE.InstancedMesh {
  const geometry = new THREE.ConeGeometry(
    ROUTE_DIRECTION_CONE_RADIUS_METERS,
    ROUTE_DIRECTION_CONE_HEIGHT_METERS,
    ROUTE_DIRECTION_CONE_RADIAL_SEGMENTS,
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
