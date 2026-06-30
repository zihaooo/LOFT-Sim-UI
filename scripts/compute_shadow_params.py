#!/usr/bin/env python3
"""Derive per-type drone shadow profiles (a small set of rectangles) from the UAV model geometry.

Each drone's top-down silhouette is approximated by a few oriented rectangles — the models are built
from axis-aligned boxes, so a rectangle is the faithful (and cheap) shape the renderer unions into a soft
ground shadow (see src/layer/drone.ts). The rectangles are the oriented bounding boxes of the SAME box
geometry the glTF generators use, normalized to each model's footprint so they line up with the model
after it is scaled to DRONE_MODEL_SPAN_METERS at load.

Composition (matching the visual intent):
  - quadrotor : 1 square body + 2 thin diagonal rectangles (the X of arms/props)
  - fixed-wing: wing + fuselage + horizontal stabilizer + 2 thin twin-boom rectangles
  - hybrid    : wing (incl. tilted wingtip proprotors) + fuselage + horizontal stabilizer

Output: public/data/model/shadow_profiles.json, keyed by vehicle type code (1=quad, 2=fixed-wing,
3=hybrid). Coordinates are in normalized model space: forward = -z, right = +x, and ±1 = half the
model's widest horizontal span (so the renderer scales a profile by the same half-span it renders the
model at). Each rect is a center (cx, cz), half-extents (a, b), and `angleDeg` rotating its a axis from
+x toward +z.

Run:  python scripts/compute_shadow_params.py
"""

import json
import math
import sys
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import generate_fixedwing_gltf as fw
import generate_hybrid_gltf as hy
import generate_quadrotor_gltf as qr
from gltf_common import Box, rotate_x, rotate_y

XZ = Tuple[float, float]


def box_corners(box: Box) -> List[Tuple[float, float, float]]:
    """The 8 corners of an axis-aligned box."""
    (x0, y0, z0), (x1, y1, z1) = box
    return [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]


def placed_corners(box: Box, rot_deg: float = 0.0) -> List[XZ]:
    """A box's corners projected to the ground plane (x, z), after an optional +Y rotation."""
    angle = math.radians(rot_deg)
    pts = box_corners(box)
    if rot_deg:
        pts = [rotate_y(p, angle) for p in pts]
    return [(x, z) for x, _, z in pts]


def tilted_disc_corners(radius: float, hub_y: float, tilt_deg: float, offset: Tuple[float, float, float],
                        segments: int = 24) -> List[XZ]:
    """Ground-plane footprint of a hover-frame (+Y axis) disc tilted about X and placed at `offset`."""
    tilt = math.radians(tilt_deg)
    ox, _oy, oz = offset
    out: List[XZ] = []
    for i in range(segments):
        a = 2.0 * math.pi * i / segments
        p = (radius * math.cos(a), hub_y, radius * math.sin(a))
        x, _, z = rotate_x(p, tilt)
        out.append((x + ox, z + oz))
    return out


def fit_aabb(points: Sequence[XZ]) -> Dict[str, float]:
    """Axis-aligned bounding rectangle (half-extents = half the x/z extents)."""
    xs = [p[0] for p in points]
    zs = [p[1] for p in points]
    cx, cz = (min(xs) + max(xs)) / 2.0, (min(zs) + max(zs)) / 2.0
    return {"cx": cx, "cz": cz, "a": (max(xs) - min(xs)) / 2.0, "b": (max(zs) - min(zs)) / 2.0, "angleDeg": 0.0}


def fit_pca(points: Sequence[XZ]) -> Dict[str, float]:
    """Oriented bounding rectangle via PCA: principal axes from the covariance, half-extents from the tight
    max projection onto each axis. Used for the rotated quad arms (the long axis lands on the diagonal)."""
    n = len(points)
    mx = sum(p[0] for p in points) / n
    mz = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points) / n
    szz = sum((p[1] - mz) ** 2 for p in points) / n
    sxz = sum((p[0] - mx) * (p[1] - mz) for p in points) / n

    # Eigenvector of the larger eigenvalue of [[sxx, sxz], [sxz, szz]].
    tr, det = sxx + szz, sxx * szz - sxz * sxz
    lam = tr / 2.0 + math.sqrt(max(0.0, (tr / 2.0) ** 2 - det))
    if abs(sxz) > 1e-9:
        ex, ez = lam - szz, sxz
    else:
        ex, ez = (1.0, 0.0) if sxx >= szz else (0.0, 1.0)
    inv = 1.0 / math.hypot(ex, ez)
    ex, ez = ex * inv, ez * inv  # major axis direction
    px, pz = -ez, ex             # minor axis direction (perpendicular)

    a = max(abs((p[0] - mx) * ex + (p[1] - mz) * ez) for p in points)
    b = max(abs((p[0] - mx) * px + (p[1] - mz) * pz) for p in points)
    return {"cx": mx, "cz": mz, "a": a, "b": b, "angleDeg": math.degrees(math.atan2(ez, ex))}


def all_part_xz(parts: Dict[str, list], extra: Sequence[XZ] = ()) -> List[XZ]:
    """Every placed box corner of a model (+ any extra points), projected to the ground plane."""
    pts: List[XZ] = list(extra)
    for boxes in parts.values():
        for box, rot in boxes:
            pts.extend(placed_corners(box, rot))
    return pts


