import type { SceneData } from "../types";
import { averageOrigin, parseOsm } from "./common";
import { parseAirCorridors } from "./corridors";
import { parseRoutes } from "./routes";
import { computeSceneBounds, parseBuildings, parseRoads, parseTrees } from "./map";
import { parseVertiports } from "./vertiport";
import { parseFlowDefinitions } from "./flows";

/** Loads every dataset under one shared projection origin so all geometry aligns in scene space. */
export function createSceneData(corridorOsm: string, buildingOsm: string, flowJson = ""): SceneData {
  const corridorNodes = Array.from(parseOsm(corridorOsm).nodes.values());
  if (corridorNodes.length === 0) {
    throw new Error("The airspace network has no nodes; cannot render the scene.");
  }

  const buildingNodes = Array.from(parseOsm(buildingOsm).nodes.values());
  const origin = averageOrigin([...corridorNodes, ...buildingNodes]);
  const sceneBounds = computeSceneBounds(corridorNodes, origin);

  return {
    origin,
    sceneBounds,
    corridors: parseAirCorridors(corridorOsm, origin),
    routes: parseRoutes(corridorOsm, origin),
    buildings: parseBuildings(buildingOsm, origin),
    roads: parseRoads(buildingOsm, origin),
    trees: parseTrees(buildingOsm, origin),
    vertiports: parseVertiports(corridorOsm, origin),
    flows: parseFlowDefinitions(flowJson),
  };
}
