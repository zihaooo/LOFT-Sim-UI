import type {
  BuildingFootprint,
  ProjectionOrigin,
  RoadPath,
  SceneBounds,
  ScenePoint,
  TreePoint,
} from "../types";
import { ROAD_STYLES } from "../constant";
import { parseOsm, projectGeoPoint, type OsmNode } from "./common";

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
