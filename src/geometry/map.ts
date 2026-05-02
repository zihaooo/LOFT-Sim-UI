import * as THREE from "three";
import type { BuildingFootprint, SceneBounds, ScenePoint } from "../types";
import { GRID_COLOR, GRID_OPACITY, GRID_Y_OFFSET_METERS } from "../constant";

/** Extrudes a 2D footprint into a 3D building geometry; returns null when the footprint has no points. */
export function createBuildingGeometry(building: BuildingFootprint): THREE.BufferGeometry | null {
  const shape = new THREE.Shape();
  const [first, ...rest] = building.points;

  if (!first) {
    return null;
  }

  shape.moveTo(first.x, -first.z);
  rest.forEach((point) => {
    shape.lineTo(point.x, -point.z);
  });
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: building.height,
    bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function createBoundedGrid(bounds: SceneBounds): THREE.LineSegments {
  const positions: number[] = [];
  const spacing = chooseGridSpacing(Math.max(bounds.width, bounds.depth));
  const y = GRID_Y_OFFSET_METERS;
  const firstX = Math.ceil(bounds.min.x / spacing) * spacing;
  const firstZ = Math.ceil(bounds.min.z / spacing) * spacing;

  for (let x = firstX; x <= bounds.max.x + 0.001; x += spacing) {
    positions.push(x, y, bounds.min.z, x, y, bounds.max.z);
  }

  for (let z = firstZ; z <= bounds.max.z + 0.001; z += spacing) {
    positions.push(bounds.min.x, y, z, bounds.max.x, y, z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: GRID_COLOR,
    transparent: true,
    opacity: GRID_OPACITY,
    depthWrite: false,
  });
  return new THREE.LineSegments(geometry, material);
}

export function clipHorizontalPolygonToBounds(polygon: ScenePoint[], bounds: SceneBounds): ScenePoint[] {
  return clipPolygonEdge(
    clipPolygonEdge(
      clipPolygonEdge(
        clipPolygonEdge(polygon, (point) => point.x >= bounds.min.x, (a, b) => intersectAtX(a, b, bounds.min.x)),
        (point) => point.x <= bounds.max.x,
        (a, b) => intersectAtX(a, b, bounds.max.x),
      ),
      (point) => point.z >= bounds.min.z,
      (a, b) => intersectAtZ(a, b, bounds.min.z),
    ),
    (point) => point.z <= bounds.max.z,
    (a, b) => intersectAtZ(a, b, bounds.max.z),
  );
}

/** Memoizes THREE.Color instances by hex string to avoid per-segment allocations during road meshing. */
export function getCachedColor(cache: Map<string, THREE.Color>, value: string): THREE.Color {
  const cached = cache.get(value);
  if (cached) {
    return cached;
  }

  const color = new THREE.Color(value);
  cache.set(value, color);
  return color;
}

function chooseGridSpacing(size: number): number {
  if (size > 6_000) return 200;
  if (size > 3_000) return 100;
  if (size > 1_500) return 50;
  return 25;
}

function clipPolygonEdge(
  polygon: ScenePoint[],
  isInside: (point: ScenePoint) => boolean,
  intersect: (a: ScenePoint, b: ScenePoint) => ScenePoint,
): ScenePoint[] {
  if (polygon.length === 0) {
    return [];
  }

  const output: ScenePoint[] = [];
  let previous = polygon[polygon.length - 1];
  let previousInside = isInside(previous);

  polygon.forEach((current) => {
    const currentInside = isInside(current);

    if (currentInside !== previousInside) {
      output.push(intersect(previous, current));
    }
    if (currentInside) {
      output.push(current);
    }

    previous = current;
    previousInside = currentInside;
  });

  return output;
}

function intersectAtX(a: ScenePoint, b: ScenePoint, x: number): ScenePoint {
  const denominator = b.x - a.x;
  const t = Math.abs(denominator) < 0.000001 ? 0 : (x - a.x) / denominator;
  return interpolatePoint(a, b, t);
}

function intersectAtZ(a: ScenePoint, b: ScenePoint, z: number): ScenePoint {
  const denominator = b.z - a.z;
  const t = Math.abs(denominator) < 0.000001 ? 0 : (z - a.z) / denominator;
  return interpolatePoint(a, b, t);
}

function interpolatePoint(a: ScenePoint, b: ScenePoint, t: number): ScenePoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}
