import type {
  AirCorridor,
  BuildingFootprint,
  FlowDefinition,
  GeoPoint,
  ProjectionOrigin,
  RoadPath,
  SceneBounds,
  SceneData,
  ScenePoint,
  TreePoint,
} from "../types";
import { METERS_PER_DEGREE_LAT, ROAD_STYLES, CORRIDOR_COLORS } from "../constant";

type OsmNode = GeoPoint & {
  id: string;
  tags: Map<string, string>;
};

type OsmWay = {
  id: string;
  nodeRefs: string[];
  tags: Map<string, string>;
};

/** Parses the demand JSON file into FlowDefinition records, coercing snake_case keys to the internal shape. */
export function parseFlowDefinitions(rawJson?: string): FlowDefinition[] {
  const trimmed = rawJson?.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as unknown;
  const raw = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];

  return raw.map((flow) => ({
    flowId: String(flow.flow_id ?? ""),
    corridorId: String(flow.air_corridor_id ?? ""),
    uavPerHour: Number(flow.uav_per_hour ?? 0),
  }));
}

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
function isVertiportNode(node: OsmNode): boolean {
  return node.tags.get("node_type") === "vertiport";
}

/** Extracts building (or building:part) ways as planar footprints, dropping any with fewer than 3 vertices. */
export function parseBuildings(osmText: string, origin: ProjectionOrigin): BuildingFootprint[] {
  const { nodes, ways } = parseOsm(osmText);

  return ways
    .filter((way) => way.tags.has("building") || way.tags.has("building:part"))
    .map((way) => {
      const closedRefs = removeClosingRef(way.nodeRefs);
      const points = closedRefs
        .map((ref) => nodes.get(ref))
        .filter((node): node is OsmNode => Boolean(node))
        .map((node) => projectGeoPoint(node, origin));

      return {
        id: way.id,
        points,
        height: resolveBuildingHeight(way.tags, way.id),
      };
    })
    .filter((building) => building.points.length >= 3);
}

/** Extracts highway ways whose class is in ROAD_STYLES, projecting their points and resolving width/color. */
export function parseRoads(osmText: string, origin: ProjectionOrigin): RoadPath[] {
  const { nodes, ways } = parseOsm(osmText);

  return ways
    .map((way) => {
      const kind = way.tags.get("highway") ?? "";
      const style = ROAD_STYLES[kind];
      if (!style) {
        return null;
      }

      const points = way.nodeRefs
        .map((ref) => nodes.get(ref))
        .filter((node): node is OsmNode => Boolean(node))
        .map((node) => projectGeoPoint(node, origin));

      if (points.length < 2) {
        return null;
      }

      return {
        id: way.id,
        kind,
        points,
        width: resolveRoadWidth(way.tags, style.width),
        color: style.color,
      };
    })
    .filter((road): road is RoadPath => Boolean(road));
}

/** Extracts nodes tagged natural=tree, deriving canopy radius and trunk height from tags or a stable hash. */
export function parseTrees(osmText: string, origin: ProjectionOrigin): TreePoint[] {
  const { nodes } = parseOsm(osmText);

  return Array.from(nodes.values())
    .filter((node) => node.tags.get("natural") === "tree")
    .map((node) => {
      const size = resolveTreeSize(node.tags, node.id);

      return {
        id: node.id,
        position: projectGeoPoint(node, origin),
        radius: size.radius,
        height: size.height,
      };
    });
}

/** Computes the axis-aligned scene bounds covering all OSM nodes in the file under the given projection origin. */
export function parseMapBounds(osmText: string, origin: ProjectionOrigin): SceneBounds {
  const { nodes } = parseOsm(osmText);
  return createSceneBounds(Array.from(nodes.values()).map((node) => projectGeoPoint(node, origin)));
}

