import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ADDITION, Brush, Evaluator } from "three-bvh-csg";
import type { AirCorridor } from "../types";
import { ENVELOPE_RADIAL_SEGMENTS } from "../constant";
import { toVector3 } from "./coordinates";
import { createPolylineTubeGeometry } from "./corridor";

// The flight envelope is a fat translucent tube (~35 m radius). Two requirements shape how we build it:
// overlapping translucent tubes double-blend into a darker, busier soup, so a connected set of corridors
// must read as ONE uniform-opacity solid; and that solid must stay watertight where corridors meet.
//
// We split the work by node degree, because the cheap bisector miter already solves most of it:
//
//   - Degree-2 nodes (a bend inside one corridor, OR an end-to-end joint of two corridors) have a single
//     well-defined bisector plane, so a parallel-transport miter welds them gap-free. We therefore stitch
//     the component's edges into maximal "chains" that run through every degree-2 node — crossing corridor
//     boundaries when two corridors simply join — and build each chain with createPolylineTubeGeometry.
//
//   - Junction nodes (degree > 2 and NOT a vertiport: a T, an X, a diverging point) have no single
//     bisector plane, so there we fall back to CSG: a sphere at the node fuses every incident chain end.
//
// A component with no junctions needs no CSG at all — its miter tubes already read as one solid and are
// merged directly. A component with junctions is CSG-unioned (chain tubes + junction spheres) into one
// watertight blob. Either way the old approach's per-edge cylinders and per-node spheres are gone, cutting
// brush count by ~10x on the sample data. Vertiport nodes never get a sphere and always end a chain, so the
// chain's flat end cap becomes a clean terminal. Everything here runs once at load for a static scene.

const SPHERE_WIDTH_SEGMENTS = ENVELOPE_RADIAL_SEGMENTS;
const SPHERE_HEIGHT_SEGMENTS = 12;

export type ComponentEnvelope = {
  componentId: number;
  color: string;
  geometry: THREE.BufferGeometry;
};

type CorridorEdge = { a: string; b: string; radius: number; used: boolean };

/** The shared-node graph of one connected component: node positions/flags plus one edge per polyline segment. */
type CorridorGraph = {
  position: Map<string, THREE.Vector3>;
  vertiport: Map<string, boolean>;
  edges: CorridorEdge[];
  /** node id -> indices into `edges` of every edge incident to it; its length is the node's degree. */
  adjacency: Map<string, number[]>;
};

type Chain = { nodeIds: string[]; radius: number };
type JunctionNode = { position: THREE.Vector3; radius: number };

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
  // Chain tubes carry position+normal; sphere brushes also carry uv. Restricting the evaluator to
  // position+normal keeps it from touching the uv attribute the tubes lack.
  evaluator.attributes = ["position", "normal"];

  const envelopes: ComponentEnvelope[] = [];
  componentsById.forEach((componentCorridors, componentId) => {
    const geometry = buildComponentEnvelope(componentCorridors, evaluator);
    if (geometry) {
      envelopes.push({ componentId, color: componentCorridors[0].color, geometry });
    }
  });

  return envelopes;
}

/**
 * Builds one watertight envelope geometry for a single connected component: bisector-miter tubes for the
 * degree-2 chains, plus a CSG sphere union at each junction node. Returns null if nothing was built.
 */
function buildComponentEnvelope(corridors: AirCorridor[], evaluator: Evaluator): THREE.BufferGeometry | null {
  const graph = buildCorridorGraph(corridors);

  const chainGeometries = extractChains(graph)
    .map((chain) =>
      createPolylineTubeGeometry(
        chain.nodeIds.map((nodeId) => graph.position.get(nodeId) as THREE.Vector3),
        chain.radius,
        ENVELOPE_RADIAL_SEGMENTS,
      ),
    )
    .filter((geometry): geometry is THREE.BufferGeometry => geometry !== null);

  const junctions = collectJunctionNodes(graph);

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

  const brushes: Brush[] = chainGeometries.map((geometry) => makeBrush(geometry));
  junctions.forEach((junction) => {
    brushes.push(createSphereBrush(junction.position, junction.radius));
  });
  if (brushes.length === 0) {
    return null;
  }
  return unionBrushes(brushes, evaluator);
}

/** Builds the shared-node graph for one component: node positions/flags plus one edge per polyline segment. */
function buildCorridorGraph(corridors: AirCorridor[]): CorridorGraph {
  const position = new Map<string, THREE.Vector3>();
  const vertiport = new Map<string, boolean>();
  const edges: CorridorEdge[] = [];
  const adjacency = new Map<string, number[]>();

  const addIncidentEdge = (nodeId: string, edgeIndex: number): void => {
    const incident = adjacency.get(nodeId);
    if (incident) {
      incident.push(edgeIndex);
    } else {
      adjacency.set(nodeId, [edgeIndex]);
    }
  };

  corridors.forEach((corridor) => {
    const points = corridor.points.map(toVector3);
    corridor.nodeIds.forEach((nodeId, index) => {
      if (!position.has(nodeId)) {
        position.set(nodeId, points[index]);
      }
      // A node shared across corridors is a vertiport if any corridor flags it as one (they should agree).
      vertiport.set(nodeId, (vertiport.get(nodeId) ?? false) || corridor.vertiportFlags[index]);
    });

    for (let index = 0; index < corridor.nodeIds.length - 1; index += 1) {
      const edgeIndex = edges.length;
      edges.push({
        a: corridor.nodeIds[index],
        b: corridor.nodeIds[index + 1],
        radius: corridor.envelopeRadius,
        used: false,
      });
      addIncidentEdge(corridor.nodeIds[index], edgeIndex);
      addIncidentEdge(corridor.nodeIds[index + 1], edgeIndex);
    }
  });

  return { position, vertiport, edges, adjacency };
}

/** A through node is a degree-2, non-vertiport node — the miter flows straight through it, so it never breaks a chain. */
function isThroughNode(graph: CorridorGraph, nodeId: string): boolean {
  return (graph.adjacency.get(nodeId)?.length ?? 0) === 2 && !graph.vertiport.get(nodeId);
}

/**
 * Splits the component's edges into maximal chains. Each chain runs through degree-2 nodes (stitching
 * adjacent corridors) and ends at a break node — a junction, a degree-1 terminal, or a vertiport.
 */
function extractChains(graph: CorridorGraph): Chain[] {
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
function walkChain(graph: CorridorGraph, startNodeId: string, firstEdgeIndex: number): Chain {
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

/** Junction nodes are shared by 3+ edges and are not vertiports; each gets a sphere sized to its widest incident corridor. */
function collectJunctionNodes(graph: CorridorGraph): JunctionNode[] {
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
