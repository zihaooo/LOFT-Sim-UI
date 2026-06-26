#!/usr/bin/env python3
"""
Generate a low-poly hybrid (tilt-rotor VTOL) cargo drone as a self-contained glTF 2.0 file.

The hybrid is the only model with BOTH a wing and lift rotors: a dark airframe
fuselage carries a straight wing whose tips hold two chunky nacelles, each with one
large proprotor. The nacelles + proprotors are frozen at a ~45-degree transition
tilt (between hover and cruise) -- the unmistakable tilt-rotor signature that keeps
it distinct from the quadrotor (4 flat discs, no wing) and the fixed-wing (twin
booms + tail pusher, no lift rotors). A conventional tail (horizontal stabilizer +
vertical fin) and a belly-mounted kraft cargo box round it out; a red nose marker
indicates orientation.

Faces -Z (glTF/Three.js convention) with +Y up, +X right. Geometry is axis-aligned
boxes with flat shading; the nacelles and proprotors are tilted about X with the
shared rotate_x helper. The rotor span is the widest horizontal dimension, so the
model normalizes the same way the other two do.

Example:
  python scripts/generate_hybrid_gltf.py -o public/data/model/hybrid.gltf
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
    make_box,
    make_disc,
    rotate_x,
    translate,
)


# --- Static airframe parts (axis-aligned), grouped by material. Forward = -Z. ---
FUSELAGE:  Box = ((-0.085, -0.045, -0.20), (0.085, 0.075, 0.20))
NOSE:      Box = ((-0.06,  -0.05,  -0.27), (0.06,  0.05,  -0.20))
WING:      Box = ((-0.50,   0.02,  -0.05), (0.50,  0.05,   0.13))
HSTAB:     Box = ((-0.13,   0.00,   0.18), (0.13,  0.025,  0.27))
VFIN:      Box = ((-0.014,  0.06,   0.18), (0.014, 0.17,   0.27))
CARGO:     Box = ((-0.075, -0.165, -0.10), (0.075, -0.035, 0.10))

FIXED_PARTS: dict = {
    # Dark airframe body: fuselage, wing, horizontal stabilizer, vertical fin.
    "body": [(FUSELAGE, 0.0), (WING, 0.0), (HSTAB, 0.0), (VFIN, 0.0)],
    # Kraft-cardboard payload box attached beneath the fuselage belly.
    "cargo": [(CARGO, 0.0)],
    # Two straps cross-wrapping the cargo box, sitting slightly proud.
    "tape": [
        (((-0.012, -0.167, -0.102), (0.012, -0.033, 0.102)), 0.0),
        (((-0.077, -0.167, -0.012), (0.077, -0.033, 0.012)), 0.0),
    ],
    # Red nose marker for orientation.
    "nose": [(NOSE, 0.0)],
}


# (name, baseColorRGBA, metallicFactor, roughnessFactor). Reuses the shared fleet
# palette so all three models read as the same family. "motor" (nacelles) and
# "prop" (proprotors) are generated procedurally (see make_special_primitive).
MATERIALS = [
    ("body",  [0.20, 0.20, 0.22, 1.0], 0.20, 0.70),
    ("cargo", [0.78, 0.55, 0.30, 1.0], 0.05, 0.85),
    ("tape",  [0.92, 0.82, 0.55, 1.0], 0.05, 0.75),
    ("motor", [0.08, 0.08, 0.10, 1.0], 0.60, 0.40),
    ("prop",  [0.68, 0.70, 0.74, 1.0], 0.30, 0.50),
    ("nose",  [0.85, 0.15, 0.15, 1.0], 0.10, 0.55),
]


# --- Tilting wingtip rotor units (the distinguishing feature) ---
# Built in a "hover" frame (rotor axis pointing +Y), then tilted forward about X and
# translated out to each wingtip. A negative tilt leans the rotor up-and-forward (-Z).
TILT_DEG = -45.0
WINGTIP_X = 0.50      # nacelle centers sit at the wingtips
WINGTIP_Y = 0.035     # at wing mid-height
WINGTIP_Z = 0.02      # slightly forward of the wing chord center
NACELLE_CANON: Box = ((-0.045, -0.05, -0.05), (0.045, 0.065, 0.05))
HUB_Y = 0.075         # rotor hub just above the nacelle top
ROTOR_RADIUS = 0.18   # large proprotor; rotor span ends up widest overall
ROTOR_THICKNESS = 0.012
ROTOR_SEGMENTS = 16
BLADE_HALF = 0.007    # half-thickness of the cross blades (blade prop_style)
DISC_BASE_COLOR = [0.78, 0.80, 0.84, 0.45]


def _merge(units: List[Primitive]) -> Primitive:
    all_pos: List = []
    all_norm: List = []
    all_idx: List[int] = []
    for pos, norm, idx in units:
        offset = len(all_pos)
        all_pos.extend(pos)
        all_norm.extend(norm)
        all_idx.extend(i + offset for i in idx)
    return all_pos, all_norm, all_idx


def _tilt_and_place(prim: Primitive, tilt_rad: float, offset) -> Primitive:
    pos, norm, idx = prim
    pos = translate([rotate_x(p, tilt_rad) for p in pos], offset)
    norm = [rotate_x(n, tilt_rad) for n in norm]
    return pos, norm, idx


def _rotor_unit(prop_style: str) -> Primitive:
    """One rotor's geometry in the hover frame (axis +Y), before tilt/placement."""
    if prop_style == "disc":
        return make_disc((0.0, HUB_Y, 0.0), ROTOR_RADIUS, ROTOR_THICKNESS, ROTOR_SEGMENTS)
    blade_x = make_box((-ROTOR_RADIUS, HUB_Y - BLADE_HALF, -0.014),
                       (ROTOR_RADIUS, HUB_Y + BLADE_HALF, 0.014))
    blade_z = make_box((-0.014, HUB_Y - BLADE_HALF, -ROTOR_RADIUS),
                       (0.014, HUB_Y + BLADE_HALF, ROTOR_RADIUS))
    return _merge([blade_x, blade_z])


