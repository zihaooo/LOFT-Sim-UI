import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import {
  CORRIDOR_DIRECTION_CONE_HEIGHT_METERS,
  CORRIDOR_DIRECTION_CONE_RADIAL_SEGMENTS,
  CORRIDOR_DIRECTION_CONE_RADIUS_METERS,
  CORRIDOR_DIRECTION_CONE_SPACING_METERS,
  CORRIDOR_LINE_WIDTH_PIXELS,
} from "../constant";

const CONE_AXIS = new THREE.Vector3(0, 1, 0);

/** Drops arrow cones along a corridor at a fixed arc-length spacing, each oriented down the local direction. */
export function appendDirectionCones(
  points: THREE.Vector3[],
  color: THREE.Color,
  positions: THREE.Vector3[],
  quaternions: THREE.Quaternion[],
  colors: THREE.Color[],
): void {
  let traveled = 0;
  let nextConeAt = CORRIDOR_DIRECTION_CONE_SPACING_METERS;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const segment = points[index].clone().sub(start);
    const segmentLength = segment.length();
    if (segmentLength < 0.000001) {
      continue;
    }
    const direction = segment.divideScalar(segmentLength);
    const orientation = new THREE.Quaternion().setFromUnitVectors(CONE_AXIS, direction);

    while (nextConeAt <= traveled + segmentLength) {
      const along = nextConeAt - traveled;
      positions.push(start.clone().addScaledVector(direction, along));
      quaternions.push(orientation.clone());
      colors.push(color);
      nextConeAt += CORRIDOR_DIRECTION_CONE_SPACING_METERS;
    }
    traveled += segmentLength;
  }
}

/** Batches every corridor centerline into one fat-line (Line2) draw call with per-vertex (per-component) colors. */
export function buildCorridorLines(positions: number[], colors: number[]): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  geometry.setColors(colors);
  const material = new LineMaterial({
    vertexColors: true,
    linewidth: CORRIDOR_LINE_WIDTH_PIXELS,
    worldUnits: false,
  });
  // Fat lines need the viewport size to size strokes in screen pixels; FleetScene keeps this current on resize.
  material.resolution.set(window.innerWidth, window.innerHeight);
  return new LineSegments2(geometry, material);
}

/** Packs every corridor's direction cones into one InstancedMesh with per-instance transform and color. */
export function buildConeInstancedMesh(
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
