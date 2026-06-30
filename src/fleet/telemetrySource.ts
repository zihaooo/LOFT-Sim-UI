import * as THREE from "three";
import type {AirCorridor, AirRoute, UavState} from "../types";
import { setUavAttitudeQuaternion } from "../geometry/drone";
import type { TelemetryClient } from "../telemetry/client";
import type { TelemetryDroneState, TelemetrySnapshot } from "../telemetry/protocol";
import {
  formatRouteSummary,
  type FleetFrame,
  type FleetFrameContext,
  type FleetSelection,
  type FleetSource,
  type TelemetryDebugReadout, formatCorridorSummary,
} from "./source";

/**
 * Renders backend telemetry snapshots directly, without frontend interpolation. Owns the WebSocket
 * client lifecycle and the mapping from binary drone handles to the scene's stable string ids.
 */
export class TelemetrySource implements FleetSource {
  /** Per-vehicle-type slot -> drone handle, so a picked (type code, instanceId) resolves back to a drone. */
  private readonly slotToHandleByType = new Map<number, number[]>();
  private readonly uavStateById = new Map<string, UavState>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly position = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3(1, 0, 0);
  private readonly selectedPosition = new THREE.Vector3();
  private readonly selectedTangent = new THREE.Vector3(1, 0, 0);

  private selectedHandle = -1;

  constructor(
    private readonly client: TelemetryClient,
    private readonly routeById: Map<string, AirRoute>,
    private readonly corridorById:  Map<string, AirCorridor>,
  ) {}

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  setRunning(running: boolean): void {
    this.client.setRunning(running);
  }

  setSpeed(speed: number): void {
    this.client.setSpeed(speed);
  }

  update(ctx: FleetFrameContext): FleetFrame | null {
    const snapshot = this.client.latestSnapshot();
    if (!snapshot) {
      return null;
    }

    const { writer } = ctx;
    writer.begin();
    for (const slots of this.slotToHandleByType.values()) {
      slots.length = 0;
    }
    // Re-anchor the selected handle from the canonical id every frame so selection changes (toggled and
    // owned by FleetScene) take effect here, while a still-streaming prior handle survives a registry id
    // remap. selectedUavId lingers unchanged when the selected drone is absent from this snapshot.
    this.selectedHandle = this.resolveSelectedHandle(snapshot, ctx.selectedUavId);
    let selectedUavId = this.selectedHandle === -1 ? ctx.selectedUavId : this.getDroneId(this.selectedHandle);
    let selectedRouteId: string | null = null;
    let selection: FleetSelection | null = null;
    this.uavStateById.clear();
    let activeCount = 0;

    for (const drone of snapshot.drones) {
      if (drone.stateCode === 0) {
        continue;
      }

      this.position.set(drone.position.x, drone.position.y, drone.position.z);
      this.tangent.set(drone.velocity.x, drone.velocity.y, drone.velocity.z);
      if (this.tangent.lengthSq() < 0.0001) {
        this.tangent.set(1, 0, 0);
      } else {
        this.tangent.normalize();
      }

      const isSelected = drone.handle === this.selectedHandle;
      // Orient from the backend's reported attitude rather than the velocity tangent, which stays stable when
      // the UAV hovers and its velocity collapses to noise (see setUavAttitudeQuaternion).
      setUavAttitudeQuaternion(this.quaternion, drone.yaw, drone.pitch, drone.roll);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      const written = writer.write(drone.vehicleTypeCode, this.matrix, isSelected);
      if (!written) {
        continue;
      }
      activeCount += 1;
      this.recordSlotHandle(written.typeCode, written.slot, drone.handle);

      if (isSelected) {
        selectedRouteId = this.getRouteId(drone) ?? null;
        selection = {
          position: this.selectedPosition.copy(this.position),
          tangent: this.selectedTangent.copy(this.tangent),
        };
        this.uavStateById.set(this.getDroneId(drone.handle), {
          position: drone.position,
          tangent: { x: this.tangent.x, y: this.tangent.y, z: this.tangent.z },
          distance: 0,
          progress: 0,
          status: "active",
        });
      }
    }

    writer.commit();

    return {
      activeCount,
      scheduledCount: null,
      simTimeSeconds: snapshot.simTimeSeconds,
      selectedUavId,
      selectedRouteId,
      selection,
      uavStateById: this.uavStateById,
      selectedSummary: this.describeSelection(snapshot, selectedUavId),
    };
  }

