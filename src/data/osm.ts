import type { SceneData } from "../types";
import { averageOrigin, parseOsm } from "./common";
import { parseAirCorridors } from "./corridors";
import { parseRoutes } from "./routes";
import { computeSceneBounds, parseBuildings, parseRoads, parseTrees } from "./map";
import { parseVertiports } from "./vertiport";
import { parseContingencySites } from "./contingencySite";
import { parseCnsSites } from "./cnsSite";
import { parseFlowDefinitions } from "./flows";

/**
 * Loads every dataset under one shared projection origin so all geometry aligns in scene space.
 * Each OSM text is parsed exactly once here and the result shared by every extractor — re-parsing
 * the building map (13 MB+) was the dominant page-load cost.
 */
export function createSceneData(corridorOsm: string, buildingOsm: string, flowJson = ""): SceneData {
  const corridor = parseOsm(corridorOsm);
  const corridorNodes = Array.from(corridor.nodes.values());
  if (corridorNodes.length === 0) {
    throw new Error("The airspace network has no nodes; cannot render the scene.");
  }

  const building = parseOsm(buildingOsm);
  // The origin comes from the network's nodes alone, so scene coordinates are
  // independent of whichever background-map variant the backend serves.
  const origin = averageOrigin(corridorNodes);
  const sceneBounds = computeSceneBounds(corridorNodes, origin);

  return {
    origin,
    sceneBounds,
    corridors: parseAirCorridors(corridor, origin),
    routes: parseRoutes(corridor, origin),
    buildings: parseBuildings(building, origin),
    roads: parseRoads(building, origin),
    trees: parseTrees(building, origin),
    vertiports: parseVertiports(corridor, origin),
    contingencySites: parseContingencySites(corridor, origin),
    sites: parseCnsSites(corridor, origin),
    flows: parseFlowDefinitions(flowJson),
  };
}
