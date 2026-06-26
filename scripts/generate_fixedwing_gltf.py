#!/usr/bin/env python3
"""
Generate a low-poly fixed-wing cargo drone as a self-contained glTF 2.0 file.

Twin-boom pusher layout: a dark airframe fuselage body carries a straight
constant-chord wing, two tail booms joined by a horizontal stabilizer, and a rear
pusher propeller on a small motor nacelle. A kraft-cardboard cargo box (wrapped
with tape) is attached under the fuselage belly. A red nose marker indicates
orientation.

The drone faces -Z (glTF/Three.js convention) with +Y up, +X right; the wingspan is
the widest horizontal dimension so it normalizes the same way the quadrotor does.
Geometry is axis-aligned boxes with flat shading to stay low-poly.

Example:
  python scripts/generate_fixedwing_gltf.py -o public/data/model/fixedwing.gltf
"""

import argparse
import math
import sys
from pathlib import Path
from typing import Optional

from gltf_common import (
    Box,
    Primitive,
    build_gltf,
    make_disc,
    rotate_x,
    translate,
)


# Parts grouped by material. Forward = -Z, up = +Y, right = +X.
# Wingspan ~1.0m tip-to-tip (the widest dimension, matching the quadrotor's scale).
# Each entry is (box, rotation_around_Y_in_degrees); this airframe is all axis-aligned
# so every rotation is 0.
FUSELAGE:  Box = ((-0.085, -0.045, -0.20), (0.085, 0.075, 0.18))
NOSE:      Box = ((-0.06,  -0.05,  -0.27), (0.06,  0.05,  -0.20))
WING:      Box = ((-0.50,   0.03,  -0.06), (0.50,  0.06,   0.14))
HSTAB:     Box = ((-0.215,  0.00,   0.36), (0.215, 0.03,   0.46))
NACELLE:   Box = ((-0.045, -0.04,   0.18), (0.045, 0.04,   0.235))
# Kraft cargo box attached under the belly; its top tucks up into the fuselage.
CARGO:     Box = ((-0.075, -0.165, -0.11), (0.075, -0.035, 0.09))

FIXEDWING_PARTS: dict = {
    # Dark airframe body: fuselage, wing and horizontal stabilizer.
    "body": [(FUSELAGE, 0.0), (WING, 0.0), (HSTAB, 0.0)],
    # Kraft-cardboard payload box attached beneath the fuselage belly.
    "cargo": [(CARGO, 0.0)],
    # Two straps cross-wrapping the cargo box, sitting slightly proud.
    "tape": [
        (((-0.012, -0.167, -0.112), (0.012, -0.033, 0.092)), 0.0),
        (((-0.077, -0.167, -0.012), (0.077, -0.033, 0.012)), 0.0),
    ],
    # Twin tail booms running aft from the wing to the stabilizer.
    "boom": [
        (((-0.185, -0.02, -0.02), (-0.155, 0.02, 0.40)), 0.0),
        ((( 0.155, -0.02, -0.02), ( 0.185, 0.02, 0.40)), 0.0),
    ],
    "motor": [(NACELLE, 0.0)],
    # Rear pusher prop as a vertical cross of blades (spins about Z). The disc
    # prop_style swaps these for a semi-transparent disc (see make_special_primitive).
    "prop": [
        (((-0.016, -0.14, 0.238), (0.016, 0.14, 0.252)), 0.0),
        (((-0.14, -0.016, 0.238), (0.14, 0.016, 0.252)), 0.0),
    ],
    # Red nose marker for orientation.
    "nose": [(NOSE, 0.0)],
}


# (name, baseColorRGBA, metallicFactor, roughnessFactor). Colors reuse the quadrotor
# palette so the two models read as the same fleet family.
MATERIALS = [
    ("body",  [0.20, 0.20, 0.22, 1.0], 0.20, 0.70),
    ("cargo", [0.78, 0.55, 0.30, 1.0], 0.05, 0.85),
    ("tape",  [0.92, 0.82, 0.55, 1.0], 0.05, 0.75),
    ("boom",  [0.32, 0.32, 0.34, 1.0], 0.20, 0.70),
    ("motor", [0.08, 0.08, 0.10, 1.0], 0.60, 0.40),
    ("prop",  [0.68, 0.70, 0.74, 1.0], 0.30, 0.50),
    ("nose",  [0.85, 0.15, 0.15, 1.0], 0.10, 0.55),
]


# Spinning-rotor disc: thin, slightly translucent, standing vertical behind the nacelle.
DISC_RADIUS = 0.14
DISC_THICKNESS = 0.012
DISC_SEGMENTS = 16
DISC_CENTER = (0.0, 0.0, 0.245)
DISC_BASE_COLOR = [0.78, 0.80, 0.84, 0.45]


def make_special_primitive(prop_style: str):
    """When prop_style == 'disc', replace the cross blades with a vertical spinning disc."""
    def special(name: str) -> Optional[Primitive]:
        if name == "prop" and prop_style == "disc":
            # Build a flat Y-disc at the origin, stand it vertical (caps facing
            # fore/aft), then slide it back to the propeller station.
            p, n, i = make_disc((0.0, 0.0, 0.0), DISC_RADIUS, DISC_THICKNESS, DISC_SEGMENTS)
            angle = math.radians(90.0)
            p = translate([rotate_x(v, angle) for v in p], DISC_CENTER)
            n = [rotate_x(v, angle) for v in n]
            return p, n, i
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
    p = argparse.ArgumentParser(description="Generate a low-poly fixed-wing cargo drone glTF.")
    p.add_argument("-o", "--output", default=Path("public/data/model/fixedwing.gltf"), type=Path,
                   help="Output .gltf path.")
    p.add_argument("--prop-style", choices=("blade", "disc"), default="blade",
                   help="Propeller appearance: 'blade' (static cross blades, default) "
                        "or 'disc' (semi-transparent disc mimicking a spinning rotor).")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    triangle_count = build_gltf(
        args.output,
        FIXEDWING_PARTS,
        MATERIALS,
        generator_name="LOFT_UI low-poly fixed-wing generator",
        node_name="FixedWing",
        special_primitive=make_special_primitive(args.prop_style),
        special_material=make_special_material(args.prop_style),
    )
    print(f"wrote {args.output} ({triangle_count} triangles, prop_style={args.prop_style})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