  resolveId(typeCode: number, instanceId: number): string | null {
    const handle = this.slotToHandleByType.get(typeCode)?.[instanceId];
    if (handle === undefined) {
      return null;
    }

    return this.getDroneId(handle);
  }

  /**
   * Maps the canonical selected id back to a live drone handle for this snapshot. Prefers a current id
   * match; failing that, keeps the previously anchored handle if it is still streaming, so selection
   * survives a handle's id changing once the registry catches up. Returns -1 when nothing is selected
   * or the selected drone has left this snapshot.
   */
  private resolveSelectedHandle(snapshot: TelemetrySnapshot, selectedUavId: string): number {
    if (selectedUavId === "") {
      return -1;
    }

    let priorHandleStillLive = false;
    for (const drone of snapshot.drones) {
      if (drone.stateCode === 0) {
        continue;
      }
      if (this.getDroneId(drone.handle) === selectedUavId) {
        return drone.handle;
      }
      if (drone.handle === this.selectedHandle) {
        priorHandleStillLive = true;
      }
    }

    return priorHandleStillLive ? this.selectedHandle : -1;
  }

  reset(): void {
    this.slotToHandleByType.clear();
    this.uavStateById.clear();
    this.selectedHandle = -1;
  }

  /** Records which drone handle occupies a per-type instance slot, for resolving raycast hits back to a drone. */
  private recordSlotHandle(typeCode: number, slot: number, handle: number): void {
    let slots = this.slotToHandleByType.get(typeCode);
    if (!slots) {
      slots = [];
      this.slotToHandleByType.set(typeCode, slots);
    }
    slots[slot] = handle;
  }

  /** Transport stats for the telemetry debug readout panel. */
  debugReadout(): TelemetryDebugReadout {
    const snapshot = this.client.latestSnapshot();
    const stats = this.client.getStats();
    return {
      connection: stats.connectionState,
      frequency: snapshot ? `${stats.snapshotHz.toFixed(1)} Hz` : "-",
      sequence: snapshot ? String(snapshot.sequence) : "-",
      age: snapshot ? `${Math.max(0, performance.now() - snapshot.receivedAtMs).toFixed(0)} ms` : "-",
      parse: snapshot ? `${stats.lastParseTimeMs.toFixed(2)} ms` : "-",
      skipped: snapshot ? stats.droppedSnapshotCount.toLocaleString() : "-",
      error: stats.lastError || "-",
    };
  }

  private getDroneId(handle: number): string {
    return this.client.getRegistry().dronesByHandle.get(handle)?.id ?? `D${handle}`;
  }

  private getRouteId(drone: TelemetryDroneState): string | undefined {
    return this.client.getRegistry().routesByHandle.get(drone.routeHandle)?.id;
  }

  private getCorridorId(drone: TelemetryDroneState): string | undefined {
    return this.client.getRegistry().corridorsByHandle.get(drone.corridorHandle)?.id;
  }

  private describeSelection(snapshot: TelemetrySnapshot, selectedUavId: string): string {
    const drone = snapshot.drones.find((candidate) => (
      candidate.handle === this.selectedHandle || this.getDroneId(candidate.handle) === selectedUavId
    ));
    if (!drone) {
      return "none";
    }

    const droneId = this.getDroneId(drone.handle);
    const droneType = this.client.getRegistry().dronesByHandle.get(drone.handle)?.vehicleType
      ?? `type ${drone.vehicleTypeCode}`;
    const routeId = this.getRouteId(drone);
    const route = routeId ? this.routeById.get(routeId) : undefined;
    const routeText = route ? formatRouteSummary(route) : `Route ${routeId ?? drone.routeHandle}`;

    const corridorId = this.getCorridorId(drone);
    const corridor = corridorId ? this.corridorById.get(corridorId) : undefined;
    const corridorText = corridor ? formatCorridorSummary(corridor) : `Corridor ${corridorId ?? drone.corridorHandle}`;

    return `${droneId} · ${droneType} · ${routeText} · ${corridorText}`;
  }
}
