import * as THREE from "three";
import type { AirCorridor, UavState } from "../types";
import { toScreenPosition, toVector3 } from "../geometry/coordinates";

export type CorridorLabelNode = {
  element: HTMLDivElement;
  position: THREE.Vector3;
};

type UpdateLabelOptions = {
  labelLayer: HTMLDivElement;
  corridorLabelNodes: CorridorLabelNode[];
  uavLabelNodes: Map<string, HTMLDivElement>;
  uavStateById: Map<string, UavState>;
  camera: THREE.Camera;
  host: HTMLElement;
  selectedUavId: string;
  corridorsVisible: boolean;
  envelopesVisible: boolean;
  uavLabelsVisible: boolean;
};

/** Creates one DOM label per corridor anchored above its midpoint, returning anchor positions for projection. */
export function createCorridorLabels(corridors: AirCorridor[], labelLayer: HTMLDivElement): CorridorLabelNode[] {
  return corridors.map((corridor) => {
    const position = toVector3(corridor.points[Math.floor(corridor.points.length / 2)] ?? { x: 0, y: 0, z: 0 });
    position.y += corridor.envelopeRadius;

    const label = document.createElement("div");
    label.className = "corridor-label";
    label.textContent = `Corridor ${corridor.id}`;
    label.style.borderColor = corridor.color;
    label.style.color = corridor.color;
    labelLayer.appendChild(label);
    return { element: label, position };
  });
}

/** Returns an empty UAV-id → label DOM-node map; entries are added lazily as UAVs become selected. */
export function createUavLabels(): Map<string, HTMLDivElement> {
  return new Map<string, HTMLDivElement>();
}

/** Per-frame: re-projects corridor labels, prunes stale UAV labels, and refreshes the selected UAV's label. */
export function updateLabels(options: UpdateLabelOptions): void {
  options.labelLayer.classList.toggle("label-layer--uav-visible", options.uavLabelsVisible);

  options.corridorLabelNodes.forEach(({ element, position }) => {
    const screenPoint = toScreenPosition(position, options.camera, options.host);
    element.style.transform = `translate3d(${screenPoint.x}px, ${screenPoint.y}px, 0)`;
    element.hidden = !options.uavLabelsVisible || (!options.corridorsVisible && !options.envelopesVisible);
  });

  const selectedUavState = options.uavStateById.get(options.selectedUavId);

  options.uavLabelNodes.forEach((label, uavId) => {
    if (uavId !== options.selectedUavId || !selectedUavState) {
      label.remove();
      options.uavLabelNodes.delete(uavId);
    }
  });

  if (!options.uavLabelsVisible) {
    options.uavLabelNodes.forEach((label) => {
      label.hidden = true;
    });
    return;
  }

  if (selectedUavState) {
    updateUavLabel(options, options.selectedUavId, selectedUavState);
  }
}

/** Lazily creates the label for a UAV and positions it on screen, hiding it when the UAV is not active. */
function updateUavLabel(options: UpdateLabelOptions, uavId: string, uavState: UavState): void {
  let label = options.uavLabelNodes.get(uavId);
  if (!label) {
    label = document.createElement("div");
    label.className = "uav-label";
    label.textContent = uavId;
    options.labelLayer.appendChild(label);
    options.uavLabelNodes.set(uavId, label);
  }

  if (uavState.status !== "active") {
    label.hidden = true;
    return;
  }

  const screenPoint = toScreenPosition(toVector3(uavState.position), options.camera, options.host);
  label.hidden = false;
  label.style.transform = `translate(${screenPoint.x}px, ${screenPoint.y}px)`;
  label.classList.toggle("uav-label--selected", uavId === options.selectedUavId);
}
