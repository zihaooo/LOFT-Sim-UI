#!/usr/bin/env python3
"""Generate simulator-style mock telemetry data from the frontend airspace-network OSM.

Mirrors the frontend's route extraction (`src/data/routes.ts`): routes are OSM relations
tagged `object_type=route` whose member ways are stitched, in member order, into one
polyline. The route `id` is taken from the `object_id` tag so it matches the ids the
frontend derives in `parseRoutes` -- that match is what lets the telemetry source resolve
each drone's route color and label.

Corridors (the `airspace=yes` ways the routes are stitched from) are emitted alongside,
their id taken from the `object_id` tag -- matching how the frontend ids corridors in
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
    parser = argparse.ArgumentParser(
        description="Generate mock telemetry route/drone data."
    )
    parser.add_argument(
        "--network",
        type=Path,
        default=Path("public/data/network/airspace_network.osm"),
        help="Input airspace-network OSM.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("mock/mock_telemetry.json"),
        help="Output JSON path.",
    )
    parser.add_argument(
        "--drones", type=int, default=200, help="Number of mock drones."
    )
    parser.add_argument(
        "--speed", type=float, default=28.0, help="Base mock speed in m/s."
    )
    parser.add_argument(
        "--noise", type=float, default=0.0, help="Position noise amplitude in meters."
    )
    parser.add_argument(
        "--seed", type=int, default=7, help="Deterministic random seed."
    )
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


def group_routes_by_shared_corridor(routes: list[dict]) -> list[int]:
    """Assign each route a group id so that any two routes sharing a corridor land in the same group.

    Where two routes ride the same physical corridor (a merge or diverge), their drones must share a
    speed -- otherwise a faster type catches and passes through a slower one on that shared segment.
    Routes are unioned over shared corridor handles, so transitive sharing (A-B, B-C) collapses A, B
    and C into one group. Returns a parallel list whose entries are group ids; each id is the index
    of the lowest-indexed route in the group, so ids are stable and independent of iteration order."""
    parent = list(range(len(routes)))

    def find(node: int) -> int:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(a: int, b: int) -> None:
        root_a, root_b = find(a), find(b)
        if root_a != root_b:
            # Keep the lower index as root so group ids are the smallest member index.
            parent[max(root_a, root_b)] = min(root_a, root_b)

    # handle 0 marks a segment with no registered corridor, so it never ties routes together.
    corridor_sets = [
        {handle for handle in route["corridor_handles"] if handle} for route in routes
    ]
    for i in range(len(routes)):
        for j in range(i + 1, len(routes)):
            if corridor_sets[i] & corridor_sets[j]:
                union(i, j)

    return [find(i) for i in range(len(routes))]


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
    node_elems = {
        node.get("id"): node for node in root.findall("node") if node.get("id")
    }
    lats = [parse_float(node.get("lat")) for node in node_elems.values()]
    lons = [parse_float(node.get("lon")) for node in node_elems.values()]
    if not lats or not lons:
        print("network OSM has no node coordinates", file=sys.stderr)
        return 2

    origin_lat = min(lats)
    origin_lon = min(lons)
    mid_lat = (min(lats) + max(lats)) / 2.0
    meters_per_degree_lon = METERS_PER_DEGREE_LAT * max(
        math.cos(math.radians(mid_lat)), 1e-6
    )

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
        # Id from the `object_id` tag so it matches parseAirCorridors; fall back to way.id when absent.
        corridors.append(
            {
                "handle": handle,
                "id": tags.get("object_id") or way_id,
                "from": tags.get("from", ""),
                "to": tags.get("to", ""),
            }
        )

    routes = []
    for relation in root.findall("relation"):
        tags = osm_tags(relation)
        if tags.get("object_type") != ROUTE_OBJECT_TYPE:
            continue

        members = [
            (
                way_node_refs.get(member.get("ref"), []),
                corridor_handle_by_way.get(member.get("ref"), 0),
            )
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
        # Id from the `object_id` tag so it matches parseRoutes; fall back to the relation id when absent.
        route_id = tags.get("object_id") or relation.get("id", str(len(routes) + 1))
        routes.append(
            {
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
            }
        )

    if not corridors:
        print("no airspace=yes corridor ways found", file=sys.stderr)
        return 2
    if not routes:
        print("no object_type=route relations found", file=sys.stderr)
        return 2

    # Every route that shares a corridor with another runs the same vehicle type, so drones on a
    # shared segment move at one speed and never pass through each other; within a route, uniform
    # speed plus even arc-length spacing keeps same-route drones apart too. Each connected group of
    # routes gets a type, cycling so all three vehicle models still appear across the network.
    # (Known residual: same-speed drones from two routes can still briefly fly coincident where the
    # routes merge -- a same-model close-formation pass, not a different-speed pass-through. Fully
    # removing it needs altitude separation, which the route-derived telemetry positions can't carry.)
    vehicle_types = [("quadrotor", 1), ("fixed_wing", 2), ("hybrid", 3)]
    # Per-type cruise-speed multipliers on --speed, ordered for realism:
    # quadrotor (slowest) < hybrid (baseline) < fixed_wing (fastest).
    speed_coef_by_type_code = {1: 0.6, 2: 1.6, 3: 1.0}

    route_groups = group_routes_by_shared_corridor(routes)
    # Number each group by first appearance (lowest route index) so the type cycle is deterministic.
    group_position: dict[int, int] = {}
    for group_id in route_groups:
        group_position.setdefault(group_id, len(group_position))
    vehicle_type_by_route_index = [
        vehicle_types[group_position[group_id] % len(vehicle_types)]
        for group_id in route_groups
    ]

    # Round-robin drones onto routes, recording each drone's slot within its route for even spacing.
    route_of_drone: list[int] = []
    slot_of_drone: list[int] = []
    drones_on_route = [0] * len(routes)
    for index in range(args.drones):
        route_index = index % len(routes)
        route_of_drone.append(route_index)
        slot_of_drone.append(drones_on_route[route_index])
        drones_on_route[route_index] += 1

    random.seed(args.seed)
    drones = []
    for index in range(args.drones):
        route_index = route_of_drone[index]
        route = routes[route_index]
        vehicle_type, vehicle_type_code = vehicle_type_by_route_index[route_index]
        # drones_on_route[route_index] >= 1 for any route that received a drone, so this never divides by 0.
        spacing_m = route["length_m"] / drones_on_route[route_index]
        # A distinct per-route phase (< one spacing, so spacing stays even) keeps routes that share a
        # start hub from stacking their first drones at offset 0 at t=0.
        phase_m = (route_index / len(routes)) * spacing_m
        drones.append(
            {
                "handle": index + 1,
                "id": f"D{index + 1}",
                "vehicle_type": vehicle_type,
                "vehicle_type_code": vehicle_type_code,
                "route_handle": route["handle"],
                "offset_m": phase_m + slot_of_drone[index] * spacing_m,
                "speed_mps": args.speed
                * speed_coef_by_type_code.get(vehicle_type_code, 1.0),
                "noise_seed": random.random() * 10_000.0,
            }
        )

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
    print(
        f"wrote {args.output} with {len(corridors)} corridors, {len(routes)} routes and {len(drones)} drones"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
