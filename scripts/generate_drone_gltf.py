#!/usr/bin/env python3
"""
Generate a low-poly quadcopter drone as a self-contained glTF 2.0 file.

The drone faces -Z (glTF/Three.js convention) with +Y up. A red nose marker
on the front face indicates orientation. Geometry is built from axis-aligned
boxes with flat shading so it stays low-poly.

Example:
  python scripts/generate_drone_gltf.py -o public/data/model/drone.gltf
"""

import argparse
import base64
import json
import math
import struct
import sys
from pathlib import Path
from typing import List, Tuple

Vec3 = Tuple[float, float, float]
Box = Tuple[Vec3, Vec3]
PlacedBox = Tuple[Box, float]  # (box, rotation around +Y in degrees)


def make_box(mn: Vec3, mx: Vec3):
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


def combine_boxes(items: List[PlacedBox]):
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


def make_disc(center: Vec3, radius: float, thickness: float, segments: int):
    """Thin Y-axis-aligned disc (capped cylinder) approximating a spinning prop."""
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


# Drone parts grouped by material.
# Forward = -Z, up = +Y, right = +X. Wingspan ~1.0m tip-to-tip.
# Each entry is (box, rotation_around_Y_in_degrees). For the arm assembly,
# a single canonical part pointing along -Z is instanced at 45/135/225/315 deg
# so the wingtips sit at the four diagonal corners (X-configured quadcopter).
ARM_ROTATIONS_DEG = (45.0, 135.0, 225.0, 315.0)

CANONICAL_ARM:   Box = ((-0.025, -0.015, -0.50), (0.025, 0.015, -0.13))
CANONICAL_MOTOR: Box = ((-0.04,  -0.025, -0.54), (0.04,  0.045, -0.46))
CANONICAL_PROP:  Box = ((-0.16,   0.045, -0.508), (0.16,  0.055, -0.492))

DRONE_PARTS: dict = {
    "body": [
        (((-0.15, -0.04, -0.15), (0.15, 0.04, 0.15)), 0.0),
    ],
    "front": [
        (((-0.045, -0.022, -0.17), (0.045, 0.022, -0.15)), 0.0),
    ],
    "arm":   [(CANONICAL_ARM,   d) for d in ARM_ROTATIONS_DEG],
    "motor": [(CANONICAL_MOTOR, d) for d in ARM_ROTATIONS_DEG],
    "prop":  [(CANONICAL_PROP,  d) for d in ARM_ROTATIONS_DEG],
    # Four thin vertical struts hanging the cargo box from the body underside.
    "strut": [
        ((( 0.075, -0.115, -0.075), (0.090, -0.040, -0.060)), 0.0),
        (((-0.090, -0.115, -0.075), (-0.075, -0.040, -0.060)), 0.0),
        ((( 0.075, -0.115,  0.060), (0.090, -0.040,  0.075)), 0.0),
        (((-0.090, -0.115,  0.060), (-0.075, -0.040,  0.075)), 0.0),
    ],
    # Cardboard-style payload box slung beneath the airframe.
    "cargo": [
        (((-0.10, -0.22, -0.10), (0.10, -0.11, 0.10)), 0.0),
    ],
    # Strap/tape stripes wrapped around the cargo box for visual interest.
    "tape": [
        (((-0.012, -0.219, -0.101), (0.012, -0.111, 0.101)), 0.0),
        (((-0.101, -0.219, -0.012), (0.101, -0.111, 0.012)), 0.0),
    ],
}


# (name, baseColorRGBA, metallicFactor, roughnessFactor)
MATERIALS = [
    ("body",  [0.20, 0.20, 0.22, 1.0], 0.20, 0.70),
    ("front", [0.85, 0.15, 0.15, 1.0], 0.10, 0.55),
    ("arm",   [0.32, 0.32, 0.34, 1.0], 0.20, 0.70),
    ("motor", [0.08, 0.08, 0.10, 1.0], 0.60, 0.40),
    ("prop",  [0.68, 0.70, 0.74, 1.0], 0.30, 0.50),
    ("strut", [0.15, 0.15, 0.17, 1.0], 0.50, 0.45),
    ("cargo", [0.78, 0.55, 0.30, 1.0], 0.05, 0.85),
    ("tape",  [0.92, 0.82, 0.55, 1.0], 0.05, 0.75),
]


# Spinning-rotor disc: thin, slightly translucent, centered above each motor.
DISC_RADIUS = 0.16
DISC_THICKNESS = 0.010
DISC_SEGMENTS = 16
CANONICAL_DISC_CENTER: Vec3 = (0.0, 0.050, -0.50)
DISC_BASE_COLOR = [0.78, 0.80, 0.84, 0.45]


def build_primitive(name: str, prop_style: str):
    if name == "prop" and prop_style == "disc":
        all_pos: List[Vec3] = []
        all_norm: List[Vec3] = []
        all_idx: List[int] = []
        for deg in ARM_ROTATIONS_DEG:
            center = rotate_y(CANONICAL_DISC_CENTER, math.radians(deg))
            p, n, i = make_disc(center, DISC_RADIUS, DISC_THICKNESS, DISC_SEGMENTS)
            offset = len(all_pos)
            all_pos.extend(p)
            all_norm.extend(n)
            all_idx.extend(idx + offset for idx in i)
        return all_pos, all_norm, all_idx
    return combine_boxes(DRONE_PARTS[name])


def build_gltf(output_path: Path, prop_style: str = "blade") -> None:
    buf = bytearray()
    buffer_views: list = []
    accessors: list = []
    mesh_primitives: list = []

    def align4() -> None:
        while len(buf) % 4 != 0:
            buf.append(0)

    for material_index, (name, _color, _metallic, _roughness) in enumerate(MATERIALS):
        positions, normals, indices = build_primitive(name, prop_style)

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

    materials = []
    for name, color, metallic, roughness in MATERIALS:
        if name == "prop" and prop_style == "disc":
            mat = {
                "name": "prop_disc",
                "pbrMetallicRoughness": {
                    "baseColorFactor": DISC_BASE_COLOR,
                    "metallicFactor": 0.05,
                    "roughnessFactor": 0.85,
                },
                "alphaMode": "BLEND",
                "doubleSided": True,
            }
        else:
            mat = {
                "name": name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": color,
                    "metallicFactor": metallic,
                    "roughnessFactor": roughness,
                },
            }
        materials.append(mat)

    b64 = base64.b64encode(bytes(buf)).decode("ascii")

    gltf = {
        "asset": {"version": "2.0", "generator": "LOFT_UI low-poly drone generator"},
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [0]}],
        "nodes": [{"name": "Drone", "mesh": 0}],
        "meshes": [{"name": "Drone", "primitives": mesh_primitives}],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{
            "byteLength": len(buf),
            "uri": "data:application/octet-stream;base64," + b64,
        }],
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(gltf, indent=2))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate a low-poly quadcopter drone glTF.")
    p.add_argument("-o", "--output", default=Path("public/data/model/drone.gltf"), type=Path,
                   help="Output .gltf path.")
    p.add_argument("--prop-style", choices=("blade", "disc"), default="blade",
                   help="Propeller appearance: 'blade' (static cuboid blades, default) "
                        "or 'disc' (semi-transparent disc mimicking a spinning rotor).")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    build_gltf(args.output, prop_style=args.prop_style)
    triangle_count = sum(
        len(build_primitive(name, args.prop_style)[2]) // 3
        for name, *_ in MATERIALS
    )
    print(f"wrote {args.output} ({triangle_count} triangles, prop_style={args.prop_style})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
