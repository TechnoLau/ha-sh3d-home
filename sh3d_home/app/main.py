from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import os
import re
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aiohttp import web

from . import sh3d
from .ha_bridge import HABridge

_LOGGER = logging.getLogger("sh3d")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = Path(os.environ.get("SH3D_DATA_DIR", "/data"))
MODELS_DIR = DATA_DIR / "models"
CONFIG_WWW = Path(os.environ.get("SH3D_CONFIG_WWW", "/config/www"))
CARD_DIR = CONFIG_WWW / "sh3d-home"
SCAN_DIRS = [Path(p) for p in os.environ.get("SH3D_SCAN_DIRS", "/share/sh3d-home,/share,/media,/config/www").split(",") if p]
MAX_UPLOAD = 250 * 1024 * 1024
ALLOWED_SERVICE_ACTIONS = {"toggle", "turn_on", "turn_off", "set_temperature", "set_color", "set_brightness", "set_position", "set_volume", "set_option", "press", "call"}

DEFAULT_CONFIG = {
    "version": 1,
    "mappings": {},
    "scene": {
        "showCeilings": False,
        "showLabels": True,
        "ambient": 0.72,
        "background": "warm",
        "autoRotate": False,
        "wallMode": "solid",
        "showFloors": True,
        "stackLevels": True,
    },
    "dashboard": {
        "mode": "home",
        "focus": "dim",
        "view": "iso",
        "chrome": True,
        "level": None,
        "room": None,
    },
    "updatedAt": None,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "", value)[:32]


class Store:
    def __init__(self) -> None:
        self.models: dict[str, dict[str, Any]] = {}
        self.scene_cache: dict[str, dict[str, Any]] = {}
        self.lock = asyncio.Lock()

    def load(self) -> None:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        for folder in MODELS_DIR.iterdir():
            if not folder.is_dir():
                continue
            meta_path = folder / "meta.json"
            scene_path = folder / "scene.json"
            if not meta_path.exists() or not scene_path.exists():
                continue
            try:
                meta = json.loads(meta_path.read_text())
                meta["id"] = folder.name
                self.models[folder.name] = meta
                self.scene_cache[folder.name] = json.loads(scene_path.read_text())
            except Exception as exc:
                _LOGGER.warning("Modell %s konnte nicht geladen werden: %s", folder, exc)

    def write_meta(self, model_id: str, meta: dict[str, Any]) -> None:
        folder = MODELS_DIR / model_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    def config_path(self, model_id: str) -> Path:
        return MODELS_DIR / model_id / "config.json"

    def get_config(self, model_id: str) -> dict[str, Any]:
        path = self.config_path(model_id)
        if path.exists():
            try:
                cfg = json.loads(path.read_text())
                cfg.setdefault("mappings", {})
                cfg.setdefault("scene", dict(DEFAULT_CONFIG["scene"]))
                cfg.setdefault("dashboard", dict(DEFAULT_CONFIG["dashboard"]))
                return cfg
            except Exception:
                pass
        return json.loads(json.dumps(DEFAULT_CONFIG))

    def put_config(self, model_id: str, config: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(config, dict):
            raise ValueError("Konfiguration muss ein JSON-Objekt sein")
        mappings = config.get("mappings", {})
        if not isinstance(mappings, dict) or len(mappings) > 1000:
            raise ValueError("Ungültige Zuordnungen")
        config["updatedAt"] = now_iso()
        config.setdefault("version", 1)
        config.setdefault("scene", dict(DEFAULT_CONFIG["scene"]))
        config.setdefault("dashboard", dict(DEFAULT_CONFIG["dashboard"]))
        path = self.config_path(model_id)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(config, indent=2, ensure_ascii=False))
        tmp.replace(path)
        return config

    def add_model(self, source: Path, display_name: str | None = None) -> dict[str, Any]:
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        model_id = digest[:12]
        folder = MODELS_DIR / model_id
        if model_id in self.models and (folder / "scene.json").exists():
            return self.models[model_id]
        folder.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, folder / "source.sh3d")
        scene = sh3d.import_sh3d(source, folder, model_id, display_name)
        scene["importedAt"] = now_iso()
        (folder / "scene.json").write_text(json.dumps(scene, ensure_ascii=False))
        meta = {
            "id": model_id,
            "name": scene["name"],
            "sourceFile": scene["sourceFile"],
            "importedAt": scene["importedAt"],
            "stats": scene["stats"],
            "levels": scene["levels"],
            "bounds": scene["bounds"],
            "sha256": digest,
            "size": source.stat().st_size,
        }
        self.write_meta(model_id, meta)
        self.get_config(model_id)
        self.models[model_id] = meta
        self.scene_cache[model_id] = scene
        _LOGGER.info("Imported model %s (%s, %s objects)", model_id, scene["name"], len(scene["objects"]))
        return meta

    def delete_model(self, model_id: str) -> None:
        folder = (MODELS_DIR / model_id).resolve()
        if MODELS_DIR.resolve() not in folder.parents:
            raise ValueError("Ungültige Modell-ID")
        self.models.pop(model_id, None)
        self.scene_cache.pop(model_id, None)
        if folder.exists():
            shutil.rmtree(folder)


