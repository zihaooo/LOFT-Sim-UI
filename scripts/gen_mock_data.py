#!/usr/bin/env python3
"""Generate simulator-style mock telemetry data from frontend air-corridor OSM."""

import argparse
import json
import math
import random
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

METERS_PER_DEGREE_LAT = 111_320.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate mock telemetry corridor/drone data.")
    parser.add_argument("--corridor", type=Path, default=Path("public/data/network/airspace_network.osm"), help="Input air-corridor OSM.")
    parser.add_argument("--output", type=Path, default=Path("mock/mock_telemetry.json"), help="Output JSON path.")
    parser.add_argument("--drones", type=int, default=1000, help="Number of mock drones.")
    parser.add_argument("--speed", type=float, default=28.0, help="Base mock speed in m/s.")
    parser.add_argument("--noise", type=float, default=0.0, help="Position noise amplitude in meters.")
    parser.add_argument("--seed", type=int, default=7, help="Deterministic random seed.")
    return parser.parse_args()


def osm_tags(elem: ET.Element) -> dict[str, str]:
    return {
        tag.get("k", ""): tag.get("v", "")
        for tag in elem.findall("tag")
        if tag.get("k")
    }


def parse_float(value: str | None, fallback: float = 0.0) -> float:
    try:
        return float(value) if value is not None else fallback
    except ValueError:
        return fallback


def corridor_length(points: list[dict[str, float]]) -> tuple[float, list[float]]:
    cumulative = [0.0]
    for index in range(1, len(points)):
        prev = points[index - 1]
        current = points[index]
        distance = math.sqrt(
            (current["x"] - prev["x"]) ** 2
            + (current["y"] - prev["y"]) ** 2
            + (current["z"] - prev["z"]) ** 2
        )
        cumulative.append(cumulative[-1] + distance)
    return cumulative[-1], cumulative


def main() -> int:
    args = parse_args()
    if args.drones < 0:
        print("--drones must be >= 0", file=sys.stderr)
        return 2
    if not args.corridor.exists():
        print(f"corridor file not found: {args.corridor}", file=sys.stderr)
        return 2

    tree = ET.parse(args.corridor)
    root = tree.getroot()
    node_elems = {node.get("id"): node for node in root.findall("node") if node.get("id")}
    lats = [parse_float(node.get("lat")) for node in node_elems.values()]
    lons = [parse_float(node.get("lon")) for node in node_elems.values()]
    if not lats or not lons:
        print("corridor OSM has no node coordinates", file=sys.stderr)
        return 2

    origin_lat = min(lats)
    origin_lon = min(lons)
    mid_lat = (min(lats) + max(lats)) / 2.0
    meters_per_degree_lon = METERS_PER_DEGREE_LAT * max(math.cos(math.radians(mid_lat)), 1e-6)

    corridors = []
    for corridor_index, way in enumerate(root.findall("way")):
        tags = osm_tags(way)
        if tags.get("corridor") != "air":
            continue

        points = []
        for nd in way.findall("nd"):
            node = node_elems.get(nd.get("ref"))
            if node is None:
                continue
            node_tags = osm_tags(node)
            lat = parse_float(node.get("lat"))
            lon = parse_float(node.get("lon"))
            points.append({
                "x": (lon - origin_lon) * meters_per_degree_lon,
                "y": (lat - origin_lat) * METERS_PER_DEGREE_LAT,
                "z": parse_float(node_tags.get("altitude")),
            })

        if len(points) < 2:
            continue

        length_m, cumulative_lengths = corridor_length(points)
        corridors.append({
            "handle": corridor_index + 1,
            "id": way.get("id", str(corridor_index + 1)),
            "from": tags.get("from", ""),
            "to": tags.get("to", ""),
            "points": points,
            "length_m": length_m,
            "cumulative_lengths": cumulative_lengths,
        })

    if not corridors:
        print("no corridor=air ways found", file=sys.stderr)
        return 2

    random.seed(args.seed)
    drones = []
    for index in range(args.drones):
        corridor = corridors[index % len(corridors)]
        drones.append({
            "handle": index + 1,
            "id": f"D{index + 1}",
            "vehicle_type": "quadrotor",
            "vehicle_type_code": 1,
            "corridor_handle": corridor["handle"],
            "offset_m": (corridor["length_m"] * ((index * 37) % max(args.drones, 1))) / max(args.drones, 1),
            "speed_mps": args.speed + (index % 7) * 0.8,
            "noise_seed": random.random() * 10_000.0,
        })

    payload = {
        "projection": {
            "originLat": origin_lat,
            "originLon": origin_lon,
            "metersPerDegreeLat": METERS_PER_DEGREE_LAT,
            "metersPerDegreeLon": meters_per_degree_lon,
        },
        "noise_m": args.noise,
        "corridors": corridors,
        "drones": drones,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {args.output} with {len(corridors)} corridors and {len(drones)} drones")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
