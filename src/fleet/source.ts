import type * as THREE from "three";
import type { AirRoute, AirCorridor, UavState } from "../types";

/**
 * Writes UAV instances into per-vehicle-type InstancedMeshes for one frame. A source calls begin() once,
 * then write() per visible drone, then commit(). The writer owns the per-mesh slot cursors so meshes a
 * source doesn't populate this frame are cleared to zero (this is how switching sources drops stale
 * instances). The per-instance color carries selection only: black = the model's own materials, the
 * selection color = a solid highlight (see the material patch in layer/drone.ts).
 *
 * The concrete implementation is {@link UavInstanceWriter} in uavInstanceWriter.ts.
 */
export type UavFrameWriter = {
  /** Resets every per-type cursor at the start of a frame. */
  begin(): void;
  /**
   * Writes one instance into the mesh for `typeCode` (falling back to the default type when unknown),
   * returning the resolved type and the instance slot within that mesh (for picking), or null when that
   * mesh is at capacity.
   */
  write(typeCode: number, matrix: THREE.Matrix4, selected: boolean): { typeCode: number; slot: number } | null;
  /** Publishes counts and flags GPU buffers for every mesh (including zeroing untouched ones). */
  commit(): void;
};

/** Inputs every fleet source needs to compute a frame and write instances into the per-type meshes. */
export type FleetFrameContext = {
  writer: UavFrameWriter;
  elapsedSeconds: number;
  selectedUavId: string;
};

/** World-space pose of the selected UAV, used to drive the follow camera. */
export type FleetSelection = {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
};

/** Everything FleetScene needs from a source after it has written this frame's instances into the mesh. */
export type FleetFrame = {
  /** Number of instances written into the mesh; the source has already set `mesh.count`. */
  activeCount: number;
  /** Total roster size for sources with a fixed schedule (demo); null for open-ended streams (telemetry). */
  scheduledCount: number | null;
  /** Authoritative simulation clock for this frame. */
  simTimeSeconds: number;
  /** Canonical selected id after the source reconciles it (telemetry maps a stale handle to the current id). */
  selectedUavId: string;
  /** Route id the selected UAV is flying, or null when nothing is selected (drives single-route display). */
  selectedRouteId: string | null;
  /** Follow-camera pose for the selected UAV, or null when nothing selectable is visible. */
  selection: FleetSelection | null;
  /** Active + selected UAV states keyed by id, for label projection. */
  uavStateById: Map<string, UavState>;
  /** One-line HUD description of the selected UAV ("none" when nothing is selected). */
  selectedSummary: string;
};

/** Source-specific transport stats rendered in the telemetry debug readout panel. */
export type TelemetryDebugReadout = {
  connection: string;
  frequency: string;
  sequence: string;
  age: string;
  parse: string;
  skipped: string;
  error: string;
};

/**
 * A per-frame source of UAV instances. FleetScene owns the mesh, camera, labels, and readouts; each
 * source only computes instance matrices/colors and maps render slots to selectable UAV ids. Telemetry
 * takes precedence whenever it has a live frame, otherwise the demo source renders the frontend fleet.
 */
export interface FleetSource {
  /** Writes this frame's instances via `ctx.writer` and returns the frame, or null when it has nothing this frame. */
  update(ctx: FleetFrameContext): FleetFrame | null;
  /**
   * Resolves a clicked instance, identified by the hit mesh's vehicle type code and the instance slot
   * within that mesh, to its canonical UAV id, or `null` when the slot maps to nothing. Pure lookup with
   * no side effects: FleetScene owns the toggle/clear policy and feeds the result back via `selectedUavId`.
   */
  resolveId(typeCode: number, instanceId: number): string | null;
  /** Clears transient runtime + selection state without releasing externally owned resources. */
  reset(): void;
}

/** Formats a route's endpoints for HUD selection text, shared by every source. */
export function formatRouteSummary(route: AirRoute): string {
  if (route.from && route.to) {
    return `${route.from} to ${route.to}`;
  }
  if (route.from) {
    return `${route.from} to unknown`;
  }
  if (route.to) {
    return `unknown to ${route.to}`;
  }
  return route.name || `Route ${route.id}`;
}

/** Formats a corridor's endpoints for HUD selection text, shared by every source. */
export function formatCorridorSummary(corridor: AirCorridor): string {
  return corridor.name || `Corridor ${corridor.id}`;
}