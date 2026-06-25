import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectGeoPoint } from "./common";
import { measurePolyline, parseAirCorridors } from "./corridors";
import { parseBuildings, parseMapBounds, parseRoads, parseTrees } from "./map";
import { parseVertiports } from "./vertiport";
import { parseFlowDefinitions } from "./flows";
import { parseRoutes } from "./routes";
import { createSceneData } from "./osm";

const root = resolve(__dirname, "../..");
const twoCorridorOsmPath = "public/data/network/two_air_corridor.osm";
const defaultMapOsmPath = "public/data/network/map.osm";
const twoFlowJsonPath = "public/data/demand/two_flow.json";

describe("OSM and flow parsing", () => {
  it("parses the provided air corridors with projected 3D points", () => {
    const corridorOsm = readFileSync(resolve(root, twoCorridorOsmPath), "utf8");
    const corridors = parseAirCorridors(corridorOsm);

    expect(corridors).toHaveLength(2);
    expect(corridors[0].id).toBe("1");
    expect(corridors[0].points.length).toBeGreaterThan(10);
    expect(corridors[0].points[1].y).toBe(corridors[0].geoPoints[1].altitude);
    expect(corridors[0].points[1].y).toBeGreaterThan(0);
    expect(corridors[0].length).toBeGreaterThan(900);
    expect(corridors.every((corridor) => corridor.from && corridor.to)).toBe(true);
  });

  it("selects every airspace=yes polyline way as a corridor", () => {
    const corridorOsm = `
      <osm version="0.6">
        <node id="-1" lat="42.2900" lon="-83.7100">
          <tag k="altitude" v="30" />
        </node>
        <node id="-2" lat="42.2910" lon="-83.7100">
          <tag k="altitude" v="40" />
        </node>
        <node id="-3" lat="42.2910" lon="-83.7090">
          <tag k="altitude" v="50" />
        </node>
        <way id="-10">
          <nd ref="-1" />
          <nd ref="-2" />
          <tag k="airspace" v="yes" />
        </way>
        <way id="-11">
          <nd ref="-2" />
          <nd ref="-3" />
          <tag k="airspace" v="yes" />
        </way>
      </osm>
    `;

    const corridors = parseAirCorridors(corridorOsm);

    expect(corridors).toHaveLength(2);
    expect(corridors.map((corridor) => corridor.id)).toEqual(["-10", "-11"]);
    expect(corridors.every((corridor) => corridor.points.length === 2)).toBe(true);
    expect(corridors[0].points[0].y).toBe(30);
  });

  it("parses building footprints and resolves heights from the provided map", () => {
    const corridorOsm = readFileSync(resolve(root, twoCorridorOsmPath), "utf8");
    const mapOsm = readFileSync(resolve(root, defaultMapOsmPath), "utf8");
    const origin = parseAirCorridors(corridorOsm)[0].geoPoints[0];
    const buildings = parseBuildings(mapOsm, origin);

    expect(buildings.length).toBeGreaterThan(100);
    expect(buildings[0].points.length).toBeGreaterThanOrEqual(3);
    expect(buildings.every((building) => building.height > 0)).toBe(true);
  });

  it("parses road ways from the provided map", () => {
    const corridorOsm = readFileSync(resolve(root, twoCorridorOsmPath), "utf8");
    const mapOsm = readFileSync(resolve(root, defaultMapOsmPath), "utf8");
    const origin = parseAirCorridors(corridorOsm)[0].geoPoints[0];
    const roads = parseRoads(mapOsm, origin);

    expect(roads.length).toBeGreaterThan(100);
    expect(roads.every((road) => road.kind && road.points.length >= 2)).toBe(true);
    expect(roads.every((road) => road.width > 0 && road.color)).toBe(true);
  });

  it("parses tree nodes from the provided map", () => {
    const corridorOsm = readFileSync(resolve(root, twoCorridorOsmPath), "utf8");
    const mapOsm = readFileSync(resolve(root, defaultMapOsmPath), "utf8");
    const origin = parseAirCorridors(corridorOsm)[0].geoPoints[0];
    const trees = parseTrees(mapOsm, origin);

    expect(trees.length).toBeGreaterThan(10);
    expect(trees.every((tree) => tree.height > 0 && tree.radius > 0)).toBe(true);
  });

  it("computes the scene-space map bounds from the provided map nodes", () => {
    const corridorOsm = readFileSync(resolve(root, twoCorridorOsmPath), "utf8");
    const mapOsm = readFileSync(resolve(root, defaultMapOsmPath), "utf8");
    const origin = parseAirCorridors(corridorOsm)[0].geoPoints[0];
    const bounds = parseMapBounds(mapOsm, origin);

    expect(bounds.width).toBeGreaterThan(1_000);
    expect(bounds.depth).toBeGreaterThan(1_000);
    expect(bounds.min.x).toBeLessThan(bounds.max.x);
    expect(bounds.min.z).toBeLessThan(bounds.max.z);
  });

  it("extracts only vertiport nodes, resolving id/name and excluding plain corridor nodes", () => {
    const corridorOsm = `
      <osm version="0.6">
        <node id="-1" lat="42.2900" lon="-83.7100">
          <tag k="altitude" v="0" />
          <tag k="node_type" v="vertiport" />
          <tag k="object_id" v="vertiport1" />
        </node>
        <node id="-2" lat="42.2910" lon="-83.7100">
          <tag k="altitude" v="30" />
        </node>
        <node id="-3" lat="42.2920" lon="-83.7090">
          <tag k="altitude" v="0" />
          <tag k="node_type" v="vertiport" />
        </node>
      </osm>
    `;

    const origin = { lat: 42.291, lon: -83.71 };
    const vertiports = parseVertiports(corridorOsm, origin);

    expect(vertiports).toHaveLength(2);
    // object_id wins as both id and name; absent tags fall back to the OSM node id.
    expect(vertiports[0]).toMatchObject({ id: "vertiport1", name: "vertiport1" });
    expect(vertiports[1]).toMatchObject({ id: "-3", name: "-3" });
    expect(vertiports[0].position).toEqual(projectGeoPoint({ lat: 42.29, lon: -83.71, altitude: 0 }, origin));
  });

  it("parses the four vertiports in the provided airspace network", () => {
    const corridorOsm = readFileSync(resolve(root, "public/data/network/airspace_network.osm"), "utf8");
    const vertiports = parseVertiports(corridorOsm, parseAirCorridors(corridorOsm)[0].geoPoints[0]);

    expect(vertiports).toHaveLength(4);
    expect(vertiports.map((vertiport) => vertiport.id)).toContain("michigan_medicine");
    expect(vertiports.every((vertiport) => vertiport.id && vertiport.name)).toBe(true);
  });

  it("parses the provided flow definitions", () => {
    const flowJson = readFileSync(resolve(root, twoFlowJsonPath), "utf8");
    const flows = parseFlowDefinitions(flowJson);

    expect(flows).toHaveLength(2);
    expect(flows.map((flow) => flow.routeId)).toEqual(["-1", "-2"]);
    expect(flows.every((flow) => flow.flowId && flow.uavPerHour > 0)).toBe(true);
  });

  it("resolves every demo flow's routeId to a parsed route so the fleet is non-empty", () => {
    const corridorOsm = readFileSync(resolve(root, twoCorridorOsmPath), "utf8");
    const flowJson = readFileSync(resolve(root, twoFlowJsonPath), "utf8");
    const routeIds = new Set(parseRoutes(corridorOsm).map((route) => route.id));
    const flows = parseFlowDefinitions(flowJson);

    expect(flows.length).toBeGreaterThan(0);
    expect(flows.every((flow) => routeIds.has(flow.routeId))).toBe(true);
  });

  it("treats empty, blank, or missing flow JSON as no flows", () => {
    expect(parseFlowDefinitions("")).toEqual([]);
    expect(parseFlowDefinitions("   ")).toEqual([]);
    expect(parseFlowDefinitions()).toEqual([]);
  });

  it("builds scene data with empty flow when telemetry supplies the UAVs", () => {
    const corridorOsm = readFileSync(resolve(root, twoCorridorOsmPath), "utf8");
    const mapOsm = readFileSync(resolve(root, defaultMapOsmPath), "utf8");
    const sceneData = createSceneData(corridorOsm, mapOsm);

    expect(sceneData.flows).toEqual([]);
    expect(sceneData.corridors).toHaveLength(2);
  });

  it("builds a coherent scene data object from all provided assets", () => {
    const corridorOsm = readFileSync(resolve(root, twoCorridorOsmPath), "utf8");
    const mapOsm = readFileSync(resolve(root, defaultMapOsmPath), "utf8");
    const flowJson = readFileSync(resolve(root, twoFlowJsonPath), "utf8");
    const sceneData = createSceneData(corridorOsm, mapOsm, flowJson);

    expect(sceneData.corridors).toHaveLength(2);
    expect(sceneData.flows).toHaveLength(2);
    expect(sceneData.mapBounds.width).toBeGreaterThan(1_000);
    expect(sceneData.mapBounds.depth).toBeGreaterThan(1_000);
    expect(sceneData.buildings.length).toBeGreaterThan(100);
    expect(sceneData.roads.length).toBeGreaterThan(100);
    expect(sceneData.trees.length).toBeGreaterThan(10);
    expect(Number.isFinite(sceneData.origin.lat)).toBe(true);
    expect(Number.isFinite(sceneData.origin.lon)).toBe(true);
  });
});