STORE = Store()
BRIDGE = HABridge()


# ---------------------------------------------------------------------------
# helpers
def json_response(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda x: json.dumps(x, ensure_ascii=False, separators=(",", ":")))


async def read_json(request: web.Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        raise web.HTTPBadRequest(text="Ungültiges JSON")
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text="JSON-Objekt erwartet")
    return data


def validate_model_id(model_id: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{6,64}", model_id):
        raise web.HTTPNotFound(text="Modell nicht gefunden")
    return model_id


# ---------------------------------------------------------------------------
# HTTP handlers
async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


async def health(request: web.Request) -> web.Response:
    return json_response({
        "ok": True,
        "ha": {"connected": BRIDGE.connected, "error": BRIDGE.last_error},
        "models": len(STORE.models),
        "version": os.environ.get("SH3D_VERSION", "0.2.0"),
    })


async def api_models(request: web.Request) -> web.Response:
    items = sorted(STORE.models.values(), key=lambda m: m.get("importedAt") or "", reverse=True)
    return json_response({"models": items})


async def api_model(request: web.Request) -> web.Response:
    model_id = validate_model_id(request.match_info["model_id"])
    if model_id not in STORE.models:
        raise web.HTTPNotFound(text="Modell nicht gefunden")
    return json_response(STORE.models[model_id])


async def api_scene(request: web.Request) -> web.Response:
    model_id = validate_model_id(request.match_info["model_id"])
    scene = STORE.scene_cache.get(model_id)
    if not scene:
        path = MODELS_DIR / model_id / "scene.json"
        if path.exists():
            scene = json.loads(path.read_text())
            STORE.scene_cache[model_id] = scene
        else:
            raise web.HTTPNotFound(text="Modell nicht gefunden")
    return json_response(scene)


async def api_get_config(request: web.Request) -> web.Response:
    model_id = validate_model_id(request.match_info["model_id"])
    if model_id not in STORE.models:
        raise web.HTTPNotFound(text="Modell nicht gefunden")
    return json_response(STORE.get_config(model_id))


async def api_put_config(request: web.Request) -> web.Response:
    model_id = validate_model_id(request.match_info["model_id"])
    if model_id not in STORE.models:
        raise web.HTTPNotFound(text="Modell nicht gefunden")
    data = await read_json(request)
    try:
        saved = STORE.put_config(model_id, data)
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    return json_response({"ok": True, "config": saved})


async def api_delete_model(request: web.Request) -> web.Response:
    model_id = validate_model_id(request.match_info["model_id"])
    STORE.delete_model(model_id)
    return json_response({"ok": True})


async def api_thumbnail(request: web.Request) -> web.Response:
    model_id = validate_model_id(request.match_info["model_id"])
    if model_id not in STORE.models:
        raise web.HTTPNotFound(text="Modell nicht gefunden")
    data = await read_json(request)
    raw = str(data.get("dataUrl", ""))
    if not raw.startswith("data:image/png;base64,"):
        raise web.HTTPBadRequest(text="PNG Data-URL erwartet")
    try:
        blob = base64.b64decode(raw.split(",", 1)[1], validate=True)
    except Exception:
        raise web.HTTPBadRequest(text="Ungültiges Bild")
    if len(blob) > 3_000_000:
        raise web.HTTPBadRequest(text="Bild zu groß")
    folder = MODELS_DIR / model_id
    (folder / "thumb.png").write_bytes(blob)
    meta = STORE.models[model_id]
    meta["thumbnail"] = f"api/models/{model_id}/thumb.png"
    STORE.write_meta(model_id, meta)
    return json_response({"ok": True})


async def api_thumb(request: web.Request) -> web.StreamResponse:
    model_id = validate_model_id(request.match_info["model_id"])
    path = MODELS_DIR / model_id / "thumb.png"
    if not path.exists():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "public, max-age=300"})


