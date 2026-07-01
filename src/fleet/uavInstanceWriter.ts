import * as THREE from "three";
import {
  BLOB_SHADOW_FADE_HEIGHT_METERS,
  BLOB_SHADOW_GROWTH_PER_METER,
  BLOB_SHADOW_MAX_OPACITY,
  BLOB_SHADOW_MIN_OPACITY,
  BLOB_SHADOW_QUAD_HALF_EXTENT,
  BLOB_SHADOW_Y_OFFSET_METERS,
  DRONE_MODEL_SPAN_METERS_BY_TYPE,
  SELECTED_UAV_COLOR,
  SHADOW_OFFSET_X_PER_M,
  SHADOW_OFFSET_Z_PER_M,
  WORLD_UP,
} from "../constant";
import { SHADOW_PROFILE_INDEX_BY_TYPE } from "../layer/shadowProfiles";
import type { UavFrameWriter } from "./source";

const SELECTION_COLOR = new THREE.Color(SELECTED_UAV_COLOR);
const NO_HIGHLIGHT = new THREE.Color(0, 0, 0);

/**
 * Default {@link UavFrameWriter} over a fixed set of per-vehicle-type InstancedMeshes owned by FleetScene.
 * Owns the per-mesh slot cursors: begin() zeroes them, write() places one instance into the right type's
 * mesh, and commit() publishes counts (zeroing meshes no instance was written to, which is how switching
 * fleet sources drops stale instances). The per-instance color carries selection only — black leaves the
 * model's own materials, the selection color paints a solid highlight (see the patch in layer/drone.ts).
 */
export class UavInstanceWriter implements UavFrameWriter {
  private readonly cursors = new Map<number, number>();
  private blobCursor = 0;
  private readonly blobMatrix = new THREE.Matrix4();
  private readonly blobPosition = new THREE.Vector3();
  private readonly blobScale = new THREE.Vector3();
  private readonly blobQuaternion = new THREE.Quaternion();
  private readonly blobColor = new THREE.Color();

  constructor(
    private readonly meshesByType: Map<number, THREE.InstancedMesh>,
    private readonly defaultTypeCode: number,
    private readonly blobShadowMesh: THREE.InstancedMesh,
    private readonly surfaceHeightAt: (x: number, z: number) => number,
  ) {}

  begin(): void {
    for (const typeCode of this.meshesByType.keys()) {
      this.cursors.set(typeCode, 0);
    }
    this.blobCursor = 0;
  }

  write(typeCode: number, matrix: THREE.Matrix4, selected: boolean): { typeCode: number; slot: number } | null {
    const resolved = this.meshesByType.has(typeCode) ? typeCode : this.defaultTypeCode;
    const mesh = this.meshesByType.get(resolved);
    if (!mesh) {
      return null;
    }

    const slot = this.cursors.get(resolved) ?? 0;
    if (slot >= mesh.instanceMatrix.count) {
      return null;
    }

    mesh.setMatrixAt(slot, matrix);
    mesh.setColorAt(slot, selected ? SELECTION_COLOR : NO_HIGHLIGHT);
    this.cursors.set(resolved, slot + 1);
    this.writeBlobShadow(matrix, resolved);
    return { typeCode: resolved, slot };
  }

  /**
   * Emits this drone's ground shadow: project its position along the sun's parallel rays onto the receiving
   * surface, orient the per-type rectangle profile to the drone's heading, and size + fade it by the drone's
   * height above the surface. Faint (high) blobs are culled. The shape itself is drawn in the shader, selected
   * by the type index written into `instanceColor.g`.
   */
  private writeBlobShadow(matrix: THREE.Matrix4, typeCode: number): void {
    // The drone's world position is the matrix's translation column (column-major elements 12/13/14).
    const x = matrix.elements[12];
    const y = matrix.elements[13];
    const z = matrix.elements[14];
    const surfaceHeight = this.surfaceHeightAt(x, z);
    const above = Math.max(0, y - surfaceHeight);

    const opacity = BLOB_SHADOW_MAX_OPACITY * Math.min(1, 1 - above / BLOB_SHADOW_FADE_HEIGHT_METERS);
    if (opacity <= BLOB_SHADOW_MIN_OPACITY || this.blobCursor >= this.blobShadowMesh.instanceMatrix.count) {
      return;
    }

    // Scale the unit quad so its half-extent covers the drone's footprint (× the quad margin), grown with altitude.
    // The type code is already resolved to a known mesh, so it's always a key of the span map.
    const footprintHalf = DRONE_MODEL_SPAN_METERS_BY_TYPE[typeCode] / 2 + BLOB_SHADOW_GROWTH_PER_METER * above;
    const scale = 2 * BLOB_SHADOW_QUAD_HALF_EXTENT * footprintHalf;
    // Orient the profile to the drone's heading (yaw from its world matrix's forward column) so the shape lines up.
    this.blobQuaternion.setFromAxisAngle(WORLD_UP, Math.atan2(matrix.elements[8], matrix.elements[10]));
    this.blobPosition.set(
      x + above * SHADOW_OFFSET_X_PER_M,
      surfaceHeight + BLOB_SHADOW_Y_OFFSET_METERS,
      z + above * SHADOW_OFFSET_Z_PER_M,
    );
    this.blobScale.set(scale, 1, scale);
    this.blobMatrix.compose(this.blobPosition, this.blobQuaternion, this.blobScale);
    this.blobShadowMesh.setMatrixAt(this.blobCursor, this.blobMatrix);
    // instanceColor carries data, not colour: .r = altitude fade opacity, .g = shadow-profile (type) index.
    this.blobColor.r = opacity;
    this.blobColor.g = SHADOW_PROFILE_INDEX_BY_TYPE.get(typeCode) ?? 0;
    this.blobColor.b = 0;
    this.blobShadowMesh.setColorAt(this.blobCursor, this.blobColor);
    this.blobCursor += 1;
  }

  commit(): void {
    for (const [typeCode, mesh] of this.meshesByType) {
      const count = this.cursors.get(typeCode) ?? 0;
      mesh.count = count;
      if (count > 0) {
        mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.addUpdateRange(0, count * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
    }

    this.blobShadowMesh.count = this.blobCursor;
    if (this.blobCursor > 0) {
      this.blobShadowMesh.instanceMatrix.addUpdateRange(0, this.blobCursor * 16);
      this.blobShadowMesh.instanceMatrix.needsUpdate = true;
      if (this.blobShadowMesh.instanceColor) {
        this.blobShadowMesh.instanceColor.addUpdateRange(0, this.blobCursor * 3);
        this.blobShadowMesh.instanceColor.needsUpdate = true;
      }
    }
  }
}
