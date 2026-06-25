import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import type { AirCorridor, ScenePoint } from "../types";
import { ENVELOPE_RADIAL_SEGMENTS } from "../constant";
import { parseAirCorridors } from "../data/corridors";
import { buildComponentEnvelopeGeometries, createSimpleTubeGeometry } from "./corridorEnvelope";

const root = resolve(__dirname, "../..");
const corridorOsm = readFileSync(resolve(root, "public/data/network/airspace_network.osm"), "utf8");

/** Builds a minimal AirCorridor; only componentId/color/points/envelopeRadius/nodeIds/vertiportFlags are read. */
function fakeCorridor(
  componentId: number,
  nodeIds: string[],
  coords: Array<[number, number, number]>,
  vertiportFlags: boolean[],
): AirCorridor {
  const points: ScenePoint[] = coords.map(([x, y, z]) => ({ x, y, z }));
  return {
    id: nodeIds.join("-"),
    name: "test",
    from: "",
    to: "",
    color: "#ffffff",
    envelopeRadius: 35,
    componentId,
    points,
    geoPoints: points.map(() => ({ lat: 0, lon: 0, altitude: 0 })),
    nodeIds,
    vertiportFlags,
    length: 0,
    segmentLengths: [],
    cumulativeLengths: [],
  };
}

/** Sum of per-triangle tetra volumes; positive iff the closed mesh is wound outward (right-hand rule). */
function signedVolume(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  const triangleCount = index ? index.count / 3 : position.count / 3;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const ia = index ? index.getX(triangle * 3) : triangle * 3;
    const ib = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
    const ic = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    volume += a.dot(b.clone().cross(c)) / 6;
  }
  return volume;
}

/** Counts undirected edges referenced by an odd number of triangles — zero means a closed manifold surface. */
function boundaryEdgeCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (!index) {
    return -1;
  }
  const edgeUse = new Map<string, number>();
  const bump = (i: number, j: number) => {
    const key = i < j ? `${i}_${j}` : `${j}_${i}`;
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
  };
  for (let triangle = 0; triangle < index.count / 3; triangle += 1) {
    const ia = index.getX(triangle * 3);
    const ib = index.getX(triangle * 3 + 1);
    const ic = index.getX(triangle * 3 + 2);
    bump(ia, ib);
    bump(ib, ic);
    bump(ic, ia);
  }
  let boundary = 0;
  edgeUse.forEach((count) => {
    if (count % 2 !== 0) {
      boundary += 1;
    }
  });
  return boundary;
}

function allFinite(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count * 3; i += 1) {
    if (!Number.isFinite((position.array as ArrayLike<number>)[i])) {
      return false;
    }
  }
  return true;
}

