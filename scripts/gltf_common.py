#!/usr/bin/env python3
"""Shared geometry + glTF 2.0 serialization helpers for the low-poly UAV generators.

All models face -Z (glTF/Three.js convention) with +Y up and +X right. Geometry is
built from axis-aligned boxes with flat shading so the models stay low-poly; each box
face carries its own four vertices so normals stay crisp. Per-type generators supply a
parts table and a materials list, plus optional hooks for special primitives/materials
(e.g. a semi-transparent spinning-rotor disc).
"""

import base64
import json
import math
import struct
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

Vec3 = Tuple[float, float, float]
Box = Tuple[Vec3, Vec3]
PlacedBox = Tuple[Box, float]  # (box, rotation around +Y in degrees)
Primitive = Tuple[List[Vec3], List[Vec3], List[int]]  # positions, normals, indices
MaterialSpec = Tuple[str, List[float], float, float]  # (name, baseColorRGBA, metallic, roughness)


def make_box(mn: Vec3, mx: Vec3) -> Primitive:
    x0, y0, z0 = mn
    x1, y1, z1 = mx
    # Each face uses its own 4 vertices for flat shading. Winding is CCW
    # when viewed from outside so cross(v1-v0, v2-v0) points along the normal.
    faces = [
        ([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], (1.0, 0.0, 0.0)),
        ([(x0, y0, z1), (x0, y1, z1), (x0, y1, z0), (x0, y0, z0)], (-1.0, 0.0, 0.0)),
        ([(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)], (0.0, 1.0, 0.0)),
        ([(x0, y0, z1), (x0, y0, z0), (x1, y0, z0), (x1, y0, z1)], (0.0, -1.0, 0.0)),
        ([(x1, y0, z1), (x1, y1, z1), (x0, y1, z1), (x0, y0, z1)], (0.0, 0.0, 1.0)),
        ([(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)], (0.0, 0.0, -1.0)),
    ]
    positions: List[Vec3] = []
    normals: List[Vec3] = []
    indices: List[int] = []
    for verts, normal in faces:
        base = len(positions)
        for v in verts:
            positions.append(v)
            normals.append(normal)
        indices.extend([base + 0, base + 1, base + 2, base + 0, base + 2, base + 3])
    return positions, normals, indices


def rotate_y(v: Vec3, angle_rad: float) -> Vec3:
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)
    x, y, z = v
    return (x * cos_a + z * sin_a, y, -x * sin_a + z * cos_a)


def rotate_x(v: Vec3, angle_rad: float) -> Vec3:
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)
    x, y, z = v
    return (x, y * cos_a - z * sin_a, y * sin_a + z * cos_a)


def translate(points: List[Vec3], offset: Vec3) -> List[Vec3]:
    ox, oy, oz = offset
    return [(x + ox, y + oy, z + oz) for x, y, z in points]


def combine_boxes(items: List[PlacedBox]) -> Primitive:
    all_pos: List[Vec3] = []
    all_norm: List[Vec3] = []
    all_idx: List[int] = []
    for (mn, mx), rot_deg in items:
        positions, normals, indices = make_box(mn, mx)
        if rot_deg:
            angle = math.radians(rot_deg)
            positions = [rotate_y(p, angle) for p in positions]
            normals = [rotate_y(n, angle) for n in normals]
        offset = len(all_pos)
        all_pos.extend(positions)
        all_norm.extend(normals)
        all_idx.extend(idx + offset for idx in indices)
    return all_pos, all_norm, all_idx


def make_disc(center: Vec3, radius: float, thickness: float, segments: int) -> Primitive:
    """Thin Y-axis-aligned disc (capped cylinder) approximating a spinning prop.

    Rotate the result (e.g. rotate_x by 90 deg) for props that spin about another axis.
    """
    cx, cy, cz = center
    half = thickness / 2.0
    positions: List[Vec3] = []
    normals: List[Vec3] = []
    indices: List[int] = []

    angles = [2.0 * math.pi * i / segments for i in range(segments)]

    # Top cap (triangle fan, normal +Y).
    top_center = len(positions)
    positions.append((cx, cy + half, cz))
    normals.append((0.0, 1.0, 0.0))
    top_ring = len(positions)
    for a in angles:
        positions.append((cx + radius * math.cos(a), cy + half, cz + radius * math.sin(a)))
        normals.append((0.0, 1.0, 0.0))
    for i in range(segments):
        a = top_ring + i
        b = top_ring + ((i + 1) % segments)
        indices.extend([top_center, a, b])

    # Bottom cap (triangle fan, normal -Y, reversed winding).
    bot_center = len(positions)
    positions.append((cx, cy - half, cz))
    normals.append((0.0, -1.0, 0.0))
    bot_ring = len(positions)
    for a in angles:
        positions.append((cx + radius * math.cos(a), cy - half, cz + radius * math.sin(a)))
        normals.append((0.0, -1.0, 0.0))
    for i in range(segments):
        a = bot_ring + i
        b = bot_ring + ((i + 1) % segments)
        indices.extend([bot_center, b, a])

    # Side wall — flat-shaded per segment to keep the low-poly look.
    for i in range(segments):
        a0 = angles[i]
        a1 = angles[(i + 1) % segments]
        am = (a0 + a1) / 2.0
        nx, nz = math.cos(am), math.sin(am)
        p_b0 = (cx + radius * math.cos(a0), cy - half, cz + radius * math.sin(a0))
        p_b1 = (cx + radius * math.cos(a1), cy - half, cz + radius * math.sin(a1))
        p_t0 = (cx + radius * math.cos(a0), cy + half, cz + radius * math.sin(a0))
        p_t1 = (cx + radius * math.cos(a1), cy + half, cz + radius * math.sin(a1))
        base = len(positions)
        for v in (p_b0, p_t0, p_t1, p_b1):
            positions.append(v)
            normals.append((nx, 0.0, nz))
        indices.extend([base + 0, base + 1, base + 2, base + 0, base + 2, base + 3])

    return positions, normals, indices