describe("projection and polyline measurement", () => {
  it("keeps the projection origin at the scene center", () => {
    const projected = projectGeoPoint(
      { lat: 42.29, lon: -83.71, altitude: 80 },
      { lat: 42.29, lon: -83.71 },
    );

    expect(projected).toEqual({ x: 0, y: 80, z: 0 });
  });

  it("aligns north to +X and east to +Z", () => {
    const origin = { lat: 42.29, lon: -83.71 };
    const north = projectGeoPoint({ lat: 42.291, lon: -83.71, altitude: 0 }, origin);
    const east = projectGeoPoint({ lat: 42.29, lon: -83.709, altitude: 0 }, origin);

    expect(north.x).toBeGreaterThan(0);
    expect(Math.abs(north.z)).toBeLessThan(0.000001);
    expect(east.z).toBeGreaterThan(0);
    expect(Math.abs(east.x)).toBeLessThan(0.000001);
  });

  it("measures segment and cumulative lengths", () => {
    const metrics = measurePolyline([
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 0, z: 4 },
      { x: 3, y: 12, z: 4 },
    ]);

    expect(metrics.segmentLengths).toEqual([5, 12]);
    expect(metrics.cumulativeLengths).toEqual([0, 5, 17]);
    expect(metrics.length).toBe(17);
  });
});
