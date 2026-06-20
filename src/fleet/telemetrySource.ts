import * as THREE from "three";
import type {AirCorridor, AirRoute, UavState} from "../types";
import { ROUTE_COLORS, SELECTED_UAV_COLOR } from "../constant";
import { setUavYawQuaternion } from "../geometry/drone";
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
  private readonly renderSlotToHandle: number[] = [];
  private readonly uavStateById = new Map<string, UavState>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly selectedColor = new THREE.Color(SELECTED_UAV_COLOR);
  private readonly routeColor = new THREE.Color();
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

  update(ctx: FleetFrameContext): FleetFrame | null {
    const snapshot = this.client.latestSnapshot();
    if (!snapshot) {
      return null;
    }

    const { mesh } = ctx;
    const capacity = mesh.instanceMatrix.count;
    let selectedUavId = ctx.selectedUavId;
    let selectedRouteId: string | null = null;
    let selection: FleetSelection | null = null;
    this.uavStateById.clear();
    this.renderSlotToHandle.length = 0;
    let activeCount = 0;

    for (const drone of snapshot.drones) {
      if (activeCount >= capacity) {
        break;
      }
      if (drone.stateCode === 0) {
        continue;
      }

      const renderSlot = activeCount;
      activeCount += 1;
      this.renderSlotToHandle[renderSlot] = drone.handle;

      this.position.set(drone.position.x, drone.position.y, drone.position.z);
      this.tangent.set(drone.velocity.x, drone.velocity.y, drone.velocity.z);
      if (this.tangent.lengthSq() < 0.0001) {
        this.tangent.set(1, 0, 0);
      } else {
        this.tangent.normalize();
      }

      const droneId = this.getDroneId(drone.handle);
      const isSelected = drone.handle === this.selectedHandle || droneId === selectedUavId;
      setUavYawQuaternion(this.quaternion, this.tangent);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(renderSlot, this.matrix);
      mesh.setColorAt(renderSlot, isSelected ? this.selectedColor : this.getRouteColor(drone));

      if (isSelected) {
        selectedUavId = droneId;
        selectedRouteId = this.getRouteId(drone) ?? null;
        selection = {
          position: this.selectedPosition.copy(this.position),
          tangent: this.selectedTangent.copy(this.tangent),
        };
        this.uavStateById.set(droneId, {
          position: drone.position,
          tangent: { x: this.tangent.x, y: this.tangent.y, z: this.tangent.z },
          distance: 0,
          progress: 0,
          status: "active",
        });
      }
    }

    this.renderSlotToHandle.length = activeCount;
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
      scheduledCount: null,
      simTimeSeconds: snapshot.simTimeSeconds,
      selectedUavId,
      selectedRouteId,
      selection,
      uavStateById: this.uavStateById,
      selectedSummary: this.describeSelection(snapshot, selectedUavId),
    };
  }

  selectAt(renderSlot: number, selectedUavId: string): string | null {
    const handle = this.renderSlotToHandle[renderSlot];
    if (handle === undefined) {
      return null;
    }

    const droneId = this.getDroneId(handle);
    if (handle === this.selectedHandle || droneId === selectedUavId) {
      this.selectedHandle = -1;
      return "";
    }

    this.selectedHandle = handle;
    return droneId;
  }

  reset(): void {
    this.renderSlotToHandle.length = 0;
    this.uavStateById.clear();
    this.selectedHandle = -1;
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

  private getRouteColor(drone: TelemetryDroneState): THREE.Color {
    const routeId = this.getRouteId(drone);
    const route = routeId ? this.routeById.get(routeId) : undefined;
    return this.routeColor.set(route?.color ?? ROUTE_COLORS[drone.routeHandle % ROUTE_COLORS.length]);
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