async def api_upload(request: web.Request) -> web.Response:
    if request.content_length and request.content_length > MAX_UPLOAD + 1_000_000:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD, actual_size=request.content_length)
    reader = await request.multipart()
    temp_dir = Path(tempfile.mkdtemp(prefix="sh3d-upload-"))
    temp_path: Path | None = None
    display_name = None
    try:
        async for field in reader:
            if field.name == "name":
                display_name = (await field.text()).strip() or None
            elif field.name == "file":
                filename = Path(field.filename or "model.sh3d").name
                if not filename.lower().endswith(".sh3d"):
                    raise web.HTTPBadRequest(text="Bitte eine .sh3d-Datei auswählen")
                temp_path = temp_dir / "upload.sh3d"
                size = 0
                with temp_path.open("wb") as out:
                    while True:
                        chunk = await field.read_chunk(1024 * 512)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > MAX_UPLOAD:
                            raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD, actual_size=size)
                        out.write(chunk)
            else:
                await field.release()
        if not temp_path or not temp_path.exists():
            raise web.HTTPBadRequest(text="Keine Datei empfangen")
        try:
            meta = await asyncio.to_thread(STORE.add_model, temp_path, display_name)
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc))
        return json_response({"ok": True, "model": meta})
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


async def api_scan(request: web.Request) -> web.Response:
    imported = []
    for directory in SCAN_DIRS:
        if not directory.exists() or not directory.is_dir():
            continue
        for path in list(directory.glob("*.sh3d"))[:20]:
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
                if digest in STORE.models:
                    continue
                meta = await asyncio.to_thread(STORE.add_model, path, None)
                imported.append(meta)
            except Exception as exc:
                _LOGGER.warning("Scan import failed for %s: %s", path, exc)
    return json_response({"ok": True, "imported": imported})


async def api_entities(request: web.Request) -> web.Response:
    return json_response({"connected": BRIDGE.connected, "entities": BRIDGE.entity_summary(), "error": BRIDGE.last_error})


async def api_service(request: web.Request) -> web.Response:
    data = await read_json(request)
    entity_id = str(data.get("entity_id", ""))
    action = str(data.get("action", "toggle"))
    if action not in ALLOWED_SERVICE_ACTIONS:
        raise web.HTTPBadRequest(text=f"Aktion {action} nicht erlaubt")
    service_data = data.get("data") if isinstance(data.get("data"), dict) else {}
    try:
        result = await BRIDGE.call_service(entity_id, action, service_data)
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    except RuntimeError as exc:
        raise web.HTTPBadGateway(text=str(exc))
    return json_response({"ok": True, "result": result})


async def api_states(request: web.Request) -> web.Response:
    return json_response({"connected": BRIDGE.connected, "states": BRIDGE.states})


async def api_card(request: web.Request) -> web.Response:
    return json_response({"ok": True, "resource": "/local/sh3d-home/sh3d-home-card.js?v=0.2.0"})


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=2_000_000)
    await ws.prepare(request)
    queue = BRIDGE.subscribe()
    try:
        await ws.send_json({"type": "snapshot", "states": BRIDGE.states, "connected": BRIDGE.connected, "error": BRIDGE.last_error})
        send_task = asyncio.create_task(_pump(ws, queue))
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                    if payload.get("type") == "ping":
                        await ws.send_json({"type": "pong", "t": time.time()})
                except Exception:
                    pass
        send_task.cancel()
    finally:
        BRIDGE.unsubscribe(queue)
    return ws


async def _pump(ws: web.WebSocketResponse, queue: asyncio.Queue) -> None:
    try:
        while not ws.closed:
            payload = await queue.get()
            await ws.send_json(payload)
    except (asyncio.CancelledError, ConnectionResetError):
        return


async def api_assets(request: web.Request) -> web.StreamResponse:
    model_id = validate_model_id(request.match_info["model_id"])
    rel = request.match_info.get("path", "")
    if not rel or ".." in Path(rel).parts or rel.startswith("/"):
        raise web.HTTPNotFound()
    base = (MODELS_DIR / model_id / "assets").resolve()
    path = (base / rel).resolve()
    if base not in path.parents and path != base:
        raise web.HTTPNotFound()
    if not path.exists() or not path.is_file():
        raise web.HTTPNotFound()
    content_type, _ = mimetypes.guess_type(str(path))
    headers = {"Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*"}
    if content_type and content_type.startswith("text/"):
        content_type += "; charset=utf-8"
    return web.FileResponse(path, headers=headers)


