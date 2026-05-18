#!/usr/bin/env python3
"""Generate simulator-style mock telemetry data from frontend air-route OSM."""

import argparse
import json
import math
import random
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

METERS_PER_DEGREE_LAT = 111_320.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate mock telemetry route/drone data.")
    parser.add_argument("--route", type=Path, default=Path("public/data/map/air_route.osm"), help="Input air-route OSM.")
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


def route_length(points: list[dict[str, float]]) -> tuple[float, list[float]]:
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
    if not args.route.exists():
        print(f"route file not found: {args.route}", file=sys.stderr)
        return 2

    tree = ET.parse(args.route)
    root = tree.getroot()
    node_elems = {node.get("id"): node for node in root.findall("node") if node.get("id")}
    lats = [parse_float(node.get("lat")) for node in node_elems.values()]
    lons = [parse_float(node.get("lon")) for node in node_elems.values()]
    if not lats or not lons:
        print("route OSM has no node coordinates", file=sys.stderr)
        return 2

    origin_lat = min(lats)
    origin_lon = min(lons)
    mid_lat = (min(lats) + max(lats)) / 2.0
    meters_per_degree_lon = METERS_PER_DEGREE_LAT * max(math.cos(math.radians(mid_lat)), 1e-6)

    routes = []
    for route_index, way in enumerate(root.findall("way")):
        tags = osm_tags(way)
        if tags.get("route") != "air":
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

        length_m, cumulative_lengths = route_length(points)
        routes.append({
            "handle": route_index + 1,
            "id": way.get("id", str(route_index + 1)),
            "from": tags.get("from", ""),
            "to": tags.get("to", ""),
            "points": points,
            "length_m": length_m,
            "cumulative_lengths": cumulative_lengths,
        })

    if not routes:
        print("no route=air ways found", file=sys.stderr)
        return 2

    random.seed(args.seed)
    drones = []
    for index in range(args.drones):
        route = routes[index % len(routes)]
        drones.append({
            "handle": index + 1,
            "id": f"D{index + 1}",
            "vehicle_type": "quadrotor",
            "vehicle_type_code": 1,
            "route_handle": route["handle"],
            "offset_m": (route["length_m"] * ((index * 37) % max(args.drones, 1))) / max(args.drones, 1),
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
        "routes": routes,
        "drones": drones,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {args.output} with {len(routes)} routes and {len(drones)} drones")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
