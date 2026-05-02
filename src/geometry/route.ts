import * as THREE from "three";
import { WORLD_UP } from "../constant";

export function createPolylineTubeGeometry(
  rawPoints: THREE.Vector3[],
  radius: number,
  radialSegments: number,
): THREE.BufferGeometry | null {
  const points = removeDuplicateVectorPoints(rawPoints);
  if (points.length < 2) {
    return null;
  }

  const tangents = points.map((point, index) => getPolylineTangent(points, point, index));
  const positions: number[] = [];
  const indices: number[] = [];
  const rotation = new THREE.Quaternion();
  let normal = chooseTubeNormal(tangents[0]);
  let binormal = new THREE.Vector3().crossVectors(tangents[0], normal).normalize();

  points.forEach((point, pointIndex) => {
    const tangent = tangents[pointIndex];

    if (pointIndex > 0) {
      rotation.setFromUnitVectors(tangents[pointIndex - 1], tangent);
      normal.applyQuaternion(rotation);
      normal.addScaledVector(tangent, -normal.dot(tangent));
      if (normal.lengthSq() < 0.000001) {
        normal = chooseTubeNormal(tangent);
      } else {
        normal.normalize();
      }
      binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    }

    for (let segmentIndex = 0; segmentIndex < radialSegments; segmentIndex += 1) {
      const angle = (segmentIndex / radialSegments) * Math.PI * 2;
      const radialOffset = normal.clone().multiplyScalar(Math.cos(angle) * radius);
      radialOffset.addScaledVector(binormal, Math.sin(angle) * radius);
      positions.push(point.x + radialOffset.x, point.y + radialOffset.y, point.z + radialOffset.z);
    }
  });

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

function removeDuplicateVectorPoints(points: THREE.Vector3[]): THREE.Vector3[] {
  const filtered: THREE.Vector3[] = [];

  points.forEach((point) => {
    if (!filtered.length || filtered[filtered.length - 1].distanceToSquared(point) > 0.000001) {
      filtered.push(point);
    }
  });

  return filtered;
}

function getPolylineTangent(points: THREE.Vector3[], point: THREE.Vector3, index: number): THREE.Vector3 {
  if (index === 0) {
    return points[1].clone().sub(point).normalize();
  }

  if (index === points.length - 1) {
    return point.clone().sub(points[index - 1]).normalize();
  }

  const incoming = point.clone().sub(points[index - 1]).normalize();
  const outgoing = points[index + 1].clone().sub(point).normalize();
  const tangent = incoming.add(outgoing);

  if (tangent.lengthSq() < 0.000001) {
    return points[index + 1].clone().sub(points[index - 1]).normalize();
  }

  return tangent.normalize();
}

function chooseTubeNormal(tangent: THREE.Vector3): THREE.Vector3 {
  const reference = Math.abs(tangent.dot(WORLD_UP)) > 0.94 ? new THREE.Vector3(1, 0, 0) : WORLD_UP;
  return new THREE.Vector3().crossVectors(reference, tangent).normalize();
}
