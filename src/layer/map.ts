import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BuildingFootprint, RoadPath, SceneBounds, TreePoint } from "../types";
import {
  BUILDING_COLOR,
  BUILDING_METALNESS,
  BUILDING_ROUGHNESS,
  GROUND_COLOR,
  GROUND_SEGMENTS,
  ROAD_MIN_SEGMENT_LENGTH_METERS,
  ROAD_OPACITY,
  ROAD_RENDER_Y_OFFSET_METERS,
  TREE_CANOPY_COLOR,
  TREE_CANOPY_DETAIL,
  TREE_CANOPY_HUE_BASE,
  TREE_CANOPY_HUE_STEP,
  TREE_CANOPY_HUE_VARIANTS,
  TREE_CANOPY_LIGHTNESS_BASE,
  TREE_CANOPY_LIGHTNESS_STEP,
  TREE_CANOPY_LIGHTNESS_VARIANTS,
  TREE_CANOPY_MIN_HEIGHT_RADIUS_RATIO,
  TREE_CANOPY_ROUGHNESS,
  TREE_CANOPY_SATURATION,
  TREE_TRUNK_COLOR,
  TREE_TRUNK_GEOMETRY_HEIGHT,
  TREE_TRUNK_HEIGHT_RATIO,
  TREE_TRUNK_MIN_HEIGHT_METERS,
  TREE_TRUNK_MIN_RADIUS_METERS,
  TREE_TRUNK_RADIAL_SEGMENTS,
  TREE_TRUNK_RADIUS_BOTTOM,
  TREE_TRUNK_RADIUS_RATIO,
  TREE_TRUNK_RADIUS_TOP,
  TREE_TRUNK_ROUGHNESS,
} from "../constant";
import {
  clipHorizontalPolygonToBounds,
  createBoundedGrid,
  createBuildingGeometry,
  getCachedColor,
} from "../geometry/map";

/** Builds the ground plane sized to scene bounds plus an overlaid reference grid. */
export function createGroundGroup(bounds: SceneBounds): THREE.Group {
  const group = new THREE.Group();
  const centerX = (bounds.min.x + bounds.max.x) / 2;
  const centerZ = (bounds.min.z + bounds.max.z) / 2;
  const geometry = new THREE.PlaneGeometry(bounds.width, bounds.depth, GROUND_SEGMENTS, GROUND_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: GROUND_COLOR,
    roughness: 0.9,
    metalness: 0,
  });
  const ground = new THREE.Mesh(geometry, material);
  ground.position.set(centerX, 0, centerZ);
  ground.receiveShadow = true;
  group.add(ground, createBoundedGrid(bounds));

  return group;
}

/** Merges all building footprints into one shadowed mesh for cheap rendering. */
export function createBuildingGroup(buildings: BuildingFootprint[]): THREE.Group {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  buildings.forEach((building) => {
    const geometry = createBuildingGeometry(building);
    if (geometry) {
      geometries.push(geometry);
    }
  });

  if (geometries.length === 0) {
    return group;
  }

  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());

  if (!merged) {
    return group;
  }

  const material = new THREE.MeshStandardMaterial({
    color: BUILDING_COLOR,
    roughness: BUILDING_ROUGHNESS,
    metalness: BUILDING_METALNESS,
  });
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

