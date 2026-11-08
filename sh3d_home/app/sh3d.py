"""Sweet Home 3D .sh3d importer.

An .sh3d file is a ZIP archive containing Home.xml, 3D models, textures and
preview images.  This module extracts it and turns the subset of the Home.xml
data that is useful for a live floor plan into compact JSON for the browser.
No Java / Sweet Home 3D installation is required.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree as ET

CM = 1.0


def _f(node: ET.Element, key: str, default: float = 0.0) -> float:
    try:
        return float(node.get(key, default))
    except (TypeError, ValueError):
        return default


def _b(node: ET.Element, key: str, default: bool = False) -> bool:
    value = node.get(key)
    if value is None:
        return default
    return value.lower() in ("true", "1", "yes")


def _color(value: str | None, fallback: str) -> str:
    if not value:
        return fallback
    value = value.strip().lstrip("#")
    if len(value) == 8:  # SH3D stores ARGB
        value = value[-6:]
    if re.fullmatch(r"[0-9a-fA-F]{6}", value):
        return "#" + value.lower()
    return fallback


def _norm(text: str) -> str:
    return (text or "").lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")


def _point_in_poly(x: float, y: float, points: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(points)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = points[i]
        xj, yj = points[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _poly_area(points: list[tuple[float, float]]) -> float:
    if len(points) < 3:
        return 0.0
    return abs(sum(points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1] for i in range(len(points)))) / 2.0


def _poly_centroid(points: list[tuple[float, float]]) -> tuple[float, float]:
    if not points:
        return (0.0, 0.0)
    a = 0.0
    cx = cy = 0.0
    n = len(points)
    for i in range(n):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % n]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-9:
        return (sum(p[0] for p in points) / n, sum(p[1] for p in points) / n)
    return (cx / (3 * a), cy / (3 * a))


@dataclass
class Level:
    id: str
    name: str
    elevation: float
    height: float
    floor_thickness: float = 12.0
    visible: bool = True


@dataclass
class Room:
    id: str
    name: str
    level: str
    points: list[tuple[float, float]]
    center: tuple[float, float]
    area_m2: float


@dataclass
class SceneObject:
    id: str
    kind: str
    name: str
    catalog: str
    level: str
    x: float
    y: float
    elevation: float
    angle: float
    width: float
    depth: float
    height: float
    model: str | None
    model_kind: str = "box"
    mtl: str | None = None
    color: str = "#d8d1c4"
    model_rotation: str | None = None
    mirrored: bool = False
    power: float | None = None
    room: str | None = None
    tags: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    def bbox(self) -> dict[str, float]:
        # A conservative plan bounding box (the renderer uses the actual model
        # bounding box after loading, this is only for hit testing / labels).
        return {
            "minX": self.x - self.width / 2,
            "maxX": self.x + self.width / 2,
            "minY": self.y - self.depth / 2,
            "maxY": self.y + self.depth / 2,
            "minZ": self.elevation,
            "maxZ": self.elevation + self.height,
        }


@dataclass
class WallPiece:
    x1: float
    y1: float
    x2: float
    y2: float
    z0: float
    z1: float
    thickness: float
    kind: str = "wall"


def _classify(tag: str, name: str, catalog: str, height: float, width: float, depth: float) -> tuple[str, list[str]]:
    text = _norm(f"{name} {catalog}")
    if tag == "light":
        return "light", ["light"]
    if tag == "doorOrWindow":
        if any(k in text for k in ("fenster", "window", "verglasung", "glass")):
            if any(k in text for k in ("tuer", "door")):
                return "door", ["opening", "door"]
            return "window", ["opening", "window"]
        if any(k in text for k in ("tuer", "door", "tor", "gate")):
            return "door", ["opening", "door"]
        return ("window" if height < 170 else "door"), ["opening"]
    if any(k in text for k in ("heizkoerper", "heizung", "radiator", "thermostat", "heizthermostat", "fussbodenheizung")):
        return "heating", ["climate", "heating"]
    if any(k in text for k in ("lautsprecher", "speaker", "sonos", "soundbar", "stereo", "verstaerker", "amplifier", "audio")):
        return "speaker", ["audio", "speaker"]
    if any(k in text for k in ("monitor", "bildschirm", "display", "screen", "fernseher", "tv", "beamer")):
        return "display", ["display", "screen"]
    if any(k in text for k in ("pc-turm", "pc tower", "computer", "rechner", "desktop", "notebook", "laptop")):
        return "computer", ["compute"]
    if any(k in text for k in ("tisch", "table", "stuhl", "chair", "sofa", "couch", "bett", "bed", "schrank", "wardrobe", "regal", "shelf")):
        return "furniture", ["furniture"]
    return "furniture", ["furniture"]


def _model_info(model: str | None, home_dir: Path, names: set[str]) -> tuple[str | None, str, str | None]:
    """Return (asset relative path, model kind, mtl relative path)."""
    if not model:
        return None, "box", None
    model = model.strip().replace("\\", "/")
    if model.startswith("/") or ".." in model.split("/"):
        return None, "box", None
    if model not in names:
        return None, "box", None
    path = home_dir / model
    if not path.exists() or not path.is_file():
        return None, "box", None
    low = model.lower()
    if low.endswith(".obj"):
        # Find the material library declared in the OBJ or next to it.
        mtl: str | None = None
        try:
            head = path.read_text(errors="ignore")[:200000]
            m = re.search(r"^mtllib\s+(.+?)\s*$", head, re.M)
            if m:
                candidate = (path.parent / m.group(1).strip()).relative_to(home_dir).as_posix()
                if (home_dir / candidate).exists():
                    mtl = candidate
            if mtl is None:
                sibling = path.with_suffix(".mtl")
                if sibling.exists():
                    mtl = sibling.relative_to(home_dir).as_posix()
        except OSError:
            pass
        return model, "obj", mtl
    if low.endswith((".dae", ".gltf", ".glb")):
        return model, low.rsplit(".", 1)[-1], None
    # Models stored without an extension are still OBJ text.
    try:
        with path.open("rb") as fh:
            head = fh.read(300)
        if head.startswith(b"#") or head.startswith(b"mtllib ") or b"\nv " in head or head.startswith(b"v "):
            mtl = None
            try:
                raw = path.read_text(errors="ignore")[:4000]
                m = re.search(r"^mtllib\s+(.+?)\s*$", raw, re.M)
                if m:
                    candidate = (path.parent / m.group(1).strip()).relative_to(home_dir).as_posix()
                    if (home_dir / candidate).exists():
                        mtl = candidate
            except (OSError, ValueError):
                pass
            return model, "obj", mtl
    except OSError:
        pass
    return None, "box", None


def _safe_extract(archive: zipfile.ZipFile, target: Path) -> set[str]:
    target.mkdir(parents=True, exist_ok=True)
    names: set[str] = set()
    for info in archive.infolist():
        name = info.filename.replace("\\", "/")
        # Ignore directory traversal and hidden metadata.
        if name.startswith("/") or ".." in Path(name).parts or not name:
            continue
        dest = (target / name).resolve()
        if target.resolve() not in dest.parents and dest != target.resolve():
            continue
        if info.is_dir():
            dest.mkdir(parents=True, exist_ok=True)
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(info) as src, dest.open("wb") as out:
            shutil.copyfileobj(src, out, 1024 * 512)
        names.add(name)
    return names


def _split_walls(walls: list[dict[str, Any]], openings: list[SceneObject], levels: dict[str, Level]) -> list[dict[str, Any]]:
    """Subtract door/window openings from walls and return box pieces.

    Each opening is assigned to the nearest wall only.  Without this, an
    opening close to a corner would cut a hole into both walls and make the
    visible wall dimensions wrong.
    """
    assigned: dict[str, list[tuple[float, float, float, float]]] = {w["id"]: [] for w in walls}
    for obj in openings:
        best: tuple[float, dict[str, Any], float] | None = None
        for wall in walls:
            if obj.level != wall["level"]:
                continue
            x1, y1, x2, y2 = wall["x1"], wall["y1"], wall["x2"], wall["y2"]
            length = math.hypot(x2 - x1, y2 - y1)
            if length < 0.5:
                continue
            ux, uy = (x2 - x1) / length, (y2 - y1) / length
            dx, dy = obj.x - x1, obj.y - y1
            t = dx * ux + dy * uy
            dist = abs(dx * uy - dy * ux)
            if t < -40 or t > length + 40:
                continue
            if dist > max(50.0, wall["thickness"] * 0.5 + 35.0):
                continue
            if best is None or dist < best[0]:
                best = (dist, wall, t)
        if best is None:
            continue
        _, wall, t_center = best
        length = math.hypot(wall["x2"] - wall["x1"], wall["y2"] - wall["y1"])
        half = max(12.0, obj.width / 2)
        t0 = max(0.0, min(length, t_center - half))
        t1 = max(0.0, min(length, t_center + half))
        if t1 <= t0:
            continue
        bottom = max(0.0, obj.elevation)
        top = min(wall["height"], obj.elevation + obj.height)
        if top - bottom >= 5:
            assigned[wall["id"]].append((t0, t1, bottom, top))

    result: list[dict[str, Any]] = []
    for wall in walls:
        x1, y1, x2, y2 = wall["x1"], wall["y1"], wall["x2"], wall["y2"]
        length = math.hypot(x2 - x1, y2 - y1)
        if length < 0.5:
            result.append({**{k: wall[k] for k in ("id", "level", "thickness", "height")},
                           "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                           "z0": 0.0, "z1": wall["height"]})
            continue
        ux, uy = (x2 - x1) / length, (y2 - y1) / length
        ops = sorted(assigned.get(wall["id"], []))
        cursor = 0.0
        for t0, t1, bottom, top in ops:
            if t1 <= cursor + 0.2:
                continue
            t0 = max(t0, cursor)
            if t0 > cursor + 0.3:
                result.append(_wall_piece(wall, x1, y1, ux, uy, cursor, t0, 0.0, wall["height"], "wall"))
            if bottom > 0.3:
                result.append(_wall_piece(wall, x1, y1, ux, uy, t0, t1, 0.0, bottom, "sill"))
            if top < wall["height"] - 0.3:
                result.append(_wall_piece(wall, x1, y1, ux, uy, t0, t1, top, wall["height"], "lintel"))
            cursor = max(cursor, t1)
        if cursor < length - 0.3:
            result.append(_wall_piece(wall, x1, y1, ux, uy, cursor, length, 0.0, wall["height"], "wall"))
        if not assigned.get(wall["id"]):
            # Keep a clean full wall for walls without openings.
            result.append(_wall_piece(wall, x1, y1, ux, uy, 0.0, length, 0.0, wall["height"], "wall"))
    return result


def _wall_piece(wall: dict[str, Any], x1: float, y1: float, ux: float, uy: float,
                t0: float, t1: float, z0: float, z1: float, kind: str) -> dict[str, Any]:
    return {
        "id": wall["id"], "level": wall["level"], "thickness": wall["thickness"],
        "height": wall["height"],
        "x1": x1 + ux * t0, "y1": y1 + uy * t0,
        "x2": x1 + ux * t1, "y2": y1 + uy * t1,
        "z0": z0, "z1": z1, "kind": kind,
    }



def _inline_color(name: str) -> tuple[tuple[float, float, float], float]:
    n = _norm(name)
    if any(k in n for k in ("glass", "glazing", "verre", "transparent")):
        return (0.55, 0.72, 0.76), 0.48
    if any(k in n for k in ("black", "noir", "dark", "schwarz")):
        return (0.055, 0.05, 0.045), 1.0
    if any(k in n for k in ("white", "blanc", "weiss")):
        return (0.86, 0.82, 0.74), 1.0
    if any(k in n for k in ("wood", "bois", "oak", "walnut", "acajou", "brown", "braun")):
        return (0.47, 0.28, 0.13), 1.0
    if any(k in n for k in ("silver", "metal", "steel", "chrome", "alu", "argent")):
        return (0.56, 0.58, 0.57), 1.0
    if any(k in n for k in ("red", "rouge", "rot")):
        return (0.58, 0.12, 0.08), 1.0
    if any(k in n for k in ("green", "vert", "gruen")):
        return (0.25, 0.42, 0.28), 1.0
    if any(k in n for k in ("blue", "bleu", "blau")):
        return (0.2, 0.33, 0.5), 1.0
    if any(k in n for k in ("gold", "brass", "laiton", "or")):
        return (0.62, 0.46, 0.16), 1.0
    if any(k in n for k in ("fabric", "textile", "cushion", "coussin", "stoff")):
        return (0.38, 0.35, 0.3), 1.0
    palette = [
        (0.62, 0.56, 0.46), (0.5, 0.42, 0.33), (0.7, 0.66, 0.58),
        (0.4, 0.36, 0.31), (0.58, 0.5, 0.42), (0.46, 0.48, 0.45),
    ]
    return palette[sum(ord(c) for c in n) % len(palette)], 1.0


def enrich_inline_materials(assets: Path) -> dict[str, str]:
    """Give extension-less OBJ models in a .sh3d a generated MTL.

    Built-in Sweet Home 3D models often embed ``usemtl`` names but no MTL
    file.  A generated palette makes those models readable instead of one
    flat white/grey block.  Returns model path -> mtl path.
    """
    made: dict[str, str] = {}
    for path in assets.iterdir():
        if not path.is_file() or path.suffix:
            continue
        try:
            head = path.read_bytes()[:1200]
        except OSError:
            continue
        if not (head.startswith(b"#") or head.startswith(b"v ") or b"\nv " in head):
            continue
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        if "\nmtllib " in "\n" + text[:4000]:
            continue
        names: list[str] = []
        for line in text.splitlines():
            if line.startswith("usemtl "):
                name = line[7:].strip()
                if name and name not in names:
                    names.append(name)
        if not names:
            continue
        mtl_name = "inline_" + path.name + ".mtl"
        mtl_path = assets / mtl_name
        if not mtl_path.exists():
            lines = ["# generated by SH3D Home", ""]
            for name in names:
                (r, g, b), alpha = _inline_color(name)
                lines += [f"newmtl {name}", f"Kd {r:.4f} {g:.4f} {b:.4f}",
                          "Ks 0.04 0.04 0.04", "Ns 28", "illum 2", f"d {alpha:.2f}", ""]
            mtl_path.write_text("\n".join(lines))
        path.write_text(f"mtllib {mtl_name}\n" + text)
        made[path.name] = mtl_name
    return made

def repair_inline_scene(assets: Path, scene: dict[str, Any]) -> bool:
    made = enrich_inline_materials(assets)
    changed = False
    for obj in scene.get("objects", []):
        model = obj.get("model")
        if model and not obj.get("mtl") and model in made:
            obj["mtl"] = made[model]
            changed = True
    return changed


def import_sh3d(source: Path, target: Path, model_id: str, display_name: str | None = None) -> dict[str, Any]:
    """Import a .sh3d into *target* and return the scene metadata."""
    if not zipfile.is_zipfile(source):
        raise ValueError("Die Datei ist kein gültiges Sweet-Home-3D-Archiv (.sh3d).")
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    assets = target / "assets"
    with zipfile.ZipFile(source) as z:
        if "Home.xml" not in z.namelist():
            raise ValueError("Im Archiv fehlt Home.xml – ist das wirklich eine .sh3d-Datei?")
        names = _safe_extract(z, assets)
    enrich_inline_materials(assets)
    # Sweet Home 3D archives occasionally reference textures that were not
    # embedded. Remove those map lines so the material's Kd color is used
    # instead of a black/missing texture.
    for mtl_path in assets.rglob("*.mtl"):
        try:
            lines = mtl_path.read_text(errors="ignore").splitlines()
            changed = False
            out = []
            for line in lines:
                stripped = line.strip()
                if stripped.lower().startswith(("map_kd", "map_ka", "map_bump", "bump")):
                    ref = stripped.split(None, 1)[1].strip().strip('"').replace("\\", "/") if len(stripped.split(None, 1)) > 1 else ""
                    candidate = (mtl_path.parent / ref).resolve()
                    if ref and not candidate.exists():
                        out.append("# missing texture: " + line)
                        changed = True
                        continue
                out.append(line)
            if changed:
                mtl_path.write_text("\n".join(out) + "\n")
        except OSError:
            pass

    home_path = assets / "Home.xml"
    root = ET.parse(home_path).getroot()

    levels: dict[str, Level] = {}
    for node in root.findall("level"):
        lid = node.get("id") or f"level-{len(levels)}"
        levels[lid] = Level(
            id=lid,
            name=node.get("name") or f"Etage {len(levels) + 1}",
            elevation=_f(node, "elevation"),
            height=_f(node, "height", 250.0),
            floor_thickness=_f(node, "floorThickness", 12.0),
            visible=_b(node, "visible", True),
        )
    if not levels:
        levels["level-0"] = Level(id="level-0", name="Erdgeschoss", elevation=0.0, height=250.0)

    rooms: list[Room] = []
    for node in root.findall("room"):
        pts = [(_f(p, "x"), _f(p, "y")) for p in node.findall("point")]
        if len(pts) < 3:
            continue
        room = Room(
            id=node.get("id") or f"room-{len(rooms)}",
            name=node.get("name") or f"Raum {len(rooms) + 1}",
            level=node.get("level") or next(iter(levels)),
            points=pts,
            center=_poly_centroid(pts),
            area_m2=round(_poly_area(pts) / 10000.0, 2),
        )
        rooms.append(room)

    def room_for(x: float, y: float, lid: str) -> str | None:
        for room in rooms:
            if room.level == lid and _point_in_poly(x, y, room.points):
                return room.id
        # Fallback: nearest room centre within 3.5 m.
        best, best_d = None, 350.0 ** 2
        for room in rooms:
            if room.level != lid:
                continue
            d = (room.center[0] - x) ** 2 + (room.center[1] - y) ** 2
            if d < best_d:
                best, best_d = room.id, d
        return best

    walls: list[dict[str, Any]] = []
    for node in root.findall("wall"):
        lid = node.get("level") or next(iter(levels))
        walls.append({
            "id": node.get("id") or f"wall-{len(walls)}",
            "level": lid,
            "x1": _f(node, "xStart"), "y1": _f(node, "yStart"),
            "x2": _f(node, "xEnd"), "y2": _f(node, "yEnd"),
            "height": _f(node, "height", levels.get(lid, Level("", "", 0, 250)).height),
            "thickness": max(3.0, _f(node, "thickness", 10.0)),
        })

    def object_from(node: ET.Element, tag: str) -> SceneObject | None:
        lid = node.get("level") or next(iter(levels))
        name = node.get("name") or tag
        catalog = node.get("catalogId") or ""
        width, depth, height = _f(node, "width", 50), _f(node, "depth", 50), _f(node, "height", 50)
        kind, tags = _classify(tag, name, catalog, height, width, depth)
        model, mkind, mtl = _model_info(node.get("model"), assets, names)
        color = _color(node.get("color"), {
            "light": "#e8c98f", "door": "#9b6b45", "window": "#a9cdd2",
            "heating": "#d7d2c8", "speaker": "#3d3a35", "display": "#1f2224",
            "computer": "#2b2e31", "furniture": "#c9bea9",
        }.get(kind, "#c9bea9"))
        obj = SceneObject(
            id=node.get("id") or f"{tag}-{len(walls)}-{name}",
            kind=kind, name=name, catalog=catalog, level=lid,
            x=_f(node, "x"), y=_f(node, "y"), elevation=_f(node, "elevation"),
            angle=_f(node, "angle"), width=max(2.0, width), depth=max(2.0, depth),
            height=max(2.0, height), model=model, model_kind=mkind, mtl=mtl,
            color=color, model_rotation=node.get("modelRotation"),
            mirrored=_b(node, "modelMirrored"), power=_f(node, "power", 0.0) or None,
            tags=tags,
        )
        obj.room = room_for(obj.x, obj.y, lid)
        obj.extra = {k: node.get(k) for k in ("movable", "doorOrWindow", "cutOutShape", "wallThickness") if node.get(k) is not None}
        return obj

    objects: list[SceneObject] = []
    for tag in ("light", "doorOrWindow", "pieceOfFurniture", "shelfUnit"):
        for node in root.findall(tag):
            obj = object_from(node, tag)
            if obj:
                objects.append(obj)

    openings = [o for o in objects if o.kind in ("door", "window")]
    wall_pieces = _split_walls(walls, openings, levels)

    # Cameras stored in the project (usually just the observer / top camera).
    cameras = []
    for node in root.findall("camera"):
        cameras.append({
            "name": node.get("attribute") or node.get("name") or "Ansicht",
            "x": _f(node, "x"), "y": _f(node, "y"), "z": _f(node, "z"),
            "yaw": _f(node, "yaw"), "pitch": _f(node, "pitch"),
            "fov": _f(node, "fieldOfView", 1.1),
        })

    xs = [p[0] for r in rooms for p in r.points] + [w[k] for w in walls for k in ("x1", "x2")] + [o.x for o in objects]
    ys = [p[1] for r in rooms for p in r.points] + [w[k] for w in walls for k in ("y1", "y2")] + [o.y for o in objects]
    if not xs:
        xs, ys = [0.0, 1000.0], [0.0, 1000.0]
    bounds = {"minX": min(xs), "maxX": max(xs), "minY": min(ys), "maxY": max(ys)}
    bounds["width"] = bounds["maxX"] - bounds["minX"]
    bounds["depth"] = bounds["maxY"] - bounds["minY"]

    level_list = sorted(levels.values(), key=lambda l: (l.elevation, l.name))
    scene = {
        "id": model_id,
        "sceneVersion": 2,
        "name": display_name or source.stem.replace("_", " ").title(),
        "sourceFile": source.name,
        "importedAt": None,
        "units": "cm",
        "levels": [
            {"id": l.id, "name": l.name, "elevation": l.elevation,
             "height": l.height, "floorThickness": l.floor_thickness, "visible": l.visible}
            for l in level_list
        ],
        "rooms": [
            {"id": r.id, "name": r.name, "level": r.level,
             "points": [[round(x, 2), round(y, 2)] for x, y in r.points],
             "center": [round(r.center[0], 2), round(r.center[1], 2)],
             "area": r.area_m2}
            for r in rooms
        ],
        "walls": wall_pieces,
        "objects": [
            {
                "id": o.id, "kind": o.kind, "name": o.name, "catalog": o.catalog,
                "level": o.level, "room": o.room, "x": round(o.x, 2), "y": round(o.y, 2),
                "elevation": round(o.elevation, 2), "angle": round(o.angle, 5),
                "width": round(o.width, 2), "depth": round(o.depth, 2), "height": round(o.height, 2),
                "model": o.model, "modelKind": o.model_kind, "mtl": o.mtl,
                "color": o.color, "modelRotation": o.model_rotation,
                "mirrored": o.mirrored, "power": o.power, "tags": o.tags,
                "bbox": {k: round(v, 2) for k, v in o.bbox().items()},
                "extra": o.extra,
            }
            for o in objects
        ],
        "cameras": cameras,
        "bounds": {k: round(v, 2) for k, v in bounds.items()},
        "stats": {
            "levels": len(levels), "rooms": len(rooms), "objects": len(objects),
            "lights": sum(o.kind == "light" for o in objects),
            "doors": sum(o.kind == "door" for o in objects),
            "windows": sum(o.kind == "window" for o in objects),
            "heaters": sum(o.kind == "heating" for o in objects),
            "speakers": sum(o.kind == "speaker" for o in objects),
            "screens": sum(o.kind == "display" for o in objects),
            "computers": sum(o.kind == "computer" for o in objects),
            "walls": len(walls),
        },
        "assets": {"base": f"/api/models/{model_id}/assets/"},
    }
    return scene
