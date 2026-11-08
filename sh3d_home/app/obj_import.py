"""Import a Sweet Home 3D OBJ export as a textured visual layer.

The .obj file produced by Sweet Home 3D has one ``g`` group per wall / room
surface / furniture part and a companion .mtl file with textures.  The OBJ is
kept as a visual mesh; room/entity semantics continue to come from the paired
.sh3d home so the configurator and entity mappings keep working.
"""
from __future__ import annotations

import json
import math
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any

from . import sh3d as sh3d_mod


def _point_in_poly(x: float, y: float, points: list[list[float]]) -> bool:
    inside = False
    n = len(points)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = points[i]
        xj, yj = points[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi):
            inside = not inside
        j = i
    return inside


def _room_for(scene: dict[str, Any], x: float, y: float, level: str, threshold: float = 1e12) -> str | None:
    for room in scene.get("rooms", []):
        if room.get("level") == level and _point_in_poly(x, y, room.get("points", [])):
            return room["id"]
    best = None
    best_d = threshold
    for room in scene.get("rooms", []):
        if room.get("level") != level:
            continue
        cx, cy = room.get("center", [0, 0])
        d = (cx - x) ** 2 + (cy - y) ** 2
        if d < best_d:
            best_d = d
            best = room["id"]
    return best


def _level_for(scene: dict[str, Any], z: float) -> str:
    levels = scene.get("levels", [])
    if not levels:
        return "level-0"
    # OBJ's vertical axis starts at 0 for the exported floor. A ceiling at
    # 250 cm still belongs to the ground floor, not to the storey at 262 cm.
    below = [l for l in levels if float(l.get("elevation", 0)) <= z + 2]
    best = max(below, key=lambda l: float(l.get("elevation", 0))) if below else min(levels, key=lambda l: float(l.get("elevation", 0)))
    return best["id"]


def _level_elevation(scene: dict[str, Any], level_id: str) -> float:
    for level in scene.get("levels", []):
        if level.get("id") == level_id:
            return float(level.get("elevation", 0))
    return 0.0


def extract_zip(source: Path, target: Path) -> Path:
    """Extract an OBJ package and return its asset root."""
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as archive:
        for info in archive.infolist():
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or ".." in Path(name).parts or info.is_dir():
                continue
            dest = (target / name).resolve()
            if target.resolve() not in dest.parents:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, dest.open("wb") as out:
                shutil.copyfileobj(src, out, 1024 * 512)
    return target


