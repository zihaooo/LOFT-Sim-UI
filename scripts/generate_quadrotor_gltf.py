#!/usr/bin/env python3
"""
Generate a low-poly quadrotor (quadcopter) cargo drone as a self-contained glTF 2.0 file.

The drone faces -Z (glTF/Three.js convention) with +Y up. A red nose marker
on the front face indicates orientation. Geometry is built from axis-aligned
boxes with flat shading so it stays low-poly.

Example:
  python scripts/generate_quadrotor_gltf.py -o public/data/model/quadrotor.gltf
"""

import argparse
import math
import sys
from pathlib import Path
from typing import List, Optional

from gltf_common import (
    Box,
    Primitive,
    build_gltf,
    make_disc,
    rotate_y,
)


# Drone parts grouped by material.
# Forward = -Z, up = +Y, right = +X. Wingspan ~1.0m tip-to-tip.
# Each entry is (box, rotation_around_Y_in_degrees). For the arm assembly,
# a single canonical part pointing along -Z is instanced at 45/135/225/315 deg
# so the wingtips sit at the four diagonal corners (X-configured quadcopter).
ARM_ROTATIONS_DEG = (45.0, 135.0, 225.0, 315.0)

CANONICAL_ARM:   Box = ((-0.025, -0.015, -0.50), (0.025, 0.015, -0.13))
CANONICAL_MOTOR: Box = ((-0.04,  -0.025, -0.54), (0.04,  0.045, -0.46))
# Prop sits 0.005 above the motor top (y=0.045) so it clears it; a coplanar bottom would
# z-fight with the motor's top face (worst with the translucent disc, which covers it fully).
CANONICAL_PROP:  Box = ((-0.16,   0.050, -0.508), (0.16,  0.060, -0.492))

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
# Centered in the raised prop band [0.050, 0.060] so the disc's bottom cap clears the motor top.
CANONICAL_DISC_CENTER = (0.0, 0.055, -0.50)
DISC_BASE_COLOR = [0.78, 0.80, 0.84, 0.45]


def make_special_primitive(prop_style: str):
    """When prop_style == 'disc', replace the four cuboid blades with spinning discs."""
    def special(name: str) -> Optional[Primitive]:
        if name == "prop" and prop_style == "disc":
            all_pos: List = []
            all_norm: List = []
            all_idx: List[int] = []
            for deg in ARM_ROTATIONS_DEG:
                center = rotate_y(CANONICAL_DISC_CENTER, math.radians(deg))
                p, n, i = make_disc(center, DISC_RADIUS, DISC_THICKNESS, DISC_SEGMENTS)
                offset = len(all_pos)
                all_pos.extend(p)
                all_norm.extend(n)
                all_idx.extend(idx + offset for idx in i)
            return all_pos, all_norm, all_idx
        return None
    return special


def make_special_material(prop_style: str):
    def special(name: str, color, metallic, roughness) -> Optional[dict]:
        if name == "prop" and prop_style == "disc":
            return {
                "name": "prop_disc",
                "pbrMetallicRoughness": {
                    "baseColorFactor": DISC_BASE_COLOR,
                    "metallicFactor": 0.05,
                    "roughnessFactor": 0.85,
                },
                "alphaMode": "BLEND",
                "doubleSided": True,
            }
        return None
    return special


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate a low-poly quadrotor cargo drone glTF.")
    p.add_argument("-o", "--output", default=Path("public/data/model/quadrotor.gltf"), type=Path,
                   help="Output .gltf path.")
    p.add_argument("--prop-style", choices=("blade", "disc"), default="blade",
                   help="Propeller appearance: 'blade' (static cuboid blades, default) "
                        "or 'disc' (semi-transparent disc mimicking a spinning rotor).")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    triangle_count = build_gltf(
        args.output,
        DRONE_PARTS,
        MATERIALS,
        generator_name="LOFT_UI low-poly quadrotor generator",
        node_name="Quadrotor",
        special_primitive=make_special_primitive(args.prop_style),
        special_material=make_special_material(args.prop_style),
    )
    print(f"wrote {args.output} ({triangle_count} triangles, prop_style={args.prop_style})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
