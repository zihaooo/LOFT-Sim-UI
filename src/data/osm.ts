import type { SceneData } from "../types";
import { averageOrigin, parseOsm } from "./common";
import { parseAirCorridors } from "./corridors";
import { parseRoutes } from "./routes";
import { parseBuildings, parseMapBounds, parseRoads, parseTrees } from "./map";
import { parseFlowDefinitions } from "./flows";

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
    routes: parseRoutes(corridorOsm, origin),
    buildings: parseBuildings(buildingOsm, origin),
    roads: parseRoads(buildingOsm, origin),
    trees: parseTrees(buildingOsm, origin),
    flows: parseFlowDefinitions(flowJson),
  };
}