def default_material(name: str, color: List[float], metallic: float, roughness: float) -> dict:
    return {
        "name": name,
        "pbrMetallicRoughness": {
            "baseColorFactor": color,
            "metallicFactor": metallic,
            "roughnessFactor": roughness,
        },
    }


def build_gltf(
    output_path: Path,
    parts: Dict[str, List[PlacedBox]],
    materials: List[MaterialSpec],
    *,
    generator_name: str,
    node_name: str,
    special_primitive: Optional[Callable[[str], Optional[Primitive]]] = None,
    special_material: Optional[Callable[[str, List[float], float, float], Optional[dict]]] = None,
) -> int:
    """Serialize one mesh (one primitive per material) to a self-contained .gltf.

    parts maps each material name to its placed boxes. special_primitive(name) may return
    a (positions, normals, indices) tuple to override the default box geometry for that
    material (return None to fall back to the parts table); special_material(name, ...) may
    likewise override the generated PBR material. Returns the total triangle count.
    """
    buf = bytearray()
    buffer_views: list = []
    accessors: list = []
    mesh_primitives: list = []
    triangle_count = 0

    def align4() -> None:
        while len(buf) % 4 != 0:
            buf.append(0)

    for material_index, (name, _color, _metallic, _roughness) in enumerate(materials):
        primitive = special_primitive(name) if special_primitive else None
        if primitive is None:
            primitive = combine_boxes(parts[name])
        positions, normals, indices = primitive
        triangle_count += len(indices) // 3

        align4()
        pos_offset = len(buf)
        for x, y, z in positions:
            buf.extend(struct.pack("<fff", x, y, z))
        pos_length = len(buf) - pos_offset
        pos_bv = len(buffer_views)
        buffer_views.append({
            "buffer": 0, "byteOffset": pos_offset,
            "byteLength": pos_length, "target": 34962,
        })
        xs = [p[0] for p in positions]
        ys = [p[1] for p in positions]
        zs = [p[2] for p in positions]
        pos_acc = len(accessors)
        accessors.append({
            "bufferView": pos_bv, "componentType": 5126,
            "count": len(positions), "type": "VEC3",
            "min": [min(xs), min(ys), min(zs)],
            "max": [max(xs), max(ys), max(zs)],
        })

        align4()
        nrm_offset = len(buf)
        for x, y, z in normals:
            buf.extend(struct.pack("<fff", x, y, z))
        nrm_length = len(buf) - nrm_offset
        nrm_bv = len(buffer_views)
        buffer_views.append({
            "buffer": 0, "byteOffset": nrm_offset,
            "byteLength": nrm_length, "target": 34962,
        })
        nrm_acc = len(accessors)
        accessors.append({
            "bufferView": nrm_bv, "componentType": 5126,
            "count": len(normals), "type": "VEC3",
        })

        align4()
        idx_offset = len(buf)
        for i in indices:
            buf.extend(struct.pack("<H", i))
        idx_length = len(buf) - idx_offset
        idx_bv = len(buffer_views)
        buffer_views.append({
            "buffer": 0, "byteOffset": idx_offset,
            "byteLength": idx_length, "target": 34963,
        })
        idx_acc = len(accessors)
        accessors.append({
            "bufferView": idx_bv, "componentType": 5123,
            "count": len(indices), "type": "SCALAR",
        })

        mesh_primitives.append({
            "attributes": {"POSITION": pos_acc, "NORMAL": nrm_acc},
            "indices": idx_acc,
            "material": material_index,
            "mode": 4,
        })

    out_materials = []
    for name, color, metallic, roughness in materials:
        mat = special_material(name, color, metallic, roughness) if special_material else None
        if mat is None:
            mat = default_material(name, color, metallic, roughness)
        out_materials.append(mat)

    b64 = base64.b64encode(bytes(buf)).decode("ascii")

    gltf = {
        "asset": {"version": "2.0", "generator": generator_name},
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [0]}],
        "nodes": [{"name": node_name, "mesh": 0}],
        "meshes": [{"name": node_name, "primitives": mesh_primitives}],
        "materials": out_materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{
            "byteLength": len(buf),
            "uri": "data:application/octet-stream;base64," + b64,
        }],
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(gltf, indent=2))
    return triangle_count
