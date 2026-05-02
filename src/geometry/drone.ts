import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  DRONE_MODEL_CANDIDATES,
  DRONE_MODEL_SPAN_METERS,
  FALLBACK_UAV_HEIGHT_METERS,
  FALLBACK_UAV_RADIAL_SEGMENTS,
  FALLBACK_UAV_RADIUS_METERS,
  WORLD_UP,
} from "../constant";

export async function loadDroneGeometry(): Promise<THREE.BufferGeometry | null> {
  const modelPath = await findExistingDroneModelPath();
  if (!modelPath) {
    return null;
  }

  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(modelPath);
    return createDroneModelGeometry(gltf.scene);
  } catch (error) {
    console.warn(`Failed to load drone model from ${modelPath}; falling back to cone.`, error);
    return null;
  }
}

export function createFallbackUavGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(
    FALLBACK_UAV_RADIUS_METERS,
    FALLBACK_UAV_HEIGHT_METERS,
    FALLBACK_UAV_RADIAL_SEGMENTS,
  );
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

export function setUavYawQuaternion(quaternion: THREE.Quaternion, tangent: THREE.Vector3): void {
  const horizontalLength = Math.hypot(tangent.x, tangent.z);
  if (horizontalLength < 0.000001) {
    quaternion.identity();
    return;
  }

  quaternion.setFromAxisAngle(WORLD_UP, Math.atan2(tangent.x, tangent.z));
}

async function findExistingDroneModelPath(): Promise<string | null> {
  for (const path of DRONE_MODEL_CANDIDATES) {
    if (await assetExists(path)) {
      return path;
    }
  }

  return null;
}

async function assetExists(path: string): Promise<boolean> {
  try {
    const response = await fetch(path, { method: "HEAD", cache: "no-store" });
    const contentType = response.headers.get("content-type") ?? "";
    return response.ok && !contentType.includes("text/html");
  } catch {
    return false;
  }
}

function createDroneModelGeometry(root: THREE.Object3D): THREE.BufferGeometry | null {
  const geometries: THREE.BufferGeometry[] = [];
  root.updateWorldMatrix(true, true);

  root.traverse((object) => {
    if (!isMeshWithGeometry(object)) {
      return;
    }

    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    geometries.push(geometry);
  });

  if (geometries.length === 0) {
    return null;
  }

  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());

  if (!merged) {
    return null;
  }

  normalizeDroneGeometry(merged);
  return merged;
}

function isMeshWithGeometry(object: THREE.Object3D): object is THREE.Mesh {
  const candidate = object as THREE.Mesh;
  return candidate.isMesh === true && Boolean(candidate.geometry);
}

function normalizeDroneGeometry(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) {
    return;
  }

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const footprint = Math.max(size.x, size.z, 0.0001);
  const scale = DRONE_MODEL_SPAN_METERS / footprint;

  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(scale, scale, scale);
  geometry.rotateY(Math.PI);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}
