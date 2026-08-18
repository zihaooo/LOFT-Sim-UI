import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { csgUnion } from "./csg";
import type { AirPath } from "../types";
import { ENVELOPE_RADIAL_SEGMENTS, WORLD_UP } from "../constant";
import { toVector3 } from "./coordinates";

// The flight envelope is a fat translucent tube (~35 m radius). Two requirements shape how we build it:
// overlapping translucent tubes double-blend into a darker, busier soup, so a connected set of air paths
// must read as ONE uniform-opacity solid; and that solid must stay watertight where air paths meet.
//
// We split the work by node degree, because the cheap bisector miter already solves most of it:
//
//   - Degree-2 nodes (a bend inside one air path, OR an end-to-end joint of two air paths) have a single
//     well-defined bisector plane, so a parallel-transport miter welds them gap-free. We therefore stitch
//     the component's edges into maximal "chains" that run through every miterable degree-2 node — crossing
//     air path boundaries when two air paths simply join — and build each chain with createSimpleTubeGeometry.
//
//   - Junction nodes (degree > 2 and NOT a vertiport: a T, an X, a diverging point) have no single
//     bisector plane, so there we fall back to CSG: a sphere at the node fuses every incident chain end.
//
// Each chain's polyline is simplified (Douglas-Peucker) before tubing: smoothed networks sample corridors
// every ~10 m, so a chain is mostly collinear runs that would otherwise cost hundreds of rings — and,
// worse, leave sharp corners flanked by segments far shorter than their miter shift. The miter shifts a
// ring by up to radius*tan(turn/2) along each tangent; when the two shifts on a segment overshoot its
// length, the tube folds inside-out into large fins. Simplification restores long segments around real
// corners, and any corner still too sharp to miter splits its chain there and is CSG-fused with a sphere,
// exactly like a junction node.
//
// A component with no junctions needs no CSG at all — its miter tubes already read as one solid and are
// merged directly. A component with junctions is CSG-unioned (chain tubes + junction spheres) into one
// watertight blob, in a single n-ary Manifold union. Stitching edges into maximal chains keeps the union
// input count low — one tube per chain rather than one per edge. Vertiport nodes never get a sphere and always end a chain, so the
// chain's flat end cap becomes a clean terminal. A chain end resting on the ground is extended straight down
// into a buried stub (groundTerminalPoints), so the tube bends to vertical and plunges into the ground with
// its flat cap hidden below the surface, instead of an open disk straddling y=0. Everything here runs once
// at load for a static scene.

const SPHERE_WIDTH_SEGMENTS = ENVELOPE_RADIAL_SEGMENTS;
const SPHERE_HEIGHT_SEGMENTS = 12;
/** A terminal node within this many meters of y=0 counts as resting on the ground plane. */
const GROUND_PLANE_EPSILON_METERS = 0.001;
/**
 * A ground terminal is extended straight down by this many tube radii into a buried "stub", so the tube
 * bends to vertical and plunges into the ground with its flat end cap hidden below the surface. Two radii
 * keeps the stub longer than the worst-case miter shift at the elbow, so the bend never self-intersects.
 */
const UNDERGROUND_STUB_DEPTH_RADII = 2;

export type ComponentEnvelope = {
  componentId: number;
  color: string;
  geometry: THREE.BufferGeometry;
};

type AirPathEdge = { a: string; b: string; radius: number; used: boolean };

/** The shared-node graph of one connected component: node positions/flags plus one edge per polyline segment. */
type AirPathGraph = {
  position: Map<string, THREE.Vector3>;
  vertiport: Map<string, boolean>;
  edges: AirPathEdge[];
  /** node id -> indices into `edges` of every edge incident to it; its length is the node's degree. */
  adjacency: Map<string, number[]>;
};

type Chain = { nodeIds: string[]; radius: number };
type JunctionNode = { position: THREE.Vector3; radius: number };

