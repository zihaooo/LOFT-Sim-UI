import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SceneBounds } from "../types";
import {
  CAMERA_MIN_Y,
  CAMERA_MODES,
  FOLLOW_CAMERA_DISTANCE_METERS,
  FOLLOW_CAMERA_HEIGHT_METERS,
  FREE_CAMERA_PAN_METERS_PER_SECOND,
  INITIAL_CAMERA_HEIGHT_METERS,
  INITIAL_CAMERA_X_OFFSET_METERS,
  RESET_VIEW_DURATION_SECONDS,
  WORLD_UP,
} from "../constant";
import type { FleetSelection } from "../fleet/source";
import type { CameraMode, SimulationControlState } from "./control";

/** Ease-in-out cubic for a smooth accelerate/decelerate camera fly-back; maps [0,1] -> [0,1]. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Owns all camera behavior around the shared OrbitControls: the initial framing (cached as the
 * "Reset view" fly-back target), Free-mode keyboard panning, Follow-mode chasing of the selected UAV,
 * the animated Reset-view tween, and the above-ground height clamp. FleetScene calls update() once per
 * frame (before rendering) and routes key events and the control-panel buttons here; mode/selection
 * state is read from the shared SimulationControlState like everywhere else.
 */
export class CameraRig {
  /** Held keys (lowercased) driving Free-mode keyboard panning. */
  private readonly keys = new Set<string>();
  /** Latest known pose of the selected UAV; persists while a selection frame is briefly absent. */
  private readonly selectedPosition = new THREE.Vector3();
  private readonly selectedTangent = new THREE.Vector3(1, 0, 0);
  private readonly initialCameraPosition = new THREE.Vector3();
  private readonly initialTarget = new THREE.Vector3();
  /** Camera pose captured when a "Reset view" fly-back begins; end pose is the initial frame above. */
  private readonly viewResetStartPosition = new THREE.Vector3();
  private readonly viewResetStartTarget = new THREE.Vector3();
  private viewResetElapsedSeconds = 0;
  private isResettingView = false;
  private previousCameraMode: CameraMode = CAMERA_MODES.FREE;
  private previousSelectedUavId = "";
  private readonly lastFollowPosition = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    sceneBounds: SceneBounds,
    private readonly params: SimulationControlState,
  ) {
    this.setInitialCameraFrame(sceneBounds);
  }

  /** Per-frame camera pass: keyboard pan, follow mode, reset tween, orbit damping, ground clamp. */
  update(delta: number, selection: FleetSelection | null): void {
    if (selection) {
      this.selectedPosition.copy(selection.position);
      this.selectedTangent.copy(selection.tangent);
    }
    this.applyKeyboardNavigation(delta);
    this.updateFollowMode();
    this.updateViewReset(delta);
    this.controls.update();
    this.constrainCameraAboveHorizon();
  }

  /** Starts a smooth fly-back from the current camera pose to the initial framing (position + look-at target). */
  resetView(): void {
    // Follow mode drives the camera every frame, so drop to Free or the tween would be fought and snap back.
    this.params.cameraMode = CAMERA_MODES.FREE;
    this.viewResetStartPosition.copy(this.camera.position);
    this.viewResetStartTarget.copy(this.controls.target);
    this.viewResetElapsedSeconds = 0;
    this.isResettingView = true;
  }

  /** Snaps the camera straight back to the initial framing in Free mode (used by Reset simulation). */
  resetToInitialFrame(): void {
    this.params.cameraMode = CAMERA_MODES.FREE;
    this.camera.position.copy(this.initialCameraPosition);
    this.controls.target.copy(this.initialTarget);
  }

  /** Tracks held keys (lowercased) for keyboard navigation; registered by FleetScene. */
  handleKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.key.toLowerCase());
  };

  /** Releases held-key state when a key is lifted. */
  handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase());
  };

  /** Starts at the middle of the ground plane's south edge, looking at the ground center. */
  private setInitialCameraFrame(bounds: SceneBounds): void {
    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;

    this.initialTarget.set(centerX, 0, centerZ);
    this.initialCameraPosition.set(centerX + INITIAL_CAMERA_X_OFFSET_METERS, INITIAL_CAMERA_HEIGHT_METERS, centerZ);

    this.camera.position.copy(this.initialCameraPosition);
    this.controls.target.copy(this.initialTarget);
  }

  /** WASD/arrow keys pan the camera (and orbit target) along the ground plane while in Free mode. */
  private applyKeyboardNavigation(delta: number): void {
    if (this.params.cameraMode !== CAMERA_MODES.FREE || this.keys.size === 0) {
      return;
    }

    const direction = new THREE.Vector3();
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, WORLD_UP).normalize();

    if (this.keys.has("w") || this.keys.has("arrowup")) direction.add(forward);
    if (this.keys.has("s") || this.keys.has("arrowdown")) direction.sub(forward);
    if (this.keys.has("d") || this.keys.has("arrowright")) direction.add(right);
    if (this.keys.has("a") || this.keys.has("arrowleft")) direction.sub(right);

    if (direction.lengthSq() === 0) {
      return;
    }

    direction.normalize().multiplyScalar(FREE_CAMERA_PAN_METERS_PER_SECOND * delta);
    this.camera.position.add(direction);
    this.controls.target.add(direction);
  }

  /** Switches between Free orbit and Follow modes; in Follow, snaps behind/above the UAV on entry then trails it. */
  private updateFollowMode(): void {
    const followEnabled = this.params.cameraMode === CAMERA_MODES.FOLLOW_SELECTED_UAV && Boolean(this.params.selectedUavId);
    const justEnteredFollow = followEnabled && this.previousCameraMode !== CAMERA_MODES.FOLLOW_SELECTED_UAV;
    const selectionChanged = this.params.selectedUavId !== this.previousSelectedUavId;
    this.controls.enabled = true;

    if (!followEnabled) {
      this.previousCameraMode = this.params.cameraMode;
      this.previousSelectedUavId = this.params.selectedUavId;
      return;
    }

    if (justEnteredFollow || selectionChanged) {
      const behind = this.selectedTangent.clone().multiplyScalar(-FOLLOW_CAMERA_DISTANCE_METERS);
      this.camera.position.copy(this.selectedPosition).add(behind).add(new THREE.Vector3(0, FOLLOW_CAMERA_HEIGHT_METERS, 0));
      this.controls.target.copy(this.selectedPosition);
    } else {
      const movement = this.selectedPosition.clone().sub(this.lastFollowPosition);
      this.camera.position.add(movement);
      this.controls.target.add(movement);
    }

    this.lastFollowPosition.copy(this.selectedPosition);
    this.previousCameraMode = this.params.cameraMode;
    this.previousSelectedUavId = this.params.selectedUavId;
  }

  /** Advances an in-flight "Reset view" tween, easing camera position and orbit target toward the initial frame. */
  private updateViewReset(delta: number): void {
    if (!this.isResettingView) {
      return;
    }
    // Suspend orbit input for the flight so a stray drag can't fight the tween; restored when it lands.
    this.controls.enabled = false;
    this.viewResetElapsedSeconds += delta;
    const progress = Math.min(this.viewResetElapsedSeconds / RESET_VIEW_DURATION_SECONDS, 1);
    const eased = easeInOutCubic(progress);
    this.camera.position.lerpVectors(this.viewResetStartPosition, this.initialCameraPosition, eased);
    this.controls.target.lerpVectors(this.viewResetStartTarget, this.initialTarget, eased);
    if (progress >= 1) {
      this.isResettingView = false;
      this.controls.enabled = true;
    }
  }

  /** Clamps the camera's height to CAMERA_MIN_Y so it can't drop below the ground plane. */
  private constrainCameraAboveHorizon(): void {
    if (this.camera.position.y < CAMERA_MIN_Y) {
      this.camera.position.y = CAMERA_MIN_Y;
    }
  }
}
