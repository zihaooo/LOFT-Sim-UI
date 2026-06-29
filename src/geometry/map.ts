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

/** Builds a LineSegments grid of horizontal/vertical lines at adaptive spacing covering the scene bounds. */
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

/** Clips a polygon (in x/z) against the four scene-bounds edges using Sutherland-Hodgman. */
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

/** Tests whether a point lies inside the scene bounds in the x/z plane. */
export function isWithinHorizontalBounds(point: ScenePoint, bounds: SceneBounds): boolean {
  return (
    point.x >= bounds.min.x &&
    point.x <= bounds.max.x &&
    point.z >= bounds.min.z &&
    point.z <= bounds.max.z
  );
}

/** Expands scene bounds outward by a uniform margin in the x/z plane. */
export function padSceneBounds(bounds: SceneBounds, margin: number): SceneBounds {
  const min = { x: bounds.min.x - margin, y: 0, z: bounds.min.z - margin };
  const max = { x: bounds.max.x + margin, y: 0, z: bounds.max.z + margin };
  return { min, max, width: max.x - min.x, depth: max.z - min.z };
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

/** Picks a reference grid spacing in meters based on the longest scene dimension. */
function chooseGridSpacing(size: number): number {
  if (size > 6_000) return 200;
  if (size > 3_000) return 100;
  if (size > 1_500) return 50;
  return 25;
}

/** Sutherland-Hodgman one-edge clip: keeps inside vertices and inserts intersections where edges cross the clip line. */
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

/** Returns the point where segment a-b crosses the vertical clip plane at x. */
function intersectAtX(a: ScenePoint, b: ScenePoint, x: number): ScenePoint {
  const denominator = b.x - a.x;
  const t = Math.abs(denominator) < 0.000001 ? 0 : (x - a.x) / denominator;
  return interpolatePoint(a, b, t);
}

/** Returns the point where segment a-b crosses the vertical clip plane at z. */
function intersectAtZ(a: ScenePoint, b: ScenePoint, z: number): ScenePoint {
  const denominator = b.z - a.z;
  const t = Math.abs(denominator) < 0.000001 ? 0 : (z - a.z) / denominator;
  return interpolatePoint(a, b, t);
}

/** Componentwise linear interpolation between two scene points by parameter t. */
function interpolatePoint(a: ScenePoint, b: ScenePoint, t: number): ScenePoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}