/** Builds one fused envelope geometry per connected component (grouped by `airPath.componentId`). */
export function buildComponentEnvelopeGeometries(airPaths: AirPath[]): ComponentEnvelope[] {
  const componentsById = new Map<number, AirPath[]>();
  airPaths.forEach((airPath) => {
    const group = componentsById.get(airPath.componentId);
    if (group) {
      group.push(airPath);
    } else {
      componentsById.set(airPath.componentId, [airPath]);
    }
  });

  const envelopes: ComponentEnvelope[] = [];
  componentsById.forEach((componentAirPaths, componentId) => {
    const geometry = buildComponentEnvelope(componentAirPaths);
    if (geometry) {
      envelopes.push({ componentId, color: componentAirPaths[0].color, geometry });
    }
  });

  return envelopes;
}

/**
 * Builds one watertight envelope geometry for a single connected component: bisector-miter tubes for the
 * degree-2 chains, plus a CSG sphere union at each junction node. Returns null if nothing was built.
 */
function buildComponentEnvelope(airPaths: AirPath[]): THREE.BufferGeometry | null {
  const graph = buildAirPathGraph(airPaths);

  const junctions = collectJunctionNodes(graph);
  const chainGeometries: THREE.BufferGeometry[] = [];
  extractChains(graph).forEach((chain) => {
    const simplified = simplifyPolyline(groundTerminalPoints(graph, chain), ENVELOPE_SIMPLIFY_TOLERANCE_METERS);
    const { runs, elbows } = splitUnmiterableChain(simplified, chain.radius);
    runs.forEach((points) => {
      const geometry = createSimpleTubeGeometry(points, chain.radius, ENVELOPE_RADIAL_SEGMENTS);
      if (geometry) {
        chainGeometries.push(geometry);
      }
    });
    elbows.forEach((position) => junctions.push({ position, radius: chain.radius }));
  });

  // No junction → the miter tubes already read as one solid, so merge them without paying for CSG.
  if (junctions.length === 0) {
    if (chainGeometries.length === 0) {
      return null;
    }
    const merged = mergeGeometries(chainGeometries, false);
    if (merged) {
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
    }
    return merged ?? null;
  }

  const solids = chainGeometries.slice();
  junctions.forEach((junction) => {
    solids.push(createSphereGeometry(junction.position, junction.radius));
  });
  if (solids.length === 0) {
    return null;
  }
  return unionGeometries(solids);
}

/** Builds the shared-node graph for one component: node positions/flags plus one edge per polyline segment. */
function buildAirPathGraph(airPaths: AirPath[]): AirPathGraph {
  const position = new Map<string, THREE.Vector3>();
  const vertiport = new Map<string, boolean>();
  const edges: AirPathEdge[] = [];
  const adjacency = new Map<string, number[]>();

  const addIncidentEdge = (nodeId: string, edgeIndex: number): void => {
    const incident = adjacency.get(nodeId);
    if (incident) {
      incident.push(edgeIndex);
    } else {
      adjacency.set(nodeId, [edgeIndex]);
    }
  };

  airPaths.forEach((airPath) => {
    const points = airPath.points.map(toVector3);
    airPath.nodeIds.forEach((nodeId, index) => {
      if (!position.has(nodeId)) {
        position.set(nodeId, points[index]);
      }
      // A node shared across air paths is a vertiport if any air path flags it as one (they should agree).
      vertiport.set(nodeId, (vertiport.get(nodeId) ?? false) || airPath.vertiportFlags[index]);
    });

    for (let index = 0; index < airPath.nodeIds.length - 1; index += 1) {
      const edgeIndex = edges.length;
      edges.push({
        a: airPath.nodeIds[index],
        b: airPath.nodeIds[index + 1],
        radius: airPath.envelopeRadius,
        used: false,
      });
      addIncidentEdge(airPath.nodeIds[index], edgeIndex);
      addIncidentEdge(airPath.nodeIds[index + 1], edgeIndex);
    }
  });

  return { position, vertiport, edges, adjacency };
}

/** A through node is a degree-2, non-vertiport node — the miter flows straight through it, so it never breaks a chain. */
function isThroughNode(graph: AirPathGraph, nodeId: string): boolean {
  return (graph.adjacency.get(nodeId)?.length ?? 0) === 2 && !graph.vertiport.get(nodeId);
}

