import * as THREE from "three";
import type { AirCorridor, FlowDefinition, UavSchedule, UavState } from "../types";
import { SELECTED_UAV_COLOR } from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { setUavYawQuaternion } from "../geometry/drone";
import { createFleet, getUavCorridorPosition } from "./demoFleet";
import { formatCorridorSummary, type FleetFrame, type FleetFrameContext, type FleetSelection, type FleetSource } from "./source";

/**
 * Renders the frontend-only fleet expanded from local flow definitions. Owns the scheduling state
 * (pending/active rosters) and the kinematic sampling that places each UAV along its corridor.
 */
export class DemoFleetSource implements FleetSource {
  private readonly corridorById: Map<string, AirCorridor>;
  private readonly fleet: UavSchedule[];
  private readonly fleetById: Map<string, UavSchedule>;
  /** Fleet indices ordered by departure time; consumed front-to-back as sim time advances. */
  private readonly pendingUavIndices: number[];
  private readonly activeUavIndices: number[] = [];
  private readonly renderSlotToFleetIndex: number[] = [];
  private readonly uavStateById = new Map<string, UavState>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly selectedColor = new THREE.Color(SELECTED_UAV_COLOR);
  private readonly corridorColor = new THREE.Color();

  private nextPendingUavIndex = 0;
  private selectedFleetIndex = -1;

  constructor(corridors: AirCorridor[], flows: FlowDefinition[], corridorById: Map<string, AirCorridor>) {
    this.corridorById = corridorById;
    this.fleet = createFleet(corridors, flows);
    this.fleetById = new Map(this.fleet.map((uav) => [uav.id, uav]));
    this.pendingUavIndices = this.fleet
      .map((_, index) => index)
      .sort((a, b) => this.fleet[a].departureTimeSeconds - this.fleet[b].departureTimeSeconds);
  }

  /** Number of scheduled UAVs; used by FleetScene to size the shared InstancedMesh. */
  get fleetSize(): number {
    return this.fleet.length;
  }

  /** Updates each active UAV's position/orientation and writes its instance matrix and tint color. */
  update(ctx: FleetFrameContext): FleetFrame {
    const { mesh, elapsedSeconds, selectedUavId } = ctx;
    this.activateDepartedUavs(elapsedSeconds);
    this.uavStateById.clear();
    let activeCount = 0;
    let selection: FleetSelection | null = null;

    for (let activeIndex = 0; activeIndex < this.activeUavIndices.length;) {
      const index = this.activeUavIndices[activeIndex];
      const uav = this.fleet[index];
      const corridor = this.corridorById.get(uav.corridorId);
      if (!corridor) {
        this.removeActiveUavAt(activeIndex);
        continue;
      }

      const uavState = getUavCorridorPosition(uav, corridor, elapsedSeconds, 1);
      const position = toVector3(uavState.position);
      const tangent = toVector3(uavState.tangent).normalize();

      if (uavState.status === "destroyed") {
        if (uav.id === selectedUavId) {
          selection = { position, tangent };
        }
        this.removeActiveUavAt(activeIndex);
        continue;
      }

      if (uavState.status !== "active") {
        activeIndex += 1;
        continue;
      }

      const renderSlot = activeCount;
      activeCount += 1;
      this.renderSlotToFleetIndex[renderSlot] = index;
      this.uavStateById.set(uav.id, uavState);
      setUavYawQuaternion(this.quaternion, tangent);
      this.matrix.compose(position, this.quaternion, this.scale);
      mesh.setMatrixAt(renderSlot, this.matrix);
      mesh.setColorAt(renderSlot, index === this.selectedFleetIndex ? this.selectedColor : this.corridorColor.set(corridor.color));

      if (uav.id === selectedUavId) {
        selection = { position, tangent };
      }
      activeIndex += 1;
    }

    this.renderSlotToFleetIndex.length = activeCount;
    mesh.count = activeCount;
    if (activeCount > 0) {
      mesh.instanceMatrix.addUpdateRange(0, activeCount * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.addUpdateRange(0, activeCount * 3);
        mesh.instanceColor.needsUpdate = true;
      }
    }

    return {
      activeCount,
      scheduledCount: this.fleet.length,
      simTimeSeconds: elapsedSeconds,
      selectedUavId,
      selection,
      uavStateById: this.uavStateById,
      selectedSummary: this.describeSelection(selectedUavId),
    };
  }

  selectAt(renderSlot: number, selectedUavId: string): string | null {
    const fleetIndex = this.renderSlotToFleetIndex[renderSlot];
    if (fleetIndex === undefined || !this.fleet[fleetIndex]) {
      return null;
    }

    const uavId = this.fleet[fleetIndex].id;
    if (fleetIndex === this.selectedFleetIndex || uavId === selectedUavId) {
      this.selectedFleetIndex = -1;
      return "";
    }

    this.selectedFleetIndex = fleetIndex;
    return uavId;
  }

  reset(): void {
    this.nextPendingUavIndex = 0;
    this.activeUavIndices.length = 0;
    this.renderSlotToFleetIndex.length = 0;
    this.uavStateById.clear();
    this.selectedFleetIndex = -1;
  }

  /** Promotes any pending UAVs whose departure time has been reached into the active set. */
  private activateDepartedUavs(elapsedSeconds: number): void {
    while (this.nextPendingUavIndex < this.pendingUavIndices.length) {
      const fleetIndex = this.pendingUavIndices[this.nextPendingUavIndex];
      if (this.fleet[fleetIndex].departureTimeSeconds > elapsedSeconds) {
        break;
      }

      this.activeUavIndices.push(fleetIndex);
      this.nextPendingUavIndex += 1;
    }
  }

  /** O(1) removal from the active list by swapping the last entry into the freed slot. */
  private removeActiveUavAt(activeIndex: number): void {
    const lastIndex = this.activeUavIndices.pop();
    if (lastIndex !== undefined && activeIndex < this.activeUavIndices.length) {
      this.activeUavIndices[activeIndex] = lastIndex;
    }
  }

  private describeSelection(selectedUavId: string): string {
    const selectedUav = this.fleetById.get(selectedUavId);
    if (!selectedUav) {
      return "none";
    }

    const corridor = this.corridorById.get(selectedUav.corridorId);
    const corridorText = corridor ? formatCorridorSummary(corridor) : `Corridor ${selectedUav.corridorId}`;
    return `${selectedUav.id} · ${selectedUav.type} · ${corridorText}`;
  }
}
