import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  DRONE_MODEL_PATHS_BY_TYPE,
  DRONE_MODEL_SPAN_METERS,
  FALLBACK_UAV_HEIGHT_METERS,
  FALLBACK_UAV_RADIAL_SEGMENTS,
  FALLBACK_UAV_RADIUS_METERS,
  WORLD_UP,
} from "../constant";

/** A loaded UAV model: one merged geometry (with per-material groups) plus the materials those groups index. */
export type UavModel = {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
};

/**
 * Loads every per-type UAV model, keyed by vehicleTypeCode. Each model's gltf materials are preserved
 * (geometry merged with groups) so the InstancedMesh can render the model's own colors. Types whose asset
 * is missing or fails to load are simply omitted; the caller falls back to a cone for those.
 */
export async function loadUavModels(): Promise<Map<number, UavModel>> {
  const loader = new GLTFLoader();
  const entries = await Promise.all(
    Object.entries(DRONE_MODEL_PATHS_BY_TYPE).map(async ([code, path]) => {
      const model = await loadUavModel(loader, path);
      return [Number(code), model] as const;
    }),
  );

  const models = new Map<number, UavModel>();
  for (const [code, model] of entries) {
    if (model) {
      models.set(code, model);
    }
  }
  return models;
}

/** Deep-copies a model so each FleetScene owns disposable geometry/materials (the scene disposes them on teardown). */
export function cloneUavModel(model: UavModel): UavModel {
  return {
    geometry: model.geometry.clone(),
    materials: model.materials.map((material) => material.clone()),
  };
}

/** Clones every model in a per-type map (see cloneUavModel). */
export function cloneUavModels(models: Map<number, UavModel>): Map<number, UavModel> {
  const cloned = new Map<number, UavModel>();
  for (const [code, model] of models) {
    cloned.set(code, cloneUavModel(model));
  }
  return cloned;
}

/** Creates a forward-pointing cone used in place of a UAV model when its gltf asset can't be loaded. */
export function createFallbackUavGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(
    FALLBACK_UAV_RADIUS_METERS,
    FALLBACK_UAV_HEIGHT_METERS,
    FALLBACK_UAV_RADIAL_SEGMENTS,
  );
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** Writes a yaw-only quaternion that turns the UAV to face the horizontal projection of its tangent. */
export function setUavYawQuaternion(quaternion: THREE.Quaternion, tangent: THREE.Vector3): void {
  const horizontalLength = Math.hypot(tangent.x, tangent.z);
  if (horizontalLength < 0.000001) {
    quaternion.identity();
    return;
  }

  quaternion.setFromAxisAngle(WORLD_UP, Math.atan2(tangent.x, tangent.z));
}

/** Loads one gltf and bakes it into a normalized model, returning null when the asset is unavailable. */
async function loadUavModel(loader: GLTFLoader, modelPath: string): Promise<UavModel | null> {
  if (!(await assetExists(modelPath))) {
    return null;
  }

  try {
    const gltf = await loader.loadAsync(modelPath);
    return buildUavModel(gltf.scene);
  } catch (error) {
    console.warn(`Failed to load UAV model from ${modelPath}; falling back to cone.`, error);
    return null;
  }
}

/** HEAD-checks an asset URL and rejects HTML responses (which usually indicate a dev-server fallback page). */
async function assetExists(path: string): Promise<boolean> {
  try {
    const response = await fetch(path, { method: "HEAD", cache: "no-store" });
    const contentType = response.headers.get("content-type") ?? "";
    return response.ok && !contentType.includes("text/html");
  } catch {
    return false;
  }
}

/**
 * Walks the gltf scene, baking world transforms into one merged geometry while keeping each source mesh's
 * material. Merging with groups means group i indexes materials[i], so the InstancedMesh renders the model's
 * own colors. Returns null when the scene carries no geometry.
 */
function buildUavModel(root: THREE.Object3D): UavModel | null {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  root.updateWorldMatrix(true, true);

  root.traverse((object) => {
    if (!isMeshWithGeometry(object)) {
      return;
    }

    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    geometries.push(geometry);
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    materials.push(material.clone());
  });

  if (geometries.length === 0) {
    return null;
  }

  const merged = mergeGeometries(geometries, true);
  geometries.forEach((geometry) => geometry.dispose());

  if (!merged) {
    return null;
  }

  normalizeDroneGeometry(merged);
  return { geometry: merged, materials };
}

/** Type guard: true when an Object3D is a THREE.Mesh that actually carries geometry. */
function isMeshWithGeometry(object: THREE.Object3D): object is THREE.Mesh {
  const candidate = object as THREE.Mesh;
  return candidate.isMesh && Boolean(candidate.geometry);
}

/** Centers the drone geometry on its origin and scales it so its widest horizontal span matches the configured size. */
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
