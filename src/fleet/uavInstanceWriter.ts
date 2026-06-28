import * as THREE from "three";
import { SELECTED_UAV_COLOR } from "../constant";
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

  constructor(
    private readonly meshesByType: Map<number, THREE.InstancedMesh>,
    private readonly defaultTypeCode: number,
  ) {}

  begin(): void {
    for (const typeCode of this.meshesByType.keys()) {
      this.cursors.set(typeCode, 0);
    }
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
    return { typeCode: resolved, slot };
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
  }
}
