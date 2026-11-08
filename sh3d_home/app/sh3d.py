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
        if head.startswith(b"#") or b"\nv " in head or head.startswith(b"v "):
            return model, "obj", None
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

    Each piece is described by its two end points and its vertical range, so the
    client can create a correctly sized box without doing the CSG in JS.
    """
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
        level = levels.get(wall["level"])
        ops: list[tuple[float, float, float, float]] = []
        for obj in openings:
            if obj.level != wall["level"]:
                continue
            dx, dy = obj.x - x1, obj.y - y1
            t = dx * ux + dy * uy
            dist = abs(dx * uy - dy * ux)
            if dist > max(45.0, wall["thickness"] / 2 + 28.0):
                continue
            if t < -30 or t > length + 30:
                continue
            half = max(12.0, obj.width / 2)
            t0 = max(0.0, t - half)
            t1 = min(length, t + half)
            if t1 <= t0:
                continue
            bottom = max(0.0, obj.elevation)
            top = min(wall["height"], obj.elevation + obj.height)
            if top - bottom < 5:
                continue
            ops.append((t0, t1, bottom, top))
        ops.sort()
        cursor = 0.0
        for t0, t1, bottom, top in ops:
            t0 = max(t0, cursor)
            if t0 <= cursor + 0.3:
                t0 = cursor
            if t0 > cursor + 0.3:
                result.append(_wall_piece(wall, x1, y1, ux, uy, cursor, t0, 0.0, wall["height"], "wall"))
            if bottom > 0.3:
                result.append(_wall_piece(wall, x1, y1, ux, uy, t0, t1, 0.0, bottom, "sill"))
            if top < wall["height"] - 0.3:
                result.append(_wall_piece(wall, x1, y1, ux, uy, t0, t1, top, wall["height"], "lintel"))
            cursor = max(cursor, t1)
        if cursor < length - 0.3:
            result.append(_wall_piece(wall, x1, y1, ux, uy, cursor, length, 0.0, wall["height"], "wall"))
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
