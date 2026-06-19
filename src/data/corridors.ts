import type { AirCorridor, ProjectionOrigin, ScenePoint } from "../types";
import { CORRIDOR_COLORS } from "../constant";
import { averageOrigin, parseOsm, projectGeoPoint, type OsmNode } from "./common";

/** Extracts air-corridor ways: every airspace=yes polyline way in the network is a corridor. */
export function parseAirCorridors(osmText: string, origin?: ProjectionOrigin): AirCorridor[] {
  const { nodes, ways } = parseOsm(osmText);
  const corridorOrigin = origin ?? averageOrigin(Array.from(nodes.values()));
  const corridorWays = ways.filter((way) => way.tags.get("airspace") === "yes" && way.nodeRefs.length >= 2);

  // Resolve each way to the OSM nodes that actually exist, dropping ways too short to draw. The
  // surviving node list is the single source of truth for points, ids, and vertiport flags below,
  // so all three stay index-aligned.
  const survivingWays = corridorWays
    .map((way) => ({
      way,
      wayNodes: way.nodeRefs
        .map((ref) => nodes.get(ref))
        .filter((node): node is OsmNode => Boolean(node)),
    }))
    .filter(({ wayNodes }) => wayNodes.length >= 2);

  const componentIds = assignCorridorComponents(survivingWays.map(({ wayNodes }) => wayNodes));

  return survivingWays.map(({ way, wayNodes }, corridorIndex) => {
    const geoPoints = wayNodes.map(({ lat, lon, altitude }) => ({ lat, lon, altitude }));
    const points = geoPoints.map((point) => projectGeoPoint(point, corridorOrigin));
    const corridorMetrics = measurePolyline(points);
    const from = way.tags.get("from") ?? "";
    const to = way.tags.get("to") ?? "";
    const componentId = componentIds[corridorIndex];

    return {
      id: way.id,
      name: `${from || "Corridor"}${to ? ` to ${to}` : ""}`,
      from,
      to,
      color: CORRIDOR_COLORS[componentId % CORRIDOR_COLORS.length],
      envelopeRadius: 35,
      componentId,
      points,
      geoPoints,
      nodeIds: wayNodes.map((node) => node.id),
      vertiportFlags: wayNodes.map((node) => isVertiportNode(node)),
      ...corridorMetrics,
    };
  });
}

/**
 * Groups corridor ways into connected components via union-find. Two ways are connected when they
 * share any node (endpoint or mid-way T-junction) whose node_type is NOT a vertiport — vertiports are
 * hard terminals where a flow starts/ends, so corridors meeting there are kept separate. Returns one
 * component id per input way, numbered in first-seen order so component 0 maps to the first color.
 */
function assignCorridorComponents(wayNodeLists: OsmNode[][]): number[] {
  const parent = wayNodeLists.map((_, index) => index);

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };

  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
  };

  // node id -> set of way indices touching it (deduped so a node repeated within one way counts once).
  const waysByNode = new Map<string, Set<number>>();
  wayNodeLists.forEach((wayNodes, wayIndex) => {
    wayNodes.forEach((node) => {
      let touching = waysByNode.get(node.id);
      if (!touching) {
        touching = new Set<number>();
        waysByNode.set(node.id, touching);
      }
      touching.add(wayIndex);
    });
  });

  for (const wayNodes of wayNodeLists) {
    for (const node of wayNodes) {
      if (isVertiportNode(node)) {
        continue;
      }
      const touching = waysByNode.get(node.id);
      if (!touching || touching.size < 2) {
        continue;
      }
      const [first, ...rest] = touching;
      rest.forEach((wayIndex) => union(first, wayIndex));
    }
  }

  const rootToComponent = new Map<number, number>();
  return wayNodeLists.map((_, wayIndex) => {
    const root = find(wayIndex);
    let component = rootToComponent.get(root);
    if (component === undefined) {
      component = rootToComponent.size;
      rootToComponent.set(root, component);
    }
    return component;
  });
}

/** A node terminates corridor connectivity when it is an explicit vertiport (a flow start/end point). */
export function isVertiportNode(node: OsmNode): boolean {
  return node.tags.get("node_type") === "vertiport";
}

/** Pre-computes per-segment and cumulative arc-length so corridor sampling can binary-walk to a distance. */
export function measurePolyline(points: ScenePoint[]): {
  length: number;
  segmentLengths: number[];
  cumulativeLengths: number[];
} {
  const segmentLengths: number[] = [];
  const cumulativeLengths = [0];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const length = distanceBetween(previous, current);
    segmentLengths.push(length);
    cumulativeLengths.push(cumulativeLengths[index - 1] + length);
  }

  return {
    length: cumulativeLengths[cumulativeLengths.length - 1] ?? 0,
    segmentLengths,
    cumulativeLengths,
  };
}

/** 3D Euclidean distance between two scene points. */
function distanceBetween(a: ScenePoint, b: ScenePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