def parse_obj(obj_path: Path, scene: dict[str, Any]) -> dict[str, Any]:
    vertices: list[tuple[float, float, float]] = []
    groups: dict[str, dict[str, Any]] = {}
    current = None
    current_material = ""
    with obj_path.open(errors="ignore") as handle:
        for line in handle:
            if line.startswith("v "):
                try:
                    _, x, y, z = line.split()[:4]
                    vertices.append((float(x), float(y), float(z)))
                except ValueError:
                    continue
            elif line.startswith("g "):
                name = line[2:].strip() or f"group_{len(groups)}"
                current = groups.setdefault(name, {"name": name, "materials": set(), "verts": set(), "faces": 0})
            elif line.startswith("usemtl "):
                current_material = line[7:].strip()
                if current is not None:
                    current["materials"].add(current_material)
            elif line.startswith("f ") and current is not None:
                current["faces"] += 1
                for token in line.split()[1:]:
                    try:
                        index = int(token.split("/")[0])
                    except ValueError:
                        continue
                    if index < 0:
                        index = len(vertices) + index + 1
                    if 1 <= index <= len(vertices):
                        current["verts"].add(index - 1)

    def kind_for(name: str, materials: set[str], miny: float, level: str) -> str:
        text = (name + " " + " ".join(sorted(materials))).lower()
        if name.startswith("wall_"):
            return "wall"
        if name.startswith("ground"):
            return "ground"
        if name.startswith("room_"):
            return "floor" if miny <= _level_elevation(scene, level) + 5 else "ceiling"
        if any(w in text for w in ("window", "fenster")):
            return "window"
        if any(w in text for w in ("door", "tür", "tuer")):
            return "door"
        if any(w in text for w in ("light", "lamp", "bulb", "leuchte")):
            return "light"
        if any(w in text for w in ("speaker", "lautsprecher", "sonos", "audio")):
            return "speaker"
        if any(w in text for w in ("heiz", "radiator", "thermostat")):
            return "heating"
        if any(w in text for w in ("tv", "monitor", "display", "screen", "fernseh")):
            return "display"
        return "furniture"

    meta_groups: list[dict[str, Any]] = []
    objects: list[dict[str, Any]] = []
    bounds = {"minX": math.inf, "minY": math.inf, "minZ": math.inf, "maxX": -math.inf, "maxY": -math.inf, "maxZ": -math.inf}
    for g in groups.values():
        if not g["verts"]:
            continue
        pts = [vertices[i] for i in g["verts"]]
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]; zs = [p[2] for p in pts]
        minx, maxx = min(xs), max(xs); miny, maxy = min(ys), max(ys); minz, maxz = min(zs), max(zs)
        cx, cy, cz = (minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2
        for key, val in (("minX", minx), ("maxX", maxx), ("minY", miny), ("maxY", maxy), ("minZ", minz), ("maxZ", maxz)):
            if key.startswith("min"):
                bounds[key] = min(bounds[key], val)
            else:
                bounds[key] = max(bounds[key], val)
        level = _level_for(scene, miny)
        kind = kind_for(g["name"], g["materials"], miny, level)
        room = _room_for(scene, cx, cz, level)
        meta = {
            "name": g["name"], "kind": kind, "level": level, "room": room,
            "center": [round(cx, 2), round(cy, 2), round(cz, 2)],
            "bbox": {"minX": round(minx, 2), "maxX": round(maxx, 2), "minY": round(miny, 2),
                     "maxY": round(maxy, 2), "minZ": round(minz, 2), "maxZ": round(maxz, 2)},
            "materials": sorted(g["materials"]), "faces": g["faces"],
        }
        meta_groups.append(meta)
        if kind in ("wall", "ground", "floor", "ceiling"):
            continue
        obj_id = "obj:" + re.sub(r"[^a-zA-Z0-9_.-]", "_", g["name"])
        objects.append({
            "id": obj_id, "kind": kind, "name": g["name"], "catalog": "", "level": level,
            "room": room, "x": round(cx, 2), "y": round(cz, 2),
            "elevation": round(miny, 2), "angle": 0.0,
            "width": round(max(4.0, maxx - minx), 2), "depth": round(max(4.0, maxz - minz), 2),
            "height": round(max(4.0, maxy - miny), 2), "model": None, "modelKind": "box",
            "mtl": None, "color": "#c9bea9", "modelRotation": None, "mirrored": False,
            "power": None, "tags": [kind], "bbox": meta["bbox"], "extra": {"objGroup": g["name"]},
            "objGroup": g["name"],
        })

    # Keep room polygons for floors from the paired .sh3d; if an OBJ room group
    # has no scene room, create a simple room from its bounding box.
    obj_rooms = []
    for meta in meta_groups:
        if meta["kind"] not in ("floor", "ceiling"):
            continue
        room = next((r for r in scene.get("rooms", []) if r["id"] == meta["room"]), None)
        if room and not any(r["id"] == room["id"] for r in obj_rooms):
            obj_rooms.append(room)
    if not obj_rooms:
        for meta in meta_groups:
            if meta["kind"] != "floor":
                continue
            b = meta["bbox"]
            obj_rooms.append({
                "id": "objroom-" + re.sub(r"\W", "_", meta["name"]),
                "name": "Raum " + meta["name"].split("_")[1] if "_" in meta["name"] else meta["name"],
                "level": meta["level"],
                "points": [[b["minX"], b["minZ"]], [b["maxX"], b["minZ"]], [b["maxX"], b["maxZ"]], [b["minX"], b["maxZ"]]],
                "center": [meta["center"][0], meta["center"][2]], "area": 0.0,
            })

    b = {k: round(v, 2) for k, v in bounds.items() if math.isfinite(v)}
    b["width"] = round(b.get("maxX", 0) - b.get("minX", 0), 2)
    b["depth"] = round(b.get("maxZ", 0) - b.get("minZ", 0), 2)
    return {
        "groups": meta_groups,
        "objects": objects,
        "rooms": obj_rooms,
        "bounds": b,
    }


def import_obj_zip(source: Path, model_folder: Path, scene: dict[str, Any], display_name: str | None = None) -> dict[str, Any]:
    root = model_folder / "assets" / "obj"
    if root.exists():
        shutil.rmtree(root)
    extract_zip(source, root)
    obj_files = list(root.rglob("*.obj"))
    if not obj_files:
        raise ValueError("Im ZIP fehlt eine .obj-Datei.")
    obj_path = obj_files[0]
    mtl_path = next(iter(obj_path.parent.glob("*.mtl")), None)
    parsed = parse_obj(obj_path, scene)
    if not parsed["bounds"]:
        raise ValueError("Die OBJ-Datei enthält keine gültigen Vertices.")
    assets_root = model_folder / "assets"
    rel_obj = obj_path.relative_to(assets_root).as_posix()
    rel_mtl = mtl_path.relative_to(assets_root).as_posix() if mtl_path else None
    parsed["objFile"] = rel_obj
    parsed["mtlFile"] = rel_mtl
    parsed["base"] = obj_path.parent.relative_to(assets_root).as_posix() + "/"
    parsed["name"] = display_name or obj_path.stem
    parsed["importedAt"] = None
    return parsed