def model_frame(all_points: Sequence[XZ]) -> Tuple[float, float, float]:
    """The (center_x, center_z, footprint_half) that normalizeDroneGeometry bakes into the loaded model:
    recenter on the bbox center, scale so the widest horizontal span = DRONE_MODEL_SPAN_METERS."""
    xs = [p[0] for p in all_points]
    zs = [p[1] for p in all_points]
    cx = (min(xs) + max(xs)) / 2.0
    cz = (min(zs) + max(zs)) / 2.0
    half = max(max(xs) - min(xs), max(zs) - min(zs)) / 2.0
    return cx, cz, half


def bake_rect(e: Dict[str, float], cx0: float, cz0: float, half: float) -> Dict[str, float]:
    """Transform a raw rectangle into the loaded model's local frame: recenter on the model bbox center,
    apply the model's rotateY(180deg) (negate x and z), then normalize by the footprint half-span. The
    angle is unchanged — a rectangle is symmetric under the 180deg turn."""
    return {
        "cx": round(-(e["cx"] - cx0) / half, 4),
        "cz": round(-(e["cz"] - cz0) / half, 4),
        "a": round(e["a"] / half, 4),
        "b": round(e["b"] / half, 4),
        "angleDeg": round(e["angleDeg"], 2),
    }


def quadrotor_profile() -> Tuple[List[Dict[str, float]], List[XZ]]:
    body = placed_corners(qr.DRONE_PARTS["body"][0][0]) + placed_corners(qr.DRONE_PARTS["front"][0][0])
    # Arm rects span the thin arm + motor only; the wide props (CANONICAL_PROP) are spinning discs that would
    # bloat the bars, so they cast no shadow.
    arm_boxes = [qr.CANONICAL_ARM, qr.CANONICAL_MOTOR]
    diag_a = [pt for rot in (45.0, 225.0) for box in arm_boxes for pt in placed_corners(box, rot)]
    diag_b = [pt for rot in (135.0, 315.0) for box in arm_boxes for pt in placed_corners(box, rot)]

    rects = [fit_aabb(body), fit_pca(diag_a), fit_pca(diag_b)]
    return rects, all_part_xz(qr.DRONE_PARTS)


def fixedwing_profile() -> Tuple[List[Dict[str, float]], List[XZ]]:
    wing = placed_corners(fw.WING)
    body = placed_corners(fw.FUSELAGE) + placed_corners(fw.NOSE)
    hstab = placed_corners(fw.HSTAB)
    # One thin rect per twin-boom member (the two longitudinal booms running aft to the stabilizer).
    boom_rects = [fit_aabb(placed_corners(box, rot)) for box, rot in fw.FIXEDWING_PARTS["boom"]]

    rects = [fit_aabb(wing), fit_aabb(body), fit_aabb(hstab), *boom_rects]
    return rects, all_part_xz(fw.FIXEDWING_PARTS)


def hybrid_profile() -> Tuple[List[Dict[str, float]], List[XZ]]:
    rotor_l = tilted_disc_corners(hy.ROTOR_RADIUS, hy.HUB_Y, hy.TILT_DEG, (hy.WINGTIP_X, hy.WINGTIP_Y, hy.WINGTIP_Z))
    rotor_r = tilted_disc_corners(hy.ROTOR_RADIUS, hy.HUB_Y, hy.TILT_DEG, (-hy.WINGTIP_X, hy.WINGTIP_Y, hy.WINGTIP_Z))
    # Wing rect = the wing only. The wingtip proprotors are spinning discs (like the quad props), so they
    # don't get a shadow rect — but they ARE the model's widest part, so they still set the footprint below.
    wing = placed_corners(hy.WING)
    body = placed_corners(hy.FUSELAGE) + placed_corners(hy.NOSE)
    hstab = placed_corners(hy.HSTAB)

    rects = [fit_aabb(wing), fit_aabb(body), fit_aabb(hstab)]
    return rects, all_part_xz(hy.FIXED_PARTS, extra=rotor_l + rotor_r)


def main() -> int:
    builders = {1: ("quadrotor", quadrotor_profile), 2: ("fixed_wing", fixedwing_profile), 3: ("hybrid", hybrid_profile)}
    profiles: Dict[str, dict] = {}
    for code, (name, build) in builders.items():
        rects, all_pts = build()
        cx0, cz0, half = model_frame(all_pts)
        norm = [bake_rect(e, cx0, cz0, half) for e in rects]
        profiles[str(code)] = {"name": name, "rects": norm}
        print(f"{name:11s} center=({cx0:+.3f},{cz0:+.3f}) footprint_half={half:.3f}m  rects:")
        for e in norm:
            print(f"    c=({e['cx']:+.3f},{e['cz']:+.3f})  a={e['a']:.3f} b={e['b']:.3f}  angle={e['angleDeg']:+.1f}")

    out = Path(__file__).resolve().parents[1] / "public" / "data" / "model" / "shadow_profiles.json"
    out.write_text(json.dumps(profiles, indent=2) + "\n")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
