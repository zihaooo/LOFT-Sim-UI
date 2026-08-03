import type { CnsSite, ProjectionOrigin } from "../types";
import { CNS_SITE_TYPES, type CnsSiteType } from "../constant";
import { parseOsm, projectGeoPoint } from "./common";

/**
 * Extracts every CNS ground station (navigation / communication / surveillance site) from the corridor
 * OSM. Sites are nodes whose `node_type` is one of CNS_SITE_TYPES; they are optional — most networks
 * carry none — and are referenced by no way, so they never affect corridor connectivity. The
 * `coverage_radius` tag (meters) sizes the coverage dome; a site whose radius is missing or not a
 * positive number still yields its ground marker, just without a dome.
 */
export function parseCnsSites(osmText: string, origin: ProjectionOrigin): CnsSite[] {
  const { nodes } = parseOsm(osmText);

  return Array.from(nodes.values())
    .filter((node) => isCnsSiteType(node.tags.get("node_type")))
    .map((node) => {
      const radius = Number(node.tags.get("coverage_radius"));
      return {
        // `node_id` is the schema's stable node id (e.g. "site_comm_ncrc"); fall back to the OSM id when absent.
        id: node.tags.get("node_id") ?? node.id,
        type: node.tags.get("node_type") as CnsSiteType,
        position: projectGeoPoint(node, origin),
        coverageRadius: Number.isFinite(radius) && radius > 0 ? radius : 0,
      };
    });
}

function isCnsSiteType(value: string | undefined): value is CnsSiteType {
  return value !== undefined && (CNS_SITE_TYPES as readonly string[]).includes(value);
}
