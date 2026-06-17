import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ADDITION, Brush, Evaluator } from "three-bvh-csg";
import type { AirCorridor } from "../types";
import { toVector3 } from "./coordinates";

// The flight envelope is a fat translucent tube (~35 m radius). Where corridors connect, the per-way
// tubes must read as one solid: overlapping translucent tubes double-blend into a darker, busier soup,
// and at many-to-many / T junctions there is no single bisector plane to miter against. So instead of
// the centerline's miter approach we model each connected component as a union of convex solids and let
// a CSG boolean ADDITION fuse them into one watertight, uniform-opacity blob:
//
//   - one capped cylinder per polyline edge, and
//   - one sphere at every node that is NOT a vertiport terminal.
//
// The spheres do double duty: at an interior bend they fill the wedge gap two consecutive cylinders
// would otherwise leave, and at a shared junction node they fuse every incident tube — handling any
// valence (simple joint, T-junction, X) with no special cases. Vertiport nodes get no sphere, so the
// adjacent cylinder's flat cap becomes a clean terminal. Everything here runs once at load for a static
// scene; cost scales with brush count per component (see segment constants below).

const CYLINDER_AXIS = new THREE.Vector3(0, 1, 0);
const CYLINDER_RADIAL_SEGMENTS = 12;
const SPHERE_WIDTH_SEGMENTS = 12;
const SPHERE_HEIGHT_SEGMENTS = 8;
const MIN_EDGE_LENGTH = 0.0001;

export type ComponentEnvelope = {
  componentId: number;
  color: string;
  geometry: THREE.BufferGeometry;
};

/** Builds one fused envelope geometry per connected component (grouped by `corridor.componentId`). */
export function buildComponentEnvelopeGeometries(corridors: AirCorridor[]): ComponentEnvelope[] {
  const componentsById = new Map<number, AirCorridor[]>();
  corridors.forEach((corridor) => {
    const group = componentsById.get(corridor.componentId);
    if (group) {
      group.push(corridor);
    } else {
      componentsById.set(corridor.componentId, [corridor]);
    }
  });

  const evaluator = new Evaluator();
  evaluator.useGroups = false;
  // The capped cylinders / spheres carry only position + normal (no uv), so restrict the evaluator to
  // those attributes; leaving uv in the default set would make it read an attribute the brushes lack.
  evaluator.attributes = ["position", "normal"];

  const envelopes: ComponentEnvelope[] = [];
  componentsById.forEach((componentCorridors, componentId) => {
    const brushes = buildComponentBrushes(componentCorridors);
    if (brushes.length === 0) {
      return;
    }

    const geometry = unionBrushes(brushes, evaluator);
    if (!geometry) {
      return;
    }

    envelopes.push({ componentId, color: componentCorridors[0].color, geometry });
  });

  return envelopes;
}

/** Assembles the convex-primitive brushes (cylinders per edge, spheres per non-vertiport node) for one component. */
function buildComponentBrushes(corridors: AirCorridor[]): Brush[] {
  const brushes: Brush[] = [];
  // Shared junction nodes appear in several corridors; dedupe spheres by node id and keep the largest radius.
  const spheresByNode = new Map<string, { position: THREE.Vector3; radius: number }>();

  corridors.forEach((corridor) => {
    const radius = corridor.envelopeRadius;
    const points = corridor.points.map(toVector3);

    for (let index = 0; index < points.length - 1; index += 1) {
      const cylinder = createCylinderBrush(points[index], points[index + 1], radius);
      if (cylinder) {
        brushes.push(cylinder);
      }
    }

    for (let index = 0; index < points.length; index += 1) {
      if (corridor.vertiportFlags[index]) {
        continue;
      }
      const nodeId = corridor.nodeIds[index];
      const existing = spheresByNode.get(nodeId);
      if (existing) {
        existing.radius = Math.max(existing.radius, radius);
      } else {
        spheresByNode.set(nodeId, { position: points[index], radius });
      }
    }
  });

  spheresByNode.forEach(({ position, radius }) => {
    brushes.push(createSphereBrush(position, radius));
  });

  return brushes;
}

/** A solid capped cylinder of `radius` spanning `start`→`end`, with its transform baked into the geometry. */
function createCylinderBrush(start: THREE.Vector3, end: THREE.Vector3, radius: number): Brush | null {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  if (length < MIN_EDGE_LENGTH) {
    return null;
  }
  direction.divideScalar(length);

  const geometry = new THREE.CylinderGeometry(radius, radius, length, CYLINDER_RADIAL_SEGMENTS, 1, false);
  const orientation = new THREE.Quaternion().setFromUnitVectors(CYLINDER_AXIS, direction);
  const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  geometry.applyMatrix4(new THREE.Matrix4().compose(midpoint, orientation, new THREE.Vector3(1, 1, 1)));

  return makeBrush(geometry);
}

/** A solid sphere of `radius` centered at `position`, with its translation baked into the geometry. */
function createSphereBrush(position: THREE.Vector3, radius: number): Brush {
  const geometry = new THREE.SphereGeometry(radius, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);
  geometry.translate(position.x, position.y, position.z);
  return makeBrush(geometry);
}

/** Wraps a geometry as a Brush with an up-to-date (identity) world matrix, as the evaluator expects. */
function makeBrush(geometry: THREE.BufferGeometry): Brush {
  const brush = new Brush(geometry);
  brush.updateMatrixWorld();
  return brush;
}

/**
 * Boolean-unions every brush into one geometry. Falls back to a plain merge (overlapping, so it can
 * double-blend) if the CSG pipeline throws on degenerate input, so a bad junction never blanks the layer.
 */
function unionBrushes(brushes: Brush[], evaluator: Evaluator): THREE.BufferGeometry | null {
  try {
    let accumulated = brushes[0];
    for (let index = 1; index < brushes.length; index += 1) {
      accumulated = evaluator.evaluate(accumulated, brushes[index], ADDITION);
    }
    const geometry = accumulated.geometry;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  } catch (error) {
    console.warn("Envelope CSG union failed; falling back to overlapping tubes for this component.", error);
    const merged = mergeGeometries(
      brushes.map((brush) => brush.geometry),
      false,
    );
    return merged ?? null;
  }
}
