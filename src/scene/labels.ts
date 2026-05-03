import * as THREE from "three";
import type { AirRoute, UavState } from "../types";
import { getUavRoutePosition } from "../animation/fleet";
import { toScreenPosition, toVector3 } from "../geometry/coordinates";

export type RouteLabelNode = {
  element: HTMLDivElement;
  position: THREE.Vector3;
};

type UpdateLabelOptions = {
  labelLayer: HTMLDivElement;
  routeLabelNodes: RouteLabelNode[];
  uavLabelNodes: Map<string, HTMLDivElement>;
  fleet: UavState[];
  routeById: Map<string, AirRoute>;
  camera: THREE.Camera;
  host: HTMLElement;
  elapsedSeconds: number;
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

export function createUavLabels(fleet: UavState[], labelLayer: HTMLDivElement): Map<string, HTMLDivElement> {
  const labelNodes = new Map<string, HTMLDivElement>();

  fleet.forEach((uav) => {
    const label = document.createElement("div");
    label.className = "uav-label";
    label.textContent = uav.id;
    labelLayer.appendChild(label);
    labelNodes.set(uav.id, label);
  });

  return labelNodes;
}

export function updateLabels(options: UpdateLabelOptions): void {
  options.labelLayer.classList.toggle("label-layer--uav-visible", options.uavLabelsVisible);

  options.routeLabelNodes.forEach(({ element, position }) => {
    const screenPoint = toScreenPosition(position, options.camera, options.host);
    element.style.transform = `translate3d(${screenPoint.x}px, ${screenPoint.y}px, 0)`;
    element.hidden = !options.routesVisible && !options.envelopesVisible;
  });

  options.fleet.forEach((uav) => {
    const label = options.uavLabelNodes.get(uav.id);
    const route = options.routeById.get(uav.routeId);
    if (!label || !route) {
      return;
    }

    const sampled = getUavRoutePosition(uav, route, options.elapsedSeconds, 1);
    if (sampled.status === "destroyed") {
      label.remove();
      options.uavLabelNodes.delete(uav.id);
      return;
    }

    label.hidden = !sampled.active;
    if (!sampled.active) {
      return;
    }

    const screenPoint = toScreenPosition(toVector3(sampled.position), options.camera, options.host);
    label.style.transform = `translate(${screenPoint.x}px, ${screenPoint.y}px)`;
    label.classList.toggle("uav-label--selected", uav.id === options.selectedUavId);
  });
}
