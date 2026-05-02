import * as THREE from "three";
import type { AirRoute } from "../types";
import {
  ENVELOPE_OPACITY,
  ENVELOPE_RADIAL_SEGMENTS,
  ENVELOPE_ROUGHNESS,
  ROUTE_DIRECTION_CONE_HEIGHT_METERS,
  ROUTE_DIRECTION_CONE_RADIAL_SEGMENTS,
  ROUTE_DIRECTION_CONE_RADIUS_METERS,
  ROUTE_DIRECTION_CONE_STEP,
  ROUTE_LINE_RADIUS_METERS,
  ROUTE_MIN_TUBE_SEGMENTS,
  ROUTE_SEGMENTS_PER_POINT,
  ROUTE_TUBE_RADIAL_SEGMENTS,
} from "../constant";
import { toVector3 } from "../geometry/coordinates";
import { createPolylineTubeGeometry } from "../geometry/route";

export function createRouteGroup(routes: AirRoute[]): THREE.Group {
  const group = new THREE.Group();

  routes.forEach((route) => {
    const points = route.points.map(toVector3);
    const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0);
    const geometry = new THREE.TubeGeometry(
      curve,
      Math.max(route.points.length * ROUTE_SEGMENTS_PER_POINT, ROUTE_MIN_TUBE_SEGMENTS),
      ROUTE_LINE_RADIUS_METERS,
      ROUTE_TUBE_RADIAL_SEGMENTS,
      false,
    );
    const material = new THREE.MeshBasicMaterial({
      color: route.color,
    });
    const centerline = new THREE.Mesh(geometry, material);
    group.add(centerline);

    for (let index = 2; index < points.length; index += ROUTE_DIRECTION_CONE_STEP) {
      const start = points[index - 1];
      const end = points[index];
      const direction = end.clone().sub(start).normalize();
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(
          ROUTE_DIRECTION_CONE_RADIUS_METERS,
          ROUTE_DIRECTION_CONE_HEIGHT_METERS,
          ROUTE_DIRECTION_CONE_RADIAL_SEGMENTS,
        ),
        new THREE.MeshBasicMaterial({ color: route.color }),
      );
      cone.position.copy(end).sub(direction.clone().multiplyScalar(ROUTE_DIRECTION_CONE_HEIGHT_METERS / 2 + ROUTE_LINE_RADIUS_METERS));
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      group.add(cone);
    }
  });

  return group;
}

export function createFlightEnvelopeGroup(routes: AirRoute[]): THREE.Group {
  const group = new THREE.Group();

  routes.forEach((route) => {
    const geometry = createPolylineTubeGeometry(route.points.map(toVector3), route.envelopeRadius, ENVELOPE_RADIAL_SEGMENTS);
    if (!geometry) {
      return;
    }

    const material = new THREE.MeshStandardMaterial({
      color: route.color,
      transparent: true,
      opacity: ENVELOPE_OPACITY,
      roughness: ENVELOPE_ROUGHNESS,
      metalness: 0,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
  });

  return group;
}
