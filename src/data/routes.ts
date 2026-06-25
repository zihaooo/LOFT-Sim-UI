import type { AirRoute, ProjectionOrigin } from "../types";
import { ROUTE_COLORS, ENVELOPE_RADIUS_METERS } from "../constant";
import { averageOrigin, parseOsm, projectGeoPoint, type OsmNode, type OsmWay } from "./common";
import { isVertiportNode, measurePolyline } from "./corridors";

const ROUTE_OBJECT_TYPE = "route";

/**
 * Extracts routes: relations tagged `object_type=route`, whose member ways are stitched (in member
 * order) into one continuous polyline and returned as a corridor-shaped path. Each route is its own
 * component, so its envelope is built and colored independently of every other route and corridor.
 */
export function parseRoutes(osmText: string, origin?: ProjectionOrigin): AirRoute[] {
  const { nodes, ways, relations } = parseOsm(osmText);
  const wayById = new Map(ways.map((way) => [way.id, way]));
  const routeOrigin = origin ?? averageOrigin(Array.from(nodes.values()));

  const routeRelations = relations.filter((relation) => relation.tags.get("object_type") === ROUTE_OBJECT_TYPE);

  return routeRelations
    .map((relation, routeIndex): AirRoute | null => {
      const memberWays = relation.members
        .filter((member) => member.type === "way")
        .map((member) => wayById.get(member.ref))
        .filter((way): way is OsmWay => Boolean(way));

      const wayNodes = mergeWayNodeRefs(memberWays)
        .map((ref) => nodes.get(ref))
        .filter((node): node is OsmNode => Boolean(node));

      if (wayNodes.length < 2) {
        return null;
      }

      const geoPoints = wayNodes.map(({ lat, lon, altitude }) => ({ lat, lon, altitude }));
      const points = geoPoints.map((point) => projectGeoPoint(point, routeOrigin));

      // Prefer the simulator's stable `object_id` (e.g. "route1") over the OSM-native relation id so the
      // route id matches the ids telemetry and the demand flows reference; fall back when the tag is absent.
      const objectId = relation.tags.get("object_id");

      return {
        id: objectId ?? relation.id,
        name: relation.tags.get("name") ?? objectId ?? `Route ${relation.id}`,
        from: relation.tags.get("from") ?? "",
        to: relation.tags.get("to") ?? "",
        color: ROUTE_COLORS[routeIndex % ROUTE_COLORS.length],
        envelopeRadius: ENVELOPE_RADIUS_METERS,
        // Each route is its own component so its envelope never fuses with another route's or a corridor's.
        componentId: routeIndex,
        points,
        geoPoints,
        nodeIds: wayNodes.map((node) => node.id),
        vertiportFlags: wayNodes.map((node) => isVertiportNode(node)),
        ...measurePolyline(points),
      };
    })
    .filter((route): route is AirRoute => route !== null);
}

/**
 * Concatenates member ways' node refs in relation order (assuming members are already correctly
 * ordered and oriented), dropping the duplicated shared node where one way ends and the next begins
 * so the seam does not produce a zero-length segment.
 */
function mergeWayNodeRefs(ways: OsmWay[]): string[] {
  const merged: string[] = [];

  for (const way of ways) {
    let refs = way.nodeRefs;
    if (merged.length > 0 && refs.length > 0 && merged[merged.length - 1] === refs[0]) {
      refs = refs.slice(1);
    }
    merged.push(...refs);
  }

  return merged;
}