def make_special_primitive(prop_style: str):
    """Generate the two tilted wingtip nacelles ('motor') and proprotors ('prop')."""
    tilt = math.radians(TILT_DEG)
    offsets = [(WINGTIP_X, WINGTIP_Y, WINGTIP_Z), (-WINGTIP_X, WINGTIP_Y, WINGTIP_Z)]

    def special(name: str) -> Optional[Primitive]:
        if name == "motor":
            nacelle = make_box(*NACELLE_CANON)
            return _merge([_tilt_and_place(nacelle, tilt, o) for o in offsets])
        if name == "prop":
            unit = _rotor_unit(prop_style)
            return _merge([_tilt_and_place(unit, tilt, o) for o in offsets])
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
    p = argparse.ArgumentParser(description="Generate a low-poly hybrid (tilt-rotor) cargo drone glTF.")
    p.add_argument("-o", "--output", default=Path("public/data/model/hybrid.gltf"), type=Path,
                   help="Output .gltf path.")
    p.add_argument("--prop-style", choices=("blade", "disc"), default="blade",
                   help="Proprotor appearance: 'blade' (static cross blades, default) "
                        "or 'disc' (semi-transparent disc mimicking a spinning rotor).")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    triangle_count = build_gltf(
        args.output,
        FIXED_PARTS,
        MATERIALS,
        generator_name="LOFT_UI low-poly hybrid (tilt-rotor) generator",
        node_name="Hybrid",
        special_primitive=make_special_primitive(args.prop_style),
        special_material=make_special_material(args.prop_style),
    )
    print(f"wrote {args.output} ({triangle_count} triangles, prop_style={args.prop_style})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