describe("corridor envelope decomposition (verification)", () => {
  it("a capped miter tube is a closed, outward-wound solid", () => {
    const tube = createSimpleTubeGeometry(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0), new THREE.Vector3(100, 0, 100)],
      35,
      18,
    );
    expect(tube).not.toBeNull();
    expect(boundaryEdgeCount(tube!)).toBe(0); // watertight: no open boundary edges
    expect(signedVolume(tube!)).toBeGreaterThan(0); // outward winding
  });

  it("plunges a ground terminal into a buried underground stub instead of capping at y=0", () => {
    // A single corridor descending from 100 m altitude to a degree-1 terminal sitting on the ground.
    const envelopes = buildComponentEnvelopeGeometries([
      fakeCorridor(0, ["air", "ground"], [[0, 100, 0], [0, 0, 50]], [false, false]),
    ]);
    expect(envelopes).toHaveLength(1);
    // The tube bends to vertical at the ground node and continues straight down, so its end cap is
    // buried well below y=0 (a ~2-radius stub) rather than straddling the ground plane.
    expect(envelopes[0].geometry.boundingBox!.min.y).toBeLessThan(-35);
  });

  it("leaves a mid-air terminal alone (no underground stub)", () => {
    // Both endpoints are above the ground, so neither sprouts a stub; nothing dips below y=0.
    const envelopes = buildComponentEnvelopeGeometries([
      fakeCorridor(0, ["lowAir", "highAir"], [[0, 50, 0], [100, 80, 0]], [false, false]),
    ]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].geometry.boundingBox!.min.y).toBeGreaterThan(0);
  });

  it("an uncapped tube is left open at both ends", () => {
    const tube = createSimpleTubeGeometry(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0)],
      35,
      18,
      { caps: false },
    );
    expect(boundaryEdgeCount(tube!)).toBe(2 * 18); // two open end rings
  });

  it("builds one watertight envelope per connected component without CSG fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const corridors = parseAirCorridors(corridorOsm);
    const envelopes = buildComponentEnvelopeGeometries(corridors);

    // The sample file resolves to four connected components (two with a junction, two without).
    expect(envelopes).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled(); // CSG union never fell back to overlapping merge

    envelopes.forEach((envelope) => {
      expect(envelope.geometry.getAttribute("position").count).toBeGreaterThan(0);
      expect(allFinite(envelope.geometry)).toBe(true);
      expect(envelope.geometry.boundingSphere).not.toBeNull();
      expect(envelope.geometry.boundingSphere!.radius).toBeGreaterThan(0);
    });
    warn.mockRestore();
  });

  it("the two junction-free components come out watertight", () => {
    const corridors = parseAirCorridors(corridorOsm);
    const envelopes = buildComponentEnvelopeGeometries(corridors);

    // Two of the four components have no junction, so their geometry is pure merged miter tubes and must
    // be a closed, outward-wound solid. (The CSG-unioned junction components weld duplicate vertices, so
    // they are not edge-manifold by index and are excluded by this very property.)
    const watertight = envelopes.filter(
      (envelope) => boundaryEdgeCount(envelope.geometry) === 0 && signedVolume(envelope.geometry) > 0,
    );
    expect(watertight.length).toBe(2);
  });

  it("stitches two corridors joined at a degree-2 node into one mitered tube (no CSG)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // a0 --- a1 --- J --- b1 --- b2 : J is a shared, non-vertiport degree-2 joint between two corridors.
    const envelopes = buildComponentEnvelopeGeometries([
      fakeCorridor(0, ["a0", "a1", "J"], [[0, 0, 0], [100, 0, 0], [200, 0, 0]], [true, false, false]),
      fakeCorridor(0, ["J", "b1", "b2"], [[200, 0, 0], [200, 0, 100], [200, 0, 200]], [false, false, true]),
    ]);

    expect(envelopes).toHaveLength(1);
    const geometry = envelopes[0].geometry;
    // One stitched chain of 5 distinct points, plus an underground stub point at each end (a0 and b2 are
    // vertiports resting on the ground) → 7 rings + 2 cap hubs; two unstitched tubes would not match.
    expect(geometry.getAttribute("position").count).toBe(7 * ENVELOPE_RADIAL_SEGMENTS + 2);
    expect(boundaryEdgeCount(geometry)).toBe(0); // watertight across the joint
    expect(signedVolume(geometry)).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled(); // never touched CSG
    warn.mockRestore();
  });

  it("fuses three corridors at a degree>2 non-vertiport junction with CSG", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Three corridors radiate from junction X (degree 3); p, q, r are degree-1 terminals.
    const envelopes = buildComponentEnvelopeGeometries([
      fakeCorridor(0, ["X", "p"], [[0, 0, 0], [200, 0, 0]], [false, false]),
      fakeCorridor(0, ["X", "q"], [[0, 0, 0], [0, 0, 200]], [false, false]),
      fakeCorridor(0, ["X", "r"], [[0, 0, 0], [-200, 0, 0]], [false, false]),
    ]);

    expect(envelopes).toHaveLength(1);
    const geometry = envelopes[0].geometry;
    expect(geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(allFinite(geometry)).toBe(true);
    // CSG union of three tubes + one sphere fills a box spanning all three arms.
    expect(geometry.boundingBox!.min.x).toBeLessThan(-150);
    expect(geometry.boundingBox!.max.x).toBeGreaterThan(150);
    expect(geometry.boundingBox!.max.z).toBeGreaterThan(150);
    expect(warn).not.toHaveBeenCalled(); // CSG succeeded, no fallback
    warn.mockRestore();
  });

  it("treats a degree>2 vertiport as a terminal, not a junction (no sphere, stays open-manifold)", () => {
    // X has degree 4 but is a vertiport: no sphere, no CSG — four tubes simply cap there.
    const envelopes = buildComponentEnvelopeGeometries([
      fakeCorridor(0, ["X", "p"], [[0, 0, 0], [200, 0, 0]], [true, false]),
      fakeCorridor(0, ["X", "q"], [[0, 0, 0], [0, 0, 200]], [true, false]),
      fakeCorridor(0, ["X", "r"], [[0, 0, 0], [-200, 0, 0]], [true, false]),
      fakeCorridor(0, ["X", "s"], [[0, 0, 0], [0, 0, -200]], [true, false]),
    ]);

    expect(envelopes).toHaveLength(1);
    // No junction sphere → pure merged miter tubes (indexed, watertight per tube).
    expect(envelopes[0].geometry.getIndex()).not.toBeNull();
    expect(boundaryEdgeCount(envelopes[0].geometry)).toBe(0);
  });
});