async def api_model_export(request: web.Request) -> web.Response:
    model_id = validate_model_id(request.match_info["model_id"])
    source = MODELS_DIR / model_id / "source.sh3d"
    if not source.exists():
        raise web.HTTPNotFound()
    return web.FileResponse(source, headers={"Content-Disposition": f'attachment; filename="{source.name}"'})


# ---------------------------------------------------------------------------
# dashboard card / startup
def write_card() -> None:
    try:
        CARD_DIR.mkdir(parents=True, exist_ok=True)
        card_src = STATIC_DIR / "sh3d-home-card.js"
        if card_src.exists():
            (CARD_DIR / "sh3d-home-card.js").write_text(card_src.read_text())
        # A tiny stable JSON file lets a user manually wire a card URL if the
        # automatic resource registration is unavailable (YAML mode).
        info = {
            "resource": "/local/sh3d-home/sh3d-home-card.js?v=0.2.0",
            "panel": "SH3D Home",
            "generated": now_iso(),
        }
        (CARD_DIR / "info.json").write_text(json.dumps(info, indent=2))
    except Exception as exc:
        _LOGGER.warning("Could not write dashboard card to /config/www: %s", exc)


async def register_resource() -> None:
    url = "/local/sh3d-home/sh3d-home-card.js?v=0.2.0"
    for attempt in range(30):
        if BRIDGE.connected:
            try:
                existing = await BRIDGE._send_ws({"type": "lovelace/resources"})
                if isinstance(existing, list):
                    current = next((r for r in existing if str(r.get("url", "")).startswith("/local/sh3d-home/sh3d-home-card.js")), None)
                    if current is None:
                        await BRIDGE._send_ws({"type": "lovelace/resources/create", "res_type": "module", "url": url})
                        _LOGGER.info("Registered Lovelace resource %s", url)
                    elif current.get("url") != url:
                        await BRIDGE._send_ws({"type": "lovelace/resources/update", "resource_id": current.get("id"), "res_type": "module", "url": url})
                        _LOGGER.info("Updated Lovelace resource to %s", url)
                return
            except Exception as exc:
                _LOGGER.info("Lovelace resource registration deferred: %s", exc)
        await asyncio.sleep(5)


async def on_startup(app: web.Application) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    STORE.load()
    write_card()
    await BRIDGE.start()
    app["resource_task"] = asyncio.create_task(register_resource())
    # scan in background so the web UI is available immediately
    async def scan_later():
        await asyncio.sleep(3)
        for directory in SCAN_DIRS:
            if not directory.exists():
                continue
            for path in list(directory.glob("*.sh3d"))[:20]:
                try:
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
                    if digest not in STORE.models:
                        await asyncio.to_thread(STORE.add_model, path, None)
                except Exception as exc:
                    _LOGGER.warning("Auto-import %s failed: %s", path, exc)
    app["scan_task"] = asyncio.create_task(scan_later())


async def on_cleanup(app: web.Application) -> None:
    for key in ("resource_task", "scan_task"):
        task = app.get(key)
        if task:
            task.cancel()
    await BRIDGE.stop()


@web.middleware
async def no_cache_static(request: web.Request, handler):
    response = await handler(request)
    if request.path.startswith("/static/") or request.path in ("/", "/index.html"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


def create_app() -> web.Application:
    app = web.Application(client_max_size=MAX_UPLOAD + 1_000_000, middlewares=[no_cache_static])
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_get("/", index)
    app.router.add_get("/api/health", health)
    app.router.add_get("/api/models", api_models)
    app.router.add_get("/api/models/{model_id}", api_model)
    app.router.add_get("/api/models/{model_id}/scene", api_scene)
    app.router.add_get("/api/models/{model_id}/config", api_get_config)
    app.router.add_put("/api/models/{model_id}/config", api_put_config)
    app.router.add_post("/api/models/{model_id}/thumbnail", api_thumbnail)
    app.router.add_get("/api/models/{model_id}/thumb.png", api_thumb)
    app.router.add_get("/api/models/{model_id}/source", api_model_export)
    app.router.add_delete("/api/models/{model_id}", api_delete_model)
    app.router.add_get("/api/models/{model_id}/assets/{path:.*}", api_assets)
    app.router.add_post("/api/models", api_upload)
    app.router.add_post("/api/import/scan", api_scan)
    app.router.add_get("/api/entities", api_entities)
    app.router.add_get("/api/states", api_states)
    app.router.add_post("/api/service", api_service)
    app.router.add_get("/api/card", api_card)
    app.router.add_get("/api/ws", websocket_handler)
    app.router.add_static("/static", STATIC_DIR, name="static", append_version=True)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app = create_app()
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8099")), access_log=None)
