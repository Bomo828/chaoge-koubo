#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import json
import math
import re
from collections import Counter
from pathlib import Path


def load_planner(source_file: Path):
    tree = ast.parse(source_file.read_text("utf-8"))
    function = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "viral_pulse_caption_plan"
    )
    namespace = {
        "Any": object,
        "math": math,
        "re": re,
        "kinetic_keyword": lambda text: (re.sub(r"\s+", "", text)[:4] or ""),
    }
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source_file), "exec"), namespace)
    return namespace["viral_pulse_caption_plan"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("timeline", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    planner = load_planner(root / "main.py")
    timeline = json.loads(args.timeline.read_text("utf-8"))
    captions = planner(timeline.get("captions") or [])
    result = {
        "source": str(args.timeline.resolve()),
        "duration": timeline.get("duration"),
        "node_counts": dict(Counter(str(item.get("contentNode")) for item in captions)),
        "nodes": [
            {
                "start": item.get("start"),
                "end": item.get("end"),
                "text": item.get("text"),
                "content_node": item.get("contentNode"),
                "caption_material": (item.get("materialRoute") or {}).get("caption"),
                "camera_material": (item.get("materialRoute") or {}).get("camera"),
                "sfx_material": (item.get("materialRoute") or {}).get("sfx"),
                "transition_material": (item.get("materialRoute") or {}).get("transition"),
            }
            for item in captions
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps(result["node_counts"], ensure_ascii=False))


if __name__ == "__main__":
    main()
