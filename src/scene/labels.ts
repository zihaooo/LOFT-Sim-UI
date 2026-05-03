import * as THREE from "three";
import type { AirRoute, UavState } from "../types";
import { toScreenPosition, toVector3 } from "../geometry/coordinates";

export type RouteLabelNode = {
  element: HTMLDivElement;
  position: THREE.Vector3;
};

type UpdateLabelOptions = {
  labelLayer: HTMLDivElement;
  routeLabelNodes: RouteLabelNode[];
  uavLabelNodes: Map<string, HTMLDivElement>;
  uavStateById: Map<string, UavState>;
  camera: THREE.Camera;
  host: HTMLElement;
  selectedUavId: string;
  routesVisible: boolean;
  envelopesVisible: boolean;
  uavLabelsVisible: boolean;
};

export function createRouteLabels(routes: AirRoute[], labelLayer: HTMLDivElement): RouteLabelNode[] {
  return routes.map((route) => {
    const position = toVector3(route.points[Math.floor(route.points.length / 2)] ?? { x: 0, y: 0, z: 0 });
    position.y += route.envelopeRadius;

    const label = document.createElement("div");
    label.className = "route-label";
    label.textContent = `Route ${route.id}`;
    label.style.borderColor = route.color;
    label.style.color = route.color;
    labelLayer.appendChild(label);
    return { element: label, position };
  });
}

export function createUavLabels(): Map<string, HTMLDivElement> {
  return new Map<string, HTMLDivElement>();
}

export function updateLabels(options: UpdateLabelOptions): void {
  options.labelLayer.classList.toggle("label-layer--uav-visible", options.uavLabelsVisible);

  options.routeLabelNodes.forEach(({ element, position }) => {
    const screenPoint = toScreenPosition(position, options.camera, options.host);
    element.style.transform = `translate3d(${screenPoint.x}px, ${screenPoint.y}px, 0)`;
    element.hidden = !options.uavLabelsVisible || (!options.routesVisible && !options.envelopesVisible);
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
