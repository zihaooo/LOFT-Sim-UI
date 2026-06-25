import type { ProjectionOrigin, VertiportPoint } from "../types";
import { parseOsm, projectGeoPoint } from "./common";
import { isVertiportNode } from "./corridors";

/**
 * Extracts every vertiport terminal from the corridor OSM. Vertiports are nodes tagged
 * `node_type=vertiport` (the same flow start/end terminals that break corridor connectivity); each
 * yields one ground marker positioned at its projected coordinate. Nodes are deduped by the parser,
 * so a vertiport referenced by several corridor ways still produces a single marker.
 */
export function parseVertiports(osmText: string, origin: ProjectionOrigin): VertiportPoint[] {
  const { nodes } = parseOsm(osmText);

  return Array.from(nodes.values())
    .filter(isVertiportNode)
    .map((node) => {
      const objectId = node.tags.get("object_id");

      return {
        id: objectId ?? node.id,
        name: node.tags.get("name") ?? objectId ?? node.id,
        position: projectGeoPoint(node, origin),
      };
    });
}