/** Builds road quads from polyline segments, clipped to scene bounds, into a single vertex-colored mesh. */
export function createRoadGroup(roads: RoadPath[], bounds: SceneBounds): THREE.Group {
  const group = new THREE.Group();
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const colorByValue = new Map<string, THREE.Color>();
  let vertexIndex = 0;

  roads.forEach((road) => {
    const color = getCachedColor(colorByValue, road.color);
    const halfWidth = road.width / 2;

    for (let index = 1; index < road.points.length; index += 1) {
      const start = road.points[index - 1];
      const end = road.points[index];
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const length = Math.hypot(dx, dz);

      if (length < ROAD_MIN_SEGMENT_LENGTH_METERS) {
        continue;
      }

      const offsetX = (-dz / length) * halfWidth;
      const offsetZ = (dx / length) * halfWidth;
      const y = Math.max(start.y, end.y) + ROAD_RENDER_Y_OFFSET_METERS;
      const quad = clipHorizontalPolygonToBounds(
        [
          { x: start.x + offsetX, y, z: start.z + offsetZ },
          { x: end.x + offsetX, y, z: end.z + offsetZ },
          { x: end.x - offsetX, y, z: end.z - offsetZ },
          { x: start.x - offsetX, y, z: start.z - offsetZ },
        ],
        bounds,
      );

      if (quad.length < 3) {
        continue;
      }

      quad.forEach((point) => {
        positions.push(point.x, point.y, point.z);
      });

      for (let colorIndex = 0; colorIndex < quad.length; colorIndex += 1) {
        colors.push(color.r, color.g, color.b);
      }

      for (let triangleIndex = 1; triangleIndex < quad.length - 1; triangleIndex += 1) {
        indices.push(vertexIndex, vertexIndex + triangleIndex, vertexIndex + triangleIndex + 1);
      }
      vertexIndex += quad.length;
    }
  });

  if (positions.length === 0) {
    return group;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: ROAD_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  group.add(mesh);
  return group;
}

/** Creates instanced trunk and canopy meshes per tree, sized from per-tree radius/height with hue variation. */
export function createTreeGroup(trees: TreePoint[]): THREE.Group {
  const group = new THREE.Group();
  if (trees.length === 0) {
    return group;
  }

  const trunkGeometry = new THREE.CylinderGeometry(
    TREE_TRUNK_RADIUS_TOP,
    TREE_TRUNK_RADIUS_BOTTOM,
    TREE_TRUNK_GEOMETRY_HEIGHT,
    TREE_TRUNK_RADIAL_SEGMENTS,
  );
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: TREE_TRUNK_COLOR,
    roughness: TREE_TRUNK_ROUGHNESS,
    metalness: 0,
  });
  const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trees.length);

  const canopyGeometry = new THREE.IcosahedronGeometry(1, TREE_CANOPY_DETAIL);
  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: TREE_CANOPY_COLOR,
    roughness: TREE_CANOPY_ROUGHNESS,
    metalness: 0,
  });
  const canopyMesh = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, trees.length);
  const matrix = new THREE.Matrix4();
  const identity = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  trees.forEach((tree, index) => {
    const baseY = tree.position.y;
    const trunkHeight = Math.max(tree.height * TREE_TRUNK_HEIGHT_RATIO, TREE_TRUNK_MIN_HEIGHT_METERS);
    const trunkRadius = Math.max(tree.radius * TREE_TRUNK_RADIUS_RATIO, TREE_TRUNK_MIN_RADIUS_METERS);
    const canopyHeight = Math.max(tree.height - trunkHeight, tree.radius * TREE_CANOPY_MIN_HEIGHT_RADIUS_RATIO);

    position.set(tree.position.x, baseY + trunkHeight / 2, tree.position.z);
    scale.set(trunkRadius, trunkHeight, trunkRadius);
    matrix.compose(position, identity, scale);
    trunkMesh.setMatrixAt(index, matrix);

    position.set(tree.position.x, baseY + trunkHeight + canopyHeight / 2, tree.position.z);
    scale.set(tree.radius, canopyHeight / 2, tree.radius);
    matrix.compose(position, identity, scale);
    canopyMesh.setMatrixAt(index, matrix);
    canopyMesh.setColorAt(
      index,
      color.setHSL(
        TREE_CANOPY_HUE_BASE + (index % TREE_CANOPY_HUE_VARIANTS) * TREE_CANOPY_HUE_STEP,
        TREE_CANOPY_SATURATION,
        TREE_CANOPY_LIGHTNESS_BASE + (index % TREE_CANOPY_LIGHTNESS_VARIANTS) * TREE_CANOPY_LIGHTNESS_STEP,
      ),
    );
  });

  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;
  canopyMesh.castShadow = true;
  canopyMesh.receiveShadow = true;
  if (canopyMesh.instanceColor) {
    canopyMesh.instanceColor.needsUpdate = true;
  }
  group.add(trunkMesh, canopyMesh);
  return group;
}
