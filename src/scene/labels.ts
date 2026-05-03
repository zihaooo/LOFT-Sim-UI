import * as THREE from "three";
import type { AirRoute, SampledRoutePosition } from "../types";
import { UAV_LABEL_MAX_ACTIVE } from "../constant";
import { toScreenPosition, toVector3 } from "../geometry/coordinates";

export type RouteLabelNode = {
  element: HTMLDivElement;
  position: THREE.Vector3;
};

type UpdateLabelOptions = {
  labelLayer: HTMLDivElement;
  routeLabelNodes: RouteLabelNode[];
  uavLabelNodes: Map<string, HTMLDivElement>;
  activeSamplesByUavId: Map<string, SampledRoutePosition>;
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

  options.uavLabelNodes.forEach((label, uavId) => {
    if (!options.activeSamplesByUavId.has(uavId)) {
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

  const visibleUavIds = new Set<string>();
  const selectedSample = options.activeSamplesByUavId.get(options.selectedUavId);
  if (selectedSample) {
    updateUavLabel(options, options.selectedUavId, selectedSample);
    visibleUavIds.add(options.selectedUavId);
  }

  for (const [uavId, sampled] of options.activeSamplesByUavId) {
    if (visibleUavIds.size >= UAV_LABEL_MAX_ACTIVE) {
      break;
    }
    if (visibleUavIds.has(uavId)) {
      continue;
    }

    updateUavLabel(options, uavId, sampled);
    visibleUavIds.add(uavId);
  }

  options.uavLabelNodes.forEach((label, uavId) => {
    label.hidden = !visibleUavIds.has(uavId);
  });
}

function updateUavLabel(options: UpdateLabelOptions, uavId: string, sampled: SampledRoutePosition): void {
  let label = options.uavLabelNodes.get(uavId);
  if (!label) {
    label = document.createElement("div");
    label.className = "uav-label";
    label.textContent = uavId;
    options.labelLayer.appendChild(label);
    options.uavLabelNodes.set(uavId, label);
  }

  if (!sampled.active) {
    label.hidden = true;
    return;
  }

  const screenPoint = toScreenPosition(toVector3(sampled.position), options.camera, options.host);
  label.hidden = false;
  label.style.transform = `translate(${screenPoint.x}px, ${screenPoint.y}px)`;
  label.classList.toggle("uav-label--selected", uavId === options.selectedUavId);
}