/**
 * Splits the component's edges into maximal chains. Each chain runs through degree-2 nodes (stitching
 * adjacent air paths) and ends at a break node — a junction, a degree-1 terminal, or a vertiport.
 */
function extractChains(graph: AirPathGraph): Chain[] {
  const chains: Chain[] = [];

  // Root one chain at each break node per incident edge; the walk consumes every edge reachable through
  // through-nodes between two break nodes.
  graph.adjacency.forEach((edgeIndices, nodeId) => {
    if (isThroughNode(graph, nodeId)) {
      return;
    }
    edgeIndices.forEach((edgeIndex) => {
      if (!graph.edges[edgeIndex].used) {
        chains.push(walkChain(graph, nodeId, edgeIndex));
      }
    });
  });

  // Any edge still unused belongs to a pure loop of through-nodes (no break node to root it); cut it at an
  // arbitrary node, which leaves a single capped seam where the loop closes.
  graph.edges.forEach((edge, edgeIndex) => {
    if (!edge.used) {
      chains.push(walkChain(graph, edge.a, edgeIndex));
    }
  });

  return chains;
}

/** Walks from a break node along one edge, continuing through every through-node until the next break node. */
function walkChain(graph: AirPathGraph, startNodeId: string, firstEdgeIndex: number): Chain {
  const nodeIds = [startNodeId];
  let radius = 0;
  let currentNodeId = startNodeId;
  let edgeIndex = firstEdgeIndex;

  for (;;) {
    const edge = graph.edges[edgeIndex];
    edge.used = true;
    const nextNodeId = edge.a === currentNodeId ? edge.b : edge.a;
    nodeIds.push(nextNodeId);
    radius = Math.max(radius, edge.radius);

    if (!isThroughNode(graph, nextNodeId)) {
      break;
    }
    // A through-node has exactly two incident edges; continue along the one we did not arrive on.
    const continuation = (graph.adjacency.get(nextNodeId) ?? []).find(
      (candidate) => candidate !== edgeIndex && !graph.edges[candidate].used,
    );
    if (continuation === undefined) {
      break;
    }
    currentNodeId = nextNodeId;
    edgeIndex = continuation;
  }

  return { nodeIds, radius };
}

/**
 * Resolves a chain's node ids to scene points, extending any endpoint that rests on the ground with one
 * extra point straight below it. That turns the ground terminal into an interior miter vertex — the tube
 * bends to vertical and plunges down — and pushes the chain's actual flat end cap underground, where the
 * opaque ground hides it. So no perpendicular disk straddles y=0 and no end is left open. Junctions (fused
 * by a CSG sphere) and mid-air terminals are not extended.
 */
function groundTerminalPoints(graph: AirPathGraph, chain: Chain): THREE.Vector3[] {
  const points = chain.nodeIds.map((nodeId) => graph.position.get(nodeId) as THREE.Vector3);
  const depth = chain.radius * UNDERGROUND_STUB_DEPTH_RADII;
  const lastIndex = chain.nodeIds.length - 1;

  const extended: THREE.Vector3[] = [];
  if (isGroundTerminal(graph, chain.nodeIds[0])) {
    extended.push(undergroundStubPoint(points[0], depth));
  }
  extended.push(...points);
  if (lastIndex > 0 && isGroundTerminal(graph, chain.nodeIds[lastIndex])) {
    extended.push(undergroundStubPoint(points[lastIndex], depth));
  }
  return extended;
}

/** A point `depth` meters straight below `point`, where the tube's buried end cap hides under the ground. */
function undergroundStubPoint(point: THREE.Vector3, depth: number): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y - depth, point.z);
}

/** A ground terminal is an exposed chain end (degree-1 or a vertiport, never a CSG-fused junction) sitting on y=0. */
function isGroundTerminal(graph: AirPathGraph, nodeId: string): boolean {
  const position = graph.position.get(nodeId);
  if (!position || Math.abs(position.y) > GROUND_PLANE_EPSILON_METERS) {
    return false;
  }
  const degree = graph.adjacency.get(nodeId)?.length ?? 0;
  return degree === 1 || graph.vertiport.get(nodeId) === true;
}

