import * as THREE from "three";
import ManifoldModule, { type Manifold, type ManifoldToplevel } from "manifold-3d";

// Build-time boolean solid geometry (flight-envelope junction fusion, the CNS coverage shell's
// map-edge cut), backed by the Manifold WASM module. Manifold requires closed, indexed input meshes
// and guarantees a closed manifold result. Operations throw on degenerate input rather than degrade:
// each caller keeps its own fallback, so a bad solid costs one feature instead of blanking a layer.
// Results carry positions + index only — callers that light their material recompute normals.

/** The Manifold WASM module, initialized once via initCsg() during app bootstrap. */
let manifold: ManifoldToplevel | null = null;

/**
 * Loads and initializes the Manifold WASM module (~20ms plus the .wasm fetch). Must resolve before any
 * CSG-backed geometry is built; the app awaits it during bootstrap, alongside the scene-source fetches,
 * so it never sits on the critical path.
 */
export async function initCsg(): Promise<void> {
  if (manifold) {
    return;
  }
  const loaded = await ManifoldModule();
  loaded.setup();
  manifold = loaded;
}

/**
 * Boolean-unions every closed input solid into one interior-free geometry, in a single n-ary union.
 */
export function csgUnion(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return evaluate(geometries, (ManifoldSolid, solids) =>
    solids.length === 1 ? solids[0] : ManifoldSolid.union(solids),
  );
}

/** Boolean-intersects two closed solids. */
export function csgIntersect(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  return evaluate([a, b], (ManifoldSolid, solids) => ManifoldSolid.intersection(solids[0], solids[1]));
}

/** Converts the inputs to Manifold solids, applies `operate`, and converts the result back. */
function evaluate(
  geometries: THREE.BufferGeometry[],
  operate: (ManifoldSolid: ManifoldToplevel["Manifold"], solids: Manifold[]) => Manifold,
): THREE.BufferGeometry {
  if (!manifold) {
    throw new Error("initCsg() must resolve before CSG geometry is built.");
  }
  const { Manifold: ManifoldSolid, Mesh } = manifold;
  const solids: Manifold[] = [];
  try {
    geometries.forEach((geometry) => {
      const index = geometry.getIndex();
      if (!index) {
        throw new Error("CSG inputs must be indexed geometries.");
      }
      const mesh = new Mesh({
        numProp: 3,
        vertProperties: geometry.getAttribute("position").array as Float32Array,
        triVerts: new Uint32Array(index.array),
      });
      // Welds position-duplicated vertices (UV seams, pole fans) into closed topology; Manifold
      // rejects meshes that are not closed manifolds.
      mesh.merge();
      solids.push(new ManifoldSolid(mesh));
    });

    const result = operate(ManifoldSolid, solids);
    const outMesh = result.getMesh();
    if (!solids.includes(result)) {
      result.delete();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(outMesh.vertProperties, 3));
    geometry.setIndex(new THREE.BufferAttribute(outMesh.triVerts, 1));
    return geometry;
  } finally {
    // Manifold objects live in WASM memory and are never garbage-collected; free them explicitly.
    solids.forEach((solid) => solid.delete());
  }
}
