import * as THREE from "three";
import { WORLD_UP } from "../constant";

/** Builds a tube BufferGeometry around a polyline using parallel-transport frames; returns null if too few points. */
export function createPolylineTubeGeometry(
  rawPoints: THREE.Vector3[],
  radius: number,
  radialSegments: number,
): THREE.BufferGeometry | null {
  const points = removeDuplicateVectorPoints(rawPoints);
  if (points.length < 2) {
    return null;
  }

  // Each polyline edge is a perfect cylinder of radius `radius` along its own tangent. At an
  // interior vertex, two adjacent cylinders intersect on the bisector plane (the plane through
  // the vertex perpendicular to the bisector tangent) — that intersection is the miter ellipse.
  // For each ring vertex around the cylinder, we shift it along the cylinder's tangent so it
  // lands on the bisector plane. The two adjacent edges' shifted rings then coincide vertex-by-
  // vertex, so we share one ring per polyline vertex with no bevel band and no corner gap.
  const edgeCount = points.length - 1;
  const edgeTangents: THREE.Vector3[] = [];
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
    edgeTangents.push(points[edgeIndex + 1].clone().sub(points[edgeIndex]).normalize());
  }

  // Parallel-transport one (normal, binormal) frame along the polyline, one per edge.
  const edgeNormals: THREE.Vector3[] = [];
  const edgeBinormals: THREE.Vector3[] = [];
  let normal = chooseTubeNormal(edgeTangents[0]);
  edgeNormals.push(normal.clone());
  edgeBinormals.push(new THREE.Vector3().crossVectors(edgeTangents[0], normal).normalize());

  const rotation = new THREE.Quaternion();
  for (let edgeIndex = 1; edgeIndex < edgeCount; edgeIndex += 1) {
    const tangent = edgeTangents[edgeIndex];
    rotation.setFromUnitVectors(edgeTangents[edgeIndex - 1], tangent);
    normal.applyQuaternion(rotation);
    normal.addScaledVector(tangent, -normal.dot(tangent));
    if (normal.lengthSq() < 0.000001) {
      normal = chooseTubeNormal(tangent);
    } else {
      normal.normalize();
    }
    edgeNormals.push(normal.clone());
    edgeBinormals.push(new THREE.Vector3().crossVectors(tangent, normal).normalize());
  }

  const positions: number[] = [];
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    // Use the incoming edge's frame; vertex 0 has no incoming edge so it falls back to edge 0.
    const frameEdgeIndex = pointIndex === 0 ? 0 : pointIndex - 1;
    const tangent = edgeTangents[frameEdgeIndex];
    const ringNormal = edgeNormals[frameEdgeIndex];
    const ringBinormal = edgeBinormals[frameEdgeIndex];

    const bisector = computeBisector(edgeTangents, pointIndex, points.length);

    let dotN = 0;
    let dotB = 0;
    let inverseDotT = 0;
    if (bisector) {
      const dotT = tangent.dot(bisector);
      if (Math.abs(dotT) > 0.000001) {
        dotN = ringNormal.dot(bisector);
        dotB = ringBinormal.dot(bisector);
        inverseDotT = 1 / dotT;
      }
    }

    const point = points[pointIndex];
    for (let segmentIndex = 0; segmentIndex < radialSegments; segmentIndex += 1) {
      const angle = (segmentIndex / radialSegments) * Math.PI * 2;
      const cosAngle = Math.cos(angle);
      const sinAngle = Math.sin(angle);
      let offsetX = radius * (cosAngle * ringNormal.x + sinAngle * ringBinormal.x);
      let offsetY = radius * (cosAngle * ringNormal.y + sinAngle * ringBinormal.y);
      let offsetZ = radius * (cosAngle * ringNormal.z + sinAngle * ringBinormal.z);

      if (inverseDotT !== 0) {
        const shift = -radius * (cosAngle * dotN + sinAngle * dotB) * inverseDotT;
        offsetX += shift * tangent.x;
        offsetY += shift * tangent.y;
        offsetZ += shift * tangent.z;
      }

      positions.push(point.x + offsetX, point.y + offsetY, point.z + offsetZ);
    }
  }

  const indices: number[] = [];
  for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
    const currentRing = pointIndex * radialSegments;
    const nextRing = (pointIndex + 1) * radialSegments;

    for (let segmentIndex = 0; segmentIndex < radialSegments; segmentIndex += 1) {
      const nextSegmentIndex = (segmentIndex + 1) % radialSegments;
      const a = currentRing + segmentIndex;
      const b = currentRing + nextSegmentIndex;
      const c = nextRing + segmentIndex;
      const d = nextRing + nextSegmentIndex;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Returns the unit bisector tangent at an interior vertex, or null at endpoints and U-turns. */
function computeBisector(edgeTangents: THREE.Vector3[], pointIndex: number, pointCount: number): THREE.Vector3 | null {
  if (pointIndex === 0 || pointIndex === pointCount - 1) {
    return null;
  }
  const sum = edgeTangents[pointIndex - 1].clone().add(edgeTangents[pointIndex]);
  if (sum.lengthSq() < 0.000001) {
    return null;
  }
  return sum.normalize();
}

/** Drops consecutive duplicate vectors so the tube generator never gets a zero-length segment. */
function removeDuplicateVectorPoints(points: THREE.Vector3[]): THREE.Vector3[] {
  const filtered: THREE.Vector3[] = [];

  points.forEach((point) => {
    if (!filtered.length || filtered[filtered.length - 1].distanceToSquared(point) > 0.000001) {
      filtered.push(point);
    }
  });

  return filtered;
}

/** Picks an initial normal perpendicular to the tangent, falling back to +X when the tangent is nearly vertical. */
function chooseTubeNormal(tangent: THREE.Vector3): THREE.Vector3 {
  const reference = Math.abs(tangent.dot(WORLD_UP)) > 0.94 ? new THREE.Vector3(1, 0, 0) : WORLD_UP;
  return new THREE.Vector3().crossVectors(reference, tangent).normalize();
}