/**
 * Chain polylines are simplified to this tolerance before tubing. Half a meter is invisible under a
 * ~35 m radius envelope, yet collapses a smoothed corridor's ~10 m sample steps into long segments —
 * cutting ring count ~20x and restoring enough segment length around corners for the miter to fit.
 */
const ENVELOPE_SIMPLIFY_TOLERANCE_METERS = 0.5;

/**
 * A segment's tube folds inside-out when its two endpoint miter shifts (up to radius*tan(turn/2) each)
 * sum past its length, so a vertex may claim at most this fraction of either adjacent segment; a vertex
 * over the limit splits its chain and is CSG-fused with a sphere instead.
 */
const MAX_MITER_SHIFT_SEGMENT_FRACTION = 0.5;

/** Iterative Douglas-Peucker; keeps endpoints and every vertex farther than `tolerance` from its run's chord. */
function simplifyPolyline(points: THREE.Vector3[], tolerance: number): THREE.Vector3[] {
  if (points.length <= 2) {
    return points;
  }
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;

  const chord = new THREE.Line3();
  const closest = new THREE.Vector3();
  const spans: Array<[number, number]> = [[0, points.length - 1]];
  while (spans.length > 0) {
    const [first, last] = spans.pop() as [number, number];
    chord.set(points[first], points[last]);
    let farthestIndex = -1;
    let farthestDistanceSq = tolerance * tolerance;
    for (let index = first + 1; index < last; index += 1) {
      chord.closestPointToPoint(points[index], true, closest);
      const distanceSq = closest.distanceToSquared(points[index]);
      if (distanceSq > farthestDistanceSq) {
        farthestDistanceSq = distanceSq;
        farthestIndex = index;
      }
    }
    if (farthestIndex !== -1) {
      keep[farthestIndex] = true;
      spans.push([first, farthestIndex], [farthestIndex, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

/**
 * Splits a chain polyline at every interior vertex too sharp to miter, returning the fold-free runs plus
 * the split points (each needs a junction sphere to fuse the abutting flat caps into one solid elbow).
 */
function splitUnmiterableChain(
  points: THREE.Vector3[],
  radius: number,
): { runs: THREE.Vector3[][]; elbows: THREE.Vector3[] } {
  const runs: THREE.Vector3[][] = [];
  const elbows: THREE.Vector3[] = [];

  let runStart = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const incoming = points[index].clone().sub(points[index - 1]);
    const outgoing = points[index + 1].clone().sub(points[index]);
    const shorterSegment = Math.min(incoming.length(), outgoing.length());
    incoming.normalize();
    outgoing.normalize();

    // tan(turn/2) = sin/(1+cos); a U-turn (cos -> -1) has no miter plane and always splits.
    const cosTurn = incoming.dot(outgoing);
    const miterShift =
      cosTurn < -0.999999 ? Infinity : radius * (incoming.cross(outgoing).length() / (1 + cosTurn));
    if (miterShift > shorterSegment * MAX_MITER_SHIFT_SEGMENT_FRACTION) {
      runs.push(points.slice(runStart, index + 1));
      elbows.push(points[index]);
      runStart = index;
    }
  }
  runs.push(points.slice(runStart));
  return { runs, elbows };
}

/**
 * Builds a tube BufferGeometry around a polyline using parallel-transport frames; returns null if too few
 * points. Faces wind outward and (when `caps`, the default) both ends are closed with a triangle fan, so
 * the result is a closed, outward-oriented solid suitable for translucent rendering and CSG booleans.
 */
export function createSimpleTubeGeometry(
  rawPoints: THREE.Vector3[],
  radius: number,
  radialSegments: number,
  options: { caps?: boolean } = {},
): THREE.BufferGeometry | null {
  const caps = options.caps ?? true;
  const points = removeDuplicateVectorPoints(rawPoints);
  if (points.length < 2) {
    return null;
  }

  // Each polyline edge is a perfect cylinder of radius `radius` along its own tangent. At an
  // interior vertex, two adjacent cylinders intersect on the bisector plane (the plane through
  // the vertex perpendicular to the bisector tangent) — that intersection is the miter ellipse.
  // For each ring vertex around the cylinder, we shift it along the cylinder's tangent so it
  // lands on the bisector plane. The two adjacent edges' shifted rings then coincide vertex-by-
  // vertex, so we share one ring per polyline vertex with no bevel band and no corner gap.
  const edgeCount = points.length - 1;
  const edgeTangents: THREE.Vector3[] = [];
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
    edgeTangents.push(points[edgeIndex + 1].clone().sub(points[edgeIndex]).normalize());
  }

  // Parallel-transport one (normal, binormal) frame along the polyline, one per edge.
  const edgeNormals: THREE.Vector3[] = [];
  const edgeBinormals: THREE.Vector3[] = [];
  let normal = chooseTubeNormal(edgeTangents[0]);
  edgeNormals.push(normal.clone());
  edgeBinormals.push(new THREE.Vector3().crossVectors(edgeTangents[0], normal).normalize());

  const rotation = new THREE.Quaternion();
  for (let edgeIndex = 1; edgeIndex < edgeCount; edgeIndex += 1) {
    const tangent = edgeTangents[edgeIndex];
    rotation.setFromUnitVectors(edgeTangents[edgeIndex - 1], tangent);
    normal.applyQuaternion(rotation);
    normal.addScaledVector(tangent, -normal.dot(tangent));
    if (normal.lengthSq() < 0.000001) {
      normal = chooseTubeNormal(tangent);
    } else {
      normal.normalize();
    }
    edgeNormals.push(normal.clone());
    edgeBinormals.push(new THREE.Vector3().crossVectors(tangent, normal).normalize());
  }

  const positions: number[] = [];
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    // Use the incoming edge's frame; vertex 0 has no incoming edge so it falls back to edge 0.
    const frameEdgeIndex = pointIndex === 0 ? 0 : pointIndex - 1;
    const tangent = edgeTangents[frameEdgeIndex];
    const ringNormal = edgeNormals[frameEdgeIndex];
    const ringBinormal = edgeBinormals[frameEdgeIndex];

    const bisector = computeBisector(edgeTangents, pointIndex, points.length);

    let dotN = 0;
    let dotB = 0;
    let inverseDotT = 0;
    if (bisector) {
      const dotT = tangent.dot(bisector);
      if (Math.abs(dotT) > 0.000001) {
        dotN = ringNormal.dot(bisector);
        dotB = ringBinormal.dot(bisector);
        inverseDotT = 1 / dotT;
      }
    }

    const point = points[pointIndex];
    for (let segmentIndex = 0; segmentIndex < radialSegments; segmentIndex += 1) {
      const angle = (segmentIndex / radialSegments) * Math.PI * 2;
      const cosAngle = Math.cos(angle);
      const sinAngle = Math.sin(angle);
      let offsetX = radius * (cosAngle * ringNormal.x + sinAngle * ringBinormal.x);
      let offsetY = radius * (cosAngle * ringNormal.y + sinAngle * ringBinormal.y);
      let offsetZ = radius * (cosAngle * ringNormal.z + sinAngle * ringBinormal.z);

      if (inverseDotT !== 0) {
        const shift = -radius * (cosAngle * dotN + sinAngle * dotB) * inverseDotT;
        offsetX += shift * tangent.x;
        offsetY += shift * tangent.y;
        offsetZ += shift * tangent.z;
      }

      positions.push(point.x + offsetX, point.y + offsetY, point.z + offsetZ);
    }
  }

  // Endpoints have no bisector, so their rings are planar circles centered exactly on the endpoint —
  // that point doubles as the cap-fan hub. Append the two hubs after every ring vertex.
  const startCapCenterIndex = points.length * radialSegments;
  const endCapCenterIndex = startCapCenterIndex + 1;
  if (caps) {
    const startPoint = points[0];
    const endPoint = points[points.length - 1];
    positions.push(startPoint.x, startPoint.y, startPoint.z);
    positions.push(endPoint.x, endPoint.y, endPoint.z);
  }

  const indices: number[] = [];
  for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
    const currentRing = pointIndex * radialSegments;
    const nextRing = (pointIndex + 1) * radialSegments;

    for (let segmentIndex = 0; segmentIndex < radialSegments; segmentIndex += 1) {
      const nextSegmentIndex = (segmentIndex + 1) % radialSegments;
      const a = currentRing + segmentIndex;
      const b = currentRing + nextSegmentIndex;
      const c = nextRing + segmentIndex;
      const d = nextRing + nextSegmentIndex;
      // Outward winding (normals point away from the axis) for correct lighting and CSG inside/outside.
      indices.push(a, b, c, b, d, c);
    }
  }

  if (caps) {
    const lastRing = (points.length - 1) * radialSegments;
    for (let segmentIndex = 0; segmentIndex < radialSegments; segmentIndex += 1) {
      const nextSegmentIndex = (segmentIndex + 1) % radialSegments;
      // Start cap faces back along -tangent; end cap faces forward along +tangent (both outward).
      indices.push(startCapCenterIndex, nextSegmentIndex, segmentIndex);
      indices.push(endCapCenterIndex, lastRing + segmentIndex, lastRing + nextSegmentIndex);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Returns the unit bisector tangent at an interior vertex, or null at endpoints and U-turns. */
function computeBisector(edgeTangents: THREE.Vector3[], pointIndex: number, pointCount: number): THREE.Vector3 | null {
  if (pointIndex === 0 || pointIndex === pointCount - 1) {
    return null;
  }
  const sum = edgeTangents[pointIndex - 1].clone().add(edgeTangents[pointIndex]);
  if (sum.lengthSq() < 0.000001) {
    return null;
  }
  return sum.normalize();
}

/** Drops consecutive duplicate vectors so the tube generator never gets a zero-length segment. */
function removeDuplicateVectorPoints(points: THREE.Vector3[]): THREE.Vector3[] {
  const filtered: THREE.Vector3[] = [];

  points.forEach((point) => {
    if (!filtered.length || filtered[filtered.length - 1].distanceToSquared(point) > 0.000001) {
      filtered.push(point);
    }
  });

  return filtered;
}

/** Picks an initial normal perpendicular to the tangent, falling back to +X when the tangent is nearly vertical. */
function chooseTubeNormal(tangent: THREE.Vector3): THREE.Vector3 {
  const reference = Math.abs(tangent.dot(WORLD_UP)) > 0.94 ? new THREE.Vector3(1, 0, 0) : WORLD_UP;
  return new THREE.Vector3().crossVectors(reference, tangent).normalize();
}

/** Junction nodes are shared by 3+ edges and are not vertiports; each gets a sphere sized to its widest incident air path. */
function collectJunctionNodes(graph: AirPathGraph): JunctionNode[] {
  const junctions: JunctionNode[] = [];
  graph.adjacency.forEach((edgeIndices, nodeId) => {
    if (edgeIndices.length <= 2 || graph.vertiport.get(nodeId)) {
      return;
    }
    let radius = 0;
    edgeIndices.forEach((edgeIndex) => {
      radius = Math.max(radius, graph.edges[edgeIndex].radius);
    });
    junctions.push({ position: graph.position.get(nodeId) as THREE.Vector3, radius });
  });
  return junctions;
}

/** A solid sphere of `radius` centered at `position`, with its translation baked into the geometry. */
function createSphereGeometry(position: THREE.Vector3, radius: number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);
  geometry.translate(position.x, position.y, position.z);
  // Chain tubes carry only position+normal; dropping uv keeps every union input's attribute set
  // identical, so the fallback merge below never rejects mixed attributes.
  geometry.deleteAttribute("uv");
  return geometry;
}

/**
 * Boolean-unions every closed input solid into one interior-free geometry, in a single n-ary Manifold
 * union. Falls back to a plain merge (overlapping, so it can double-blend) if Manifold rejects a
 * degenerate input, so a bad junction never blanks the layer. The lit envelope material needs normals,
 * which the position-only CSG result lacks, so they are recomputed here.
 */
function unionGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  try {
    const geometry = csgUnion(geometries);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  } catch (error) {
    console.warn("Envelope CSG union failed; falling back to overlapping tubes for this component.", error);
    return mergeGeometries(geometries, false) ?? null;
  }
}
