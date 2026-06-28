import * as THREE from "three";
import type { AirRoute, FlowDefinition, UavSchedule, UavState } from "../types";
import { DEFAULT_VEHICLE_TYPE_CODE } from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { setUavYawQuaternion } from "../geometry/drone";
import { createFleet, getUavRoutePosition } from "./demoFleet";
import { formatRouteSummary, type FleetFrame, type FleetFrameContext, type FleetSelection, type FleetSource } from "./source";

/**
 * Renders the frontend-only fleet expanded from local flow definitions. Owns the scheduling state
 * (pending/active rosters) and the kinematic sampling that places each UAV along its route.
 */
export class DemoFleetSource implements FleetSource {
  private readonly routeById: Map<string, AirRoute>;
  private readonly fleet: UavSchedule[];
  private readonly fleetById: Map<string, UavSchedule>;
  /** Fleet indices ordered by departure time; consumed front-to-back as sim time advances. */
  private readonly pendingUavIndices: number[];
  private readonly activeUavIndices: number[] = [];
  /** Per-vehicle-type slot -> fleet index (the demo only populates the default type), for resolving picks. */
  private readonly slotToFleetIndexByType = new Map<number, number[]>();
  private readonly uavStateById = new Map<string, UavState>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);

  private nextPendingUavIndex = 0;

  constructor(routes: AirRoute[], flows: FlowDefinition[], routeById: Map<string, AirRoute>) {
    this.routeById = routeById;
    this.fleet = createFleet(routes, flows);
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
    const { writer, elapsedSeconds, selectedUavId } = ctx;
    writer.begin();
    for (const slots of this.slotToFleetIndexByType.values()) {
      slots.length = 0;
    }
    this.activateDepartedUavs(elapsedSeconds);
    this.uavStateById.clear();
    let activeCount = 0;
    let selection: FleetSelection | null = null;

    for (let activeIndex = 0; activeIndex < this.activeUavIndices.length;) {
      const index = this.activeUavIndices[activeIndex];
      const uav = this.fleet[index];
      const route = this.routeById.get(uav.routeId);
      if (!route) {
        this.removeActiveUavAt(activeIndex);
        continue;
      }

      const uavState = getUavRoutePosition(uav, route, elapsedSeconds, 1);
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

      this.uavStateById.set(uav.id, uavState);
      setUavYawQuaternion(this.quaternion, tangent);
      this.matrix.compose(position, this.quaternion, this.scale);
      const written = writer.write(DEFAULT_VEHICLE_TYPE_CODE, this.matrix, uav.id === selectedUavId);
      if (written) {
        activeCount += 1;
        this.recordSlotFleetIndex(written.typeCode, written.slot, index);
      }

      if (uav.id === selectedUavId) {
        selection = { position, tangent };
      }
      activeIndex += 1;
    }

    writer.commit();

    return {
      activeCount,
      scheduledCount: this.fleet.length,
      simTimeSeconds: elapsedSeconds,
      selectedUavId,
      selectedRouteId: this.fleetById.get(selectedUavId)?.routeId ?? null,
      selection,
      uavStateById: this.uavStateById,
      selectedSummary: this.describeSelection(selectedUavId),
    };
  }

  resolveId(typeCode: number, instanceId: number): string | null {
    const fleetIndex = this.slotToFleetIndexByType.get(typeCode)?.[instanceId];
    if (fleetIndex === undefined || !this.fleet[fleetIndex]) {
      return null;
    }

    return this.fleet[fleetIndex].id;
  }

  reset(): void {
    this.nextPendingUavIndex = 0;
    this.activeUavIndices.length = 0;
    this.slotToFleetIndexByType.clear();
    this.uavStateById.clear();
  }

  /** Records which fleet index occupies a per-type instance slot, for resolving raycast hits back to a UAV. */
  private recordSlotFleetIndex(typeCode: number, slot: number, fleetIndex: number): void {
    let slots = this.slotToFleetIndexByType.get(typeCode);
    if (!slots) {
      slots = [];
      this.slotToFleetIndexByType.set(typeCode, slots);
    }
    slots[slot] = fleetIndex;
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

    const route = this.routeById.get(selectedUav.routeId);
    const routeText = route ? formatRouteSummary(route) : `Route ${selectedUav.routeId}`;
    return `${selectedUav.id} · ${selectedUav.type} · ${routeText}`;
  }
}
