import type { ProjectionOrigin, VertiportPoint } from "../types";
import { projectGeoPoint, type ParsedOsm } from "./common";
import { isVertiportNode } from "./corridors";

/**
 * Extracts every vertiport terminal from the corridor OSM. Vertiports are nodes tagged
 * `node_type=vertiport` (the same flow start/end terminals that break corridor connectivity); each
 * yields one ground marker positioned at its projected coordinate. Nodes are deduped by the parser,
 * so a vertiport referenced by several corridor ways still produces a single marker.
 */
export function parseVertiports(osm: ParsedOsm, origin: ProjectionOrigin): VertiportPoint[] {
  const { nodes } = osm;

  return Array.from(nodes.values())
    .filter(isVertiportNode)
    .map((node) => {
      // `node_id` is the schema's stable node id (e.g. "mair"); fall back to the OSM id when absent.
      const nodeId = node.tags.get("node_id") ?? node.id;

      return {
        id: nodeId,
        name: nodeId,
        position: projectGeoPoint(node, origin),
      };
    });
}