/** Loads every dataset under one shared projection origin so all geometry aligns in scene space. */
export function createSceneData(corridorOsm: string, buildingOsm: string, flowJson = ""): SceneData {
  const corridorNodes = Array.from(parseOsm(corridorOsm).nodes.values());
  const buildingNodes = Array.from(parseOsm(buildingOsm).nodes.values());
  const origin = averageOrigin([...corridorNodes, ...buildingNodes]);
  const mapBounds = parseMapBounds(buildingOsm, origin);

  return {
    origin,
    mapBounds,
    corridors: parseAirCorridors(corridorOsm, origin),
    buildings: parseBuildings(buildingOsm, origin),
    roads: parseRoads(buildingOsm, origin),
    trees: parseTrees(buildingOsm, origin),
    flows: parseFlowDefinitions(flowJson),
  };
}

/** Flat-earth projection of lat/lon to local meters around `origin`; accurate for city-scale extents. */
export function projectGeoPoint(point: GeoPoint, origin: ProjectionOrigin): ScenePoint {
  const latRadians = (origin.lat * Math.PI) / 180;
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos(latRadians);

  return {
    x: (point.lat - origin.lat) * METERS_PER_DEGREE_LAT,
    y: point.altitude,
    z: (point.lon - origin.lon) * metersPerDegreeLon,
  };
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

/** Lightweight regex-based scraper that pulls nodes and ways out of OSM XML without a full DOM parse. */
function parseOsm(osmText: string): { nodes: Map<string, OsmNode>; ways: OsmWay[] } {
  const nodes = new Map<string, OsmNode>();

  for (const nodeMatch of osmText.matchAll(/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    const attributes = readAttributes(nodeMatch[1]);
    const id = attributes.get("id");
    const lat = Number(attributes.get("lat"));
    const lon = Number(attributes.get("lon"));

    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }

    const tags = readTagsFromBlock(nodeMatch[2] ?? "");
    nodes.set(id, {
      id,
      lat,
      lon,
      altitude: Number(tags.get("altitude") ?? 0),
      tags,
    });
  }

  const ways: OsmWay[] = [];

  for (const wayMatch of osmText.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
    const attributes = readAttributes(wayMatch[1]);
    const body = wayMatch[2] ?? "";
    const nodeRefs = Array.from(body.matchAll(/<nd\b([^>]*?)\/?>/g))
      .map((ndMatch) => readAttributes(ndMatch[1]).get("ref") ?? "")
      .filter(Boolean);

    ways.push({
      id: attributes.get("id") ?? "",
      nodeRefs,
      tags: readTagsFromBlock(body),
    });
  }

  return { nodes, ways };
}

/** Pulls `<tag k= v= />` pairs out of a node/way body block. */
function readTagsFromBlock(block: string): Map<string, string> {
  const tags = new Map<string, string>();

  for (const tagMatch of block.matchAll(/<tag\b([^>]*?)\/?>/g)) {
    const attributes = readAttributes(tagMatch[1]);
    const key = attributes.get("k");
    const value = attributes.get("v");
    if (key && value !== undefined) {
      tags.set(key, value);
    }
  }

  return tags;
}

/** Parses `name="value"` / `name='value'` attribute pairs out of an XML tag's attribute string. */
function readAttributes(rawAttributes: string): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const attributeMatch of rawAttributes.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes.set(attributeMatch[1], decodeXml(attributeMatch[2] ?? attributeMatch[3] ?? ""));
  }

  return attributes;
}

/** Unescapes the five standard XML entities so attribute values match their source text. */
function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Averages lat/lon to pick a projection origin centered on the dataset, minimizing flat-earth distortion. */
function averageOrigin(points: GeoPoint[]): ProjectionOrigin {
  if (points.length === 0) {
    return { lat: 0, lon: 0 };
  }

  const totals = points.reduce(
    (accumulator, point) => ({
      lat: accumulator.lat + point.lat,
      lon: accumulator.lon + point.lon,
    }),
    { lat: 0, lon: 0 },
  );

  return {
    lat: totals.lat / points.length,
    lon: totals.lon / points.length,
  };
}

