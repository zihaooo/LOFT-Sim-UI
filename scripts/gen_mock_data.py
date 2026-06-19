#!/usr/bin/env python3
"""Generate simulator-style mock telemetry data from the frontend airspace-network OSM.

Mirrors the frontend's route extraction (`src/data/routes.ts`): routes are OSM relations
tagged `object_type=route` whose member ways are stitched, in member order, into one
polyline. The route `id` is taken from the `object_id` tag so it matches the ids the
frontend derives in `parseRoutes` -- that match is what lets the telemetry source resolve
each drone's route color and label.

Corridors (the `airspace=yes` ways the routes are stitched from) are emitted alongside,
keyed by handle to their `way.id` -- matching how the frontend ids corridors in
`parseAirCorridors`. Each route also records, per segment, the handle of the corridor that
segment came from, so the websocket server can report the corridor a drone is currently on
as it advances along its route.

Points are emitted in the simulator coordinate frame (x=east, y=north, z=altitude). The
frontend reprojects them through the `projection` block, so only the route/corridor ids
need to line up with the rendered scene, not the raw geometry.
"""

import argparse
import json
import math
import random
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

METERS_PER_DEGREE_LAT = 111_320.0
ROUTE_OBJECT_TYPE = "route"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate mock telemetry route/drone data.")
    parser.add_argument("--network", type=Path, default=Path("public/data/network/airspace_network.osm"), help="Input airspace-network OSM.")
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


def polyline_length(points: list[dict[str, float]]) -> tuple[float, list[float]]:
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


def merge_route_members(
    members: list[tuple[list[str], int]],
) -> tuple[list[str], list[int]]:
    """Concatenate member ways' node refs in order, dropping the duplicated shared node at each
    seam so it does not produce a zero-length segment (mirrors `mergeWayNodeRefs` in routes.ts).
    Returns the merged node refs plus a parallel list giving, for each node, the handle of the
    corridor (member way) that contributed it -- so a node's handle defines the segment ending at
    it."""
    merged: list[str] = []
    node_handles: list[int] = []
    for refs, corridor_handle in members:
        if merged and refs and merged[-1] == refs[0]:
            refs = refs[1:]
        for ref in refs:
            merged.append(ref)
            node_handles.append(corridor_handle)
    return merged, node_handles


def main() -> int:
    args = parse_args()
    if args.drones < 0:
        print("--drones must be >= 0", file=sys.stderr)
        return 2
    if not args.network.exists():
        print(f"network file not found: {args.network}", file=sys.stderr)
        return 2

    tree = ET.parse(args.network)
    root = tree.getroot()
    node_elems = {node.get("id"): node for node in root.findall("node") if node.get("id")}
    lats = [parse_float(node.get("lat")) for node in node_elems.values()]
    lons = [parse_float(node.get("lon")) for node in node_elems.values()]
    if not lats or not lons:
        print("network OSM has no node coordinates", file=sys.stderr)
        return 2

    origin_lat = min(lats)
    origin_lon = min(lons)
    mid_lat = (min(lats) + max(lats)) / 2.0
    meters_per_degree_lon = METERS_PER_DEGREE_LAT * max(math.cos(math.radians(mid_lat)), 1e-6)

    # ref-ordered node lists per way, so route members can be stitched in member order below.
    way_node_refs = {
        way.get("id"): [nd.get("ref") for nd in way.findall("nd") if nd.get("ref")]
        for way in root.findall("way")
        if way.get("id")
    }

    def project(node: ET.Element) -> dict[str, float]:
        node_tags = osm_tags(node)
        lat = parse_float(node.get("lat"))
        lon = parse_float(node.get("lon"))
        return {
            "x": (lon - origin_lon) * meters_per_degree_lon,
            "y": (lat - origin_lat) * METERS_PER_DEGREE_LAT,
            "z": parse_float(node_tags.get("altitude")),
        }

    # Corridors are the airspace=yes ways routes are built from; the frontend ids them by way.id
    # (parseAirCorridors), so the registry handle->id map must use way.id too.
    corridors = []
    corridor_handle_by_way = {}
    for way in root.findall("way"):
        tags = osm_tags(way)
        way_id = way.get("id")
        if tags.get("airspace") != "yes" or not way_id:
            continue
        if sum(1 for ref in way_node_refs.get(way_id, []) if ref in node_elems) < 2:
            continue
        handle = len(corridors) + 1
        corridor_handle_by_way[way_id] = handle
        corridors.append({
            "handle": handle,
            "id": way_id,
            "from": tags.get("from", ""),
            "to": tags.get("to", ""),
        })

    routes = []
    for relation in root.findall("relation"):
        tags = osm_tags(relation)
        if tags.get("object_type") != ROUTE_OBJECT_TYPE:
            continue

        members = [
            (way_node_refs.get(member.get("ref"), []), corridor_handle_by_way.get(member.get("ref"), 0))
            for member in relation.findall("member")
            if member.get("type") == "way"
        ]
        node_refs, node_handles = merge_route_members(members)
        points = []
        point_handles = []
        for ref, handle in zip(node_refs, node_handles):
            node = node_elems.get(ref)
            if node is None:
                continue
            points.append(project(node))
            point_handles.append(handle)

        if len(points) < 2:
            continue

        length_m, cumulative_lengths = polyline_length(points)
        # Prefer the stable, human-meaningful `object_id` (e.g. "route1") over the OSM relation
        # id, matching the id the frontend derives in parseRoutes so telemetry lookups resolve.
        route_id = tags.get("object_id") or relation.get("id", str(len(routes) + 1))
        routes.append({
            "handle": len(routes) + 1,
            "id": route_id,
            "from": tags.get("from", ""),
            "to": tags.get("to", ""),
            "points": points,
            "length_m": length_m,
            "cumulative_lengths": cumulative_lengths,
            # Per-segment corridor handle (length == segments == points - 1): a node's handle is the
            # corridor that contributed it, so the segment ending at point[i+1] uses point_handles[i+1].
            "corridor_handles": point_handles[1:],
        })

    if not corridors:
        print("no airspace=yes corridor ways found", file=sys.stderr)
        return 2
    if not routes:
        print("no object_type=route relations found", file=sys.stderr)
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
        "corridors": corridors,
        "routes": routes,
        "drones": drones,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {args.output} with {len(corridors)} corridors, {len(routes)} routes and {len(drones)} drones")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
