import type { ContingencySite, ProjectionOrigin } from "../types";
import { projectGeoPoint, type ParsedOsm } from "./common";

/**
 * Extracts every contingency landing site from the corridor OSM. Sites are nodes tagged
 * `node_type=cont_site`; they are optional — most networks carry none — and are referenced by no way,
 * so they never affect corridor connectivity. Sim-side tags such as `max_landing_rate_per_hour` and
 * `vehicle_access` are ignored by the UI (like a vertiport's `pad_counts`).
 */
export function parseContingencySites(osm: ParsedOsm, origin: ProjectionOrigin): ContingencySite[] {
  const { nodes } = osm;

  return Array.from(nodes.values())
    .filter((node) => node.tags.get("node_type") === "cont_site")
    .map((node) => {
      // `node_id` is a display label only — the network schema reuses values across node types (a
      // cont_site "n0" coexists with a waypoint "n0") — so anything keyed must use the OSM element id.
      const nodeId = node.tags.get("node_id") ?? node.id;
      const { x, z } = projectGeoPoint(node, origin);

      return {
        id: nodeId,
        name: nodeId,
        // The `altitude` tag is the site's ground elevation (sim-side data); the marker is a ground
        // decal like a vertiport's, so it sits on the scene's ground plane regardless.
        position: { x, y: 0, z },
      };
    });
}
