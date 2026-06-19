import type { GeoPoint, ProjectionOrigin, ScenePoint } from "../types";
import { METERS_PER_DEGREE_LAT } from "../constant";

export type OsmNode = GeoPoint & {
  id: string;
  tags: Map<string, string>;
};

export type OsmWay = {
  id: string;
  nodeRefs: string[];
  tags: Map<string, string>;
};

export type OsmRelationMember = {
  type: string;
  ref: string;
  role: string;
};

export type OsmRelation = {
  id: string;
  members: OsmRelationMember[];
  tags: Map<string, string>;
};

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

/** Lightweight regex-based scraper that pulls nodes, ways, and relations out of OSM XML without a full DOM parse. */
export function parseOsm(osmText: string): {
  nodes: Map<string, OsmNode>;
  ways: OsmWay[];
  relations: OsmRelation[];
} {
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

  const relations: OsmRelation[] = [];

  for (const relationMatch of osmText.matchAll(/<relation\b([^>]*)>([\s\S]*?)<\/relation>/g)) {
    const attributes = readAttributes(relationMatch[1]);
    const body = relationMatch[2] ?? "";
    const members = Array.from(body.matchAll(/<member\b([^>]*?)\/?>/g)).map((memberMatch) => {
      const memberAttributes = readAttributes(memberMatch[1]);
      return {
        type: memberAttributes.get("type") ?? "",
        ref: memberAttributes.get("ref") ?? "",
        role: memberAttributes.get("role") ?? "",
      };
    });

    relations.push({
      id: attributes.get("id") ?? "",
      members,
      tags: readTagsFromBlock(body),
    });
  }

  return { nodes, ways, relations };
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
export function averageOrigin(points: GeoPoint[]): ProjectionOrigin {
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
