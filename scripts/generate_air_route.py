#!/usr/bin/env python3
"""
Generate an air-route OSM file with one way that linearly interpolates
between a start point and an end point.

Output format mirrors asset/map/air_route.osm:
  - Each waypoint is a <node> with a negative id (-1, -2, ...).
  - Start and end nodes get tag elevation="0".
  - Middle nodes get tag elevation="<-z>".
  - All nodes are joined by one <way> with tag route="air".

Example:
  python scripts/generate_air_route.py \
      -i asset/map/map.osm \
      -s -83.7129025,42.2929580 \
      -e -83.7032924,42.2985581 \
      -n 9 -z 60 \
      -o air_route.out.osm
"""

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def lng_lat(value: str) -> tuple[float, float]:
    try:
        lng_s, lat_s = value.split(",")
        return float(lng_s), float(lat_s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected 'lng,lat', got {value!r}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate an air-route OSM file.")
    # Allow values like "-83.71,42.29" after -s/-e: argparse's default negative-
    # number regex rejects them because of the comma, then treats them as flags.
    p._negative_number_matcher = re.compile(r"^-?\d+(\.\d+)?(,-?\d+(\.\d+)?)?$")
    p.add_argument("-i", "--input", required=True, type=Path, help="Input map.osm path.")
    p.add_argument("-s", "--start", required=True, type=lng_lat, help="Start 'lng,lat'.")
    p.add_argument("-e", "--end", required=True, type=lng_lat, help="End 'lng,lat'.")
    p.add_argument("-n", "--num", required=True, type=int, help="Number of middle waypoints (>= 0).")
    p.add_argument("-z", "--elevation", required=True, type=float, help="Elevation for middle nodes.")
    p.add_argument("-o", "--output", required=True, type=Path, help="Output OSM file.")
    return p.parse_args()


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def fmt_elev(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


def next_negative_id(root: ET.Element, tag: str) -> int:
    ids = []
    for e in root.findall(tag):
        try:
            ids.append(int(e.get("id", "0")))
        except ValueError:
            continue
    floor = min(ids) if ids else 0
    return min(floor, 0) - 1


def append_route(root, start, end, middle, elevation, first_node_id, way_id):
    if middle < 0:
        raise ValueError("--num must be >= 0")

    s_lng, s_lat = start
    e_lng, e_lat = end
    n_total = middle + 2
    node_ids = []

    for i in range(n_total):
        nid = first_node_id - i
        node_ids.append(nid)
        t = i / (n_total - 1)
        lng = lerp(s_lng, e_lng, t)
        lat = lerp(s_lat, e_lat, t)
        is_endpoint = i == 0 or i == n_total - 1
        elev = 0 if is_endpoint else elevation

        node = ET.SubElement(root, "node", {
            "id": str(nid),
            "lat": f"{lat:.7f}",
            "lon": f"{lng:.7f}",
            "version": "1",
        })
        ET.SubElement(node, "tag", {"k": "elevation", "v": fmt_elev(elev)})

    way = ET.SubElement(root, "way", {"id": str(way_id), "version": "1"})
    for nid in node_ids:
        ET.SubElement(way, "nd", {"ref": str(nid)})
    ET.SubElement(way, "tag", {"k": "route", "v": "air"})


def indent(elem, level=0):
    pad = "\n" + "  " * level
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = pad + "  "
        for child in elem:
            indent(child, level + 1)
        if not child.tail or not child.tail.strip():
            child.tail = pad
    if level and (not elem.tail or not elem.tail.strip()):
        elem.tail = pad


def main() -> int:
    args = parse_args()

    protected = {
        Path("asset/map/air_route.osm").resolve(),
        Path("asset/map/map.osm").resolve(),
        args.input.resolve(),
    }
    if args.output.resolve() in protected:
        print(f"refusing to overwrite protected file: {args.output}", file=sys.stderr)
        return 2

    if not args.input.exists():
        print(f"input map not found: {args.input}", file=sys.stderr)
        return 2

    if args.output.exists():
        tree = ET.parse(args.output)
        root = tree.getroot()
    else:
        root = ET.Element("osm", {"version": "0.6", "generator": "generate_air_route.py"})
        tree = ET.ElementTree(root)

    first_node_id = next_negative_id(root, "node")
    way_id = next_negative_id(root, "way")
    append_route(root, args.start, args.end, args.num, args.elevation, first_node_id, way_id)

    indent(root)
    tree.write(args.output, encoding="UTF-8", xml_declaration=True)
    print(f"wrote {args.output} (nodes start at {first_node_id}, way id {way_id})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
