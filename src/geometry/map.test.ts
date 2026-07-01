import { describe, expect, it } from "vitest";
import { initialGridSpacingIndex } from "./map";
import { GRID_SPACING_TICKS } from "../constant";
import type { SceneBounds } from "../types";

function boundsOf(width: number, depth: number): SceneBounds {
  return { min: { x: 0, y: 0, z: 0 }, max: { x: width, y: 0, z: depth }, width, depth };
}

describe("initialGridSpacingIndex", () => {
  it("picks the tick spacing nearest to longestDimension / 15", () => {
    expect(GRID_SPACING_TICKS[initialGridSpacingIndex(boundsOf(3_000, 1_000))]).toBe(200);
    expect(GRID_SPACING_TICKS[initialGridSpacingIndex(boundsOf(7_500, 1_000))]).toBe(500);
    expect(GRID_SPACING_TICKS[initialGridSpacingIndex(boundsOf(30_000, 1_000))]).toBe(2_000);
  });

  it("keys off the longer of width and depth", () => {
    expect(initialGridSpacingIndex(boundsOf(1_000, 7_500))).toBe(initialGridSpacingIndex(boundsOf(7_500, 1_000)));
  });

  it("clamps to the smallest tick for tiny scenes", () => {
    expect(initialGridSpacingIndex(boundsOf(750, 500))).toBe(0);
    expect(GRID_SPACING_TICKS[initialGridSpacingIndex(boundsOf(750, 500))]).toBe(100);
  });

  it("clamps to the largest tick for huge scenes", () => {
    const index = initialGridSpacingIndex(boundsOf(300_000, 300_000));
    expect(index).toBe(GRID_SPACING_TICKS.length - 1);
    expect(GRID_SPACING_TICKS[index]).toBe(10_000);
  });
});
