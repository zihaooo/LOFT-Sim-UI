#!/usr/bin/env python3
"""
Remove all elements marked with action="delete" from an OSM file.

Example:
  python scripts/clean_osm.py -i asset/map/map.osm -o asset/map/map.clean.osm
"""

import argparse
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Strip action=\"delete\" elements from an OSM file.")
    p.add_argument("-i", "--input", required=True, type=Path, help="Input OSM file.")
    p.add_argument("-o", "--output", required=True, type=Path, help="Output OSM file.")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    if not args.input.exists():
        print(f"input not found: {args.input}", file=sys.stderr)
        return 2

    tree = ET.parse(args.input)
    root = tree.getroot()

    removed = 0
    for elem in list(root):
        if elem.get("action") == "delete":
            root.remove(elem)
            removed += 1

    tree.write(args.output, encoding="UTF-8", xml_declaration=True)
    print(f"removed {removed} element(s); wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
