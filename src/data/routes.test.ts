import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { parseRoutes } from "./routes";
import { parseOsm } from "./common";
import { createRouteGroup } from "../layer/corridor";

const origin = { lat: 42.0, lon: -83.0 };
const root = resolve(__dirname, "../..");
const airCorridorOsm = readFileSync(resolve(root, "public/data/network/airspace_network.osm"), "utf8");

// Two airspace ways that meet at node 3; a relation chains them into one route in member order.
const routeOsm = `
<osm>
  <node id="1" lat="42.0000" lon="-83.0000"/>
  <node id="2" lat="42.0010" lon="-83.0000"/>
  <node id="3" lat="42.0020" lon="-83.0000"/>
  <node id="4" lat="42.0020" lon="-83.0010"/>
  <way id="100"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="airspace" v="yes"/></way>
  <way id="101"><nd ref="3"/><nd ref="4"/><tag k="airspace" v="yes"/></way>
  <relation id="900">
    <member type="way" ref="100" role=""/>
    <member type="way" ref="101" role=""/>
    <tag k="object_type" v="route"/>
    <tag k="name" v="Test Route"/>
  </relation>
</osm>
`;

describe("parseRoutes", () => {
  it("merges a relation's member ways into one route, deduping the shared seam node", () => {
    const routes = parseRoutes(routeOsm, origin);

    expect(routes).toHaveLength(1);
    const [route] = routes;
    expect(route.id).toBe("900");
    expect(route.name).toBe("Test Route");
    // Node 3 is shared by both ways but appears once: 1, 2, 3, 4.
    expect(route.nodeIds).toEqual(["1", "2", "3", "4"]);
    expect(route.points).toHaveLength(4);
    expect(route.length).toBeGreaterThan(0);
  });

  it("ignores relations that are not tagged object_type=route", () => {
    const withoutRoute = routeOsm.replace('<tag k="object_type" v="route"/>', '<tag k="object_type" v="zone"/>');
    expect(parseRoutes(withoutRoute, origin)).toEqual([]);
  });

  it("assigns each route its own component id", () => {
    const twoRoutes = routeOsm.replace(
      "</osm>",
      `<relation id="901">
        <member type="way" ref="101" role=""/>
        <tag k="object_type" v="route"/>
      </relation>
    </osm>`,
    );

    const componentIds = parseRoutes(twoRoutes, origin).map((route) => route.componentId);
    expect(new Set(componentIds).size).toBe(componentIds.length);
  });

  it("parses every route relation in the provided air corridor file", () => {
    const routes = parseRoutes(airCorridorOsm, origin);

    expect(routes).toHaveLength(6);
    expect(routes.map((route) => route.id)).toEqual(
      expect.arrayContaining(["route1", "route2", "route3", "route4", "route_priority_1", "route_priority_2"]),
    );
    routes.forEach((route) => {
      expect(route.points.length).toBeGreaterThanOrEqual(2);
      expect(route.length).toBeGreaterThan(0);
    });
    // Each route is its own component.
    const componentIds = routes.map((route) => route.componentId);
    expect(new Set(componentIds).size).toBe(routes.length);
  });

  // Topology check: under the "member order is correct, no flipping" assumption, each member way must
  // start where the previous one ended. A reversed or disconnected way would render as a kink — this
  // catches it without rendering anything.
  it("builds every route from contiguous head-to-tail member ways", () => {
    const { ways, relations } = parseOsm(airCorridorOsm);
    const wayById = new Map(ways.map((way) => [way.id, way]));
    const routeRelations = relations.filter((relation) => relation.tags.get("object_type") === "route");

    const discontinuities = routeRelations.flatMap((relation) => {
      const memberWays = relation.members
        .filter((member) => member.type === "way")
        .map((member) => wayById.get(member.ref))
        .filter((way): way is NonNullable<typeof way> => Boolean(way));
      const objectId = relation.tags.get("object_id") ?? relation.id;

      const problems: string[] = [];
      for (let index = 1; index < memberWays.length; index += 1) {
        const previous = memberWays[index - 1].nodeRefs;
        const current = memberWays[index].nodeRefs;
        const previousTail = previous[previous.length - 1];
        if (current[0] !== previousTail) {
          const reversed = current[current.length - 1] === previousTail;
          problems.push(`${objectId} seam #${index}: ${reversed ? "member way is reversed" : "ways share no endpoint"}`);
        }
      }
      return problems;
    });

    expect(discontinuities).toEqual([]);
  });

  // Geometry check: build the actual render objects headlessly and assert each route produced a
  // non-empty centerline + envelope, grouped under its own toggleable, correctly-named subgroup.
  it("createRouteGroup yields one named, non-empty subgroup per route", () => {
    // buildCorridorLines reads window.innerWidth to size fat-line strokes; stub it for this headless build.
    vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 720 });
    try {
      const routes = parseRoutes(airCorridorOsm, origin);
      const group = createRouteGroup(routes);

      expect(group.children).toHaveLength(routes.length);
      routes.forEach((route, index) => {
        const subgroup = group.children[index];
        expect(subgroup.name).toBe(`route:${route.id}`);

        let vertexCount = 0;
        subgroup.traverse((object) => {
          const geometry = (object as Partial<{ geometry: THREE.BufferGeometry }>).geometry;
          vertexCount += geometry?.getAttribute("position")?.count ?? 0;
        });
        expect(vertexCount).toBeGreaterThan(0);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