/** Builds a SceneBounds from projected x/z extrema, with a unit-square fallback when the input is empty. */
function createSceneBounds(points: ScenePoint[]): SceneBounds {
  if (points.length === 0) {
    return {
      min: { x: -0.5, y: 0, z: -0.5 },
      max: { x: 0.5, y: 0, z: 0.5 },
      width: 1,
      depth: 1,
    };
  }

  const min = { x: Infinity, y: 0, z: Infinity };
  const max = { x: -Infinity, y: 0, z: -Infinity };

  points.forEach((point) => {
    min.x = Math.min(min.x, point.x);
    min.z = Math.min(min.z, point.z);
    max.x = Math.max(max.x, point.x);
    max.z = Math.max(max.z, point.z);
  });

  return {
    min,
    max,
    width: max.x - min.x,
    depth: max.z - min.z,
  };
}

/** Drops the duplicated trailing node ref OSM uses to mark closed polygons (first === last). */
function removeClosingRef(refs: string[]): string[] {
  if (refs.length > 1 && refs[0] === refs[refs.length - 1]) {
    return refs.slice(0, -1);
  }

  return refs;
}

/** Resolves a building's height: explicit `height` tag → `building:levels` × 3.2m → deterministic per-id fallback. */
function resolveBuildingHeight(tags: Map<string, string>, id: string): number {
  const explicitHeight = parseOsmHeight(tags.get("height"));
  if (explicitHeight > 0) {
    return explicitHeight;
  }

  const levels = Number(tags.get("building:levels"));
  if (Number.isFinite(levels) && levels > 0) {
    return levels * 3.2;
  }

  return 8 + (stableHash(id) % 7) * 3.5;
}

/** Resolves a road's width: explicit `width` tag → `lanes` × 3.2m → highway-class fallback. */
function resolveRoadWidth(tags: Map<string, string>, fallback: number): number {
  const explicitWidth = parseOsmHeight(tags.get("width"));
  if (explicitWidth > 0) {
    return explicitWidth;
  }

  const lanes = Number(tags.get("lanes"));
  if (Number.isFinite(lanes) && lanes > 0) {
    return lanes * 3.2;
  }

  return fallback;
}

/** Picks a tree's canopy radius and total height from tags when present, else stable per-id randomness for visual variety. */
function resolveTreeSize(tags: Map<string, string>, id: string): { radius: number; height: number } {
  const hash = stableHash(id);
  const explicitHeight = parseOsmHeight(tags.get("height"));
  const explicitCrownDiameter = parseOsmHeight(tags.get("diameter_crown") ?? tags.get("crown_diameter"));

  return {
    radius: explicitCrownDiameter > 0 ? explicitCrownDiameter / 2 : 1.7 + (hash % 5) * 0.25,
    height: explicitHeight > 0 ? explicitHeight : 7 + ((hash >>> 3) % 7) * 0.9,
  };
}

/** Parses OSM dimension strings (meters with optional `m`, or imperial like `5'10"`) into meters. */
function parseOsmHeight(height?: string): number {
  if (!height) {
    return 0;
  }

  const normalized = height.trim().toLowerCase();
  const feetMatch = normalized.match(/^([0-9.]+)\s*'\s*([0-9.]*)/);
  if (feetMatch) {
    const feet = Number(feetMatch[1]);
    const inches = Number(feetMatch[2] || 0);
    return (feet + inches / 12) * 0.3048;
  }

  const meters = Number(normalized.replace(/m$/, "").trim());
  return Number.isFinite(meters) ? meters : 0;
}

/** Deterministic 32-bit string hash used to seed visual variation (heights, sizes) reproducibly per OSM id. */
function stableHash(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

/** 3D Euclidean distance between two scene points. */
function distanceBetween(a: ScenePoint, b: ScenePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
