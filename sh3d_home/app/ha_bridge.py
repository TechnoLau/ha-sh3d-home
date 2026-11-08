"""Small Home Assistant bridge for the add-on.

In an add-on the Supervisor exposes Core at http://supervisor/core with
SUPERVISOR_TOKEN.  For local development HA_URL / HA_TOKEN can be used.
The bridge keeps an in-memory state cache, forwards state changes to connected
browsers and performs service calls.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import ssl
from collections import defaultdict
from typing import Any

import aiohttp

_LOGGER = logging.getLogger("sh3d.ha")

ALLOWED_DOMAINS = {
    "light", "switch", "cover", "climate", "media_player", "fan", "humidifier",
    "vacuum", "lock", "scene", "script", "button", "input_boolean", "input_number",
    "input_select", "select", "number", "siren", "water_heater", "binary_sensor",
    "sensor", "camera", "notify", "group", "automation",
}

TOGGLE_SERVICE = {
    "light": "toggle",
    "switch": "toggle",
    "input_boolean": "toggle",
    "fan": "toggle",
    "cover": "toggle",
    "media_player": "media_play_pause",
    "lock": "lock",
}


class HABridge:
    def __init__(self) -> None:
        token = os.environ.get("SUPERVISOR_TOKEN") or os.environ.get("HA_TOKEN") or os.environ.get("HASS_TOKEN")
        base = os.environ.get("HA_URL") or ("http://supervisor" if os.environ.get("SUPERVISOR_TOKEN") else "")
        base = base.rstrip("/")
        self.token = token or ""
        self.api_base = base + "/api" if base and not base.endswith("/api") else base
        self.ws_url = base.replace("https://", "wss://").replace("http://", "ws://") + "/api/websocket" if base else ""
        if os.environ.get("SUPERVISOR_TOKEN") and not os.environ.get("HA_URL"):
            self.api_base = "http://supervisor/core/api"
            self.ws_url = "ws://supervisor/core/websocket"
        self.states: dict[str, dict[str, Any]] = {}
        self.registries: dict[str, dict[str, Any]] = {"entities": {}, "devices": {}, "areas": {}}
        self.connected = False
        self.last_error: str | None = None
        self._session: aiohttp.ClientSession | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._msg_id = 0
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._ssl = ssl.create_default_context()

    # ------------------------------------------------------------------
    # lifecycle
    async def start(self) -> None:
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=20, connect=10),
            headers={"Authorization": f"Bearer {self.token}"},
        )
        self._task = asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._session:
            await self._session.close()

    async def _run_forever(self) -> None:
        delay = 2
        while True:
            try:
                await self._connect_ws()
                delay = 2
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # network / auth / HA restart
                self.connected = False
                self.last_error = str(exc)[:300]
                _LOGGER.warning("HA websocket disconnected: %s", self.last_error)
                await self._broadcast({"type": "connection", "connected": False, "error": self.last_error})
                await asyncio.sleep(delay)
                delay = min(30, delay * 2)

    async def _connect_ws(self) -> None:
        if not self.ws_url or not self.token:
            raise RuntimeError("Kein Home-Assistant-Token / keine URL konfiguriert")
        assert self._session
        async with self._session.ws_connect(self.ws_url, heartbeat=30, max_msg_size=20_000_000) as ws:
            self._ws = ws
            hello = await ws.receive_json()
            if hello.get("type") != "auth_required":
                raise RuntimeError(f"Unerwartete HA-Antwort: {hello}")
            await ws.send_json({"type": "auth", "access_token": self.token})
            auth = await ws.receive_json()
            if auth.get("type") != "auth_ok":
                raise RuntimeError(f"HA-Authentifizierung fehlgeschlagen: {auth.get('message', auth)}")
            reader = asyncio.create_task(self._reader(ws))
            try:
                await self._refresh_states()
                await self._refresh_registries()
                await self._subscribe_events()
                self.connected = True
                self.last_error = None
                _LOGGER.info("Connected to Home Assistant %s", auth.get("ha_version"))
                await self._broadcast({"type": "connection", "connected": True})
                await self._broadcast({"type": "snapshot", "states": self.states, "connected": True})
                await reader
            finally:
                reader.cancel()
                try:
                    await reader
                except (asyncio.CancelledError, Exception):
                    pass
        self.connected = False
        self._ws = None

    async def _reader(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "result" and data.get("id") in self._pending:
                    fut = self._pending.pop(data["id"])
                    if not fut.done():
                        fut.set_result(data)
                    continue
                if data.get("type") == "event":
                    event = data.get("event") or {}
                    if event.get("event_type") == "state_changed":
                        self._handle_state(event.get("data") or {})
            elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                break

    async def _send_ws(self, payload: dict[str, Any], timeout: float = 15) -> dict[str, Any]:
        if not self._ws or self._ws.closed:
            raise RuntimeError("Home Assistant nicht verbunden")
        self._msg_id += 1
        msg_id = self._msg_id
        fut = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        payload = dict(payload)
        payload["id"] = msg_id
        await self._ws.send_json(payload)
        try:
            result = await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)
        if not result.get("success"):
            raise RuntimeError(str(result.get("error") or "Home Assistant Anfrage fehlgeschlagen"))
        return result.get("result")

    async def _subscribe_events(self) -> None:
        await self._send_ws({"type": "subscribe_events", "event_type": "state_changed"})

    async def _refresh_states(self) -> None:
        assert self._session
        async with self._session.get(f"{self.api_base}/states") as resp:
            if resp.status != 200:
                raise RuntimeError(f"HA /states HTTP {resp.status}")
            data = await resp.json()
        self.states = {s["entity_id"]: s for s in data if isinstance(s, dict) and s.get("entity_id")}
        self._enrich()

    async def _refresh_registries(self) -> None:
        # Registries are optional; older / restricted installations may refuse.
        try:
            for key, command in (
                ("entities", "config/entity_registry/list"),
                ("devices", "config/device_registry/list"),
                ("areas", "config/area_registry/list"),
            ):
                try:
                    result = await self._send_ws({"type": command})
                    if isinstance(result, list):
                        self.registries[key] = {item.get("id") or item.get("entity_id"): item for item in result if isinstance(item, dict)}
                except Exception as exc:
                    _LOGGER.debug("Registry %s unavailable: %s", command, exc)
        finally:
            self._enrich()

    def _decorate(self, entity_id: str, state: dict[str, Any]) -> None:
        areas = self.registries.get("areas", {})
        devices = self.registries.get("devices", {})
        entities = self.registries.get("entities", {})
        reg = entities.get(entity_id) or {}
        device = devices.get(reg.get("device_id")) or {}
        area = areas.get(reg.get("area_id") or device.get("area_id")) or {}
        attrs = state.setdefault("attributes", {})
        if "friendly_name" not in attrs:
            attrs["friendly_name"] = reg.get("name") or reg.get("original_name") or entity_id
        attrs["_area"] = area.get("name") or attrs.get("_area", "")
        attrs["_device"] = device.get("name_by_user") or device.get("name") or attrs.get("_device", "")
        attrs["_domain"] = entity_id.split(".")[0]
        attrs["_hidden"] = bool(reg.get("hidden_by"))
        attrs["_disabled"] = bool(reg.get("disabled_by"))

    def _enrich(self) -> None:
        for entity_id, state in self.states.items():
            self._decorate(entity_id, state)

    def _handle_state(self, data: dict[str, Any]) -> None:
        entity_id = data.get("entity_id")
        new_state = data.get("new_state")
        if not entity_id:
            return
        if not new_state:
            self.states.pop(entity_id, None)
            self._broadcast_later({"type": "state_removed", "entity_id": entity_id})
            return
        new_state = dict(new_state)
        old = self.states.get(entity_id) or {}
        old_attrs = (old.get("attributes") or {})
        attrs = new_state.setdefault("attributes", {})
        for key in ("_area", "_device", "_domain", "_hidden", "_disabled"):
            if key in old_attrs and key not in attrs:
                attrs[key] = old_attrs[key]
        self.states[entity_id] = new_state
        self._decorate(entity_id, new_state)
        self._broadcast_later({"type": "state", "entity": new_state})

    def _broadcast_later(self, payload: dict[str, Any]) -> None:
        try:
            asyncio.get_running_loop().create_task(self._broadcast(payload))
        except RuntimeError:
            pass

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        dead = []
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(queue)
            except Exception:
                dead.append(queue)
        for queue in dead:
            self._subscribers.discard(queue)

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=400)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def entity_summary(self) -> list[dict[str, Any]]:
        items = []
        for entity_id, state in self.states.items():
            attrs = state.get("attributes", {})
            if attrs.get("_hidden"):
                continue
            items.append({
                "entity_id": entity_id,
                "state": state.get("state"),
                "attributes": attrs,
                "last_changed": state.get("last_changed"),
                "last_updated": state.get("last_updated"),
            })
        items.sort(key=lambda e: (e["entity_id"].split(".")[0], str(e["attributes"].get("friendly_name", "")).lower()))
        return items

    # ------------------------------------------------------------------
    # commands
    async def call_service(self, entity_id: str, action: str, data: dict[str, Any] | None = None) -> Any:
        if not entity_id or "." not in entity_id:
            raise ValueError("Ungültige Entity-ID")
        domain = entity_id.split(".", 1)[0]
        if domain not in ALLOWED_DOMAINS:
            raise ValueError(f"Domain {domain} ist nicht freigegeben")
        data = dict(data or {})
        action = (action or "toggle").lower()
        service = None
        if action == "toggle":
            service = TOGGLE_SERVICE.get(domain)
            if domain == "lock":
                service = "unlock" if (self.states.get(entity_id, {}).get("state") == "locked") else "lock"
            if domain == "climate":
                service = "toggle" if "toggle" in self._services_for(domain) else "set_hvac_mode"
                if service == "set_hvac_mode":
                    current = self.states.get(entity_id, {}).get("state")
                    data = {"hvac_mode": "off" if current != "off" else "heat"}
            if domain == "media_player":
                service = "media_play_pause"
            if service is None:
                service = "turn_on" if self.states.get(entity_id, {}).get("state") in ("off", "closed", "unavailable") else "turn_off"
        elif action == "turn_on":
            service = "turn_on"
        elif action == "turn_off":
            service = "turn_off"
        elif action == "call":
            service = str(data.pop("service", ""))
            if not service or not data.pop("_allow", False):
                raise ValueError("Explizite Service-Aufrufe sind nicht erlaubt")
        elif action in ("set_temperature", "set_color", "set_brightness", "set_position", "set_volume", "set_option", "press"):
            service = {
                "set_temperature": "set_temperature",
                "set_color": "turn_on",
                "set_brightness": "turn_on",
                "set_position": "set_cover_position",
                "set_volume": "volume_set",
                "set_option": "select_option",
                "press": "press",
            }[action]
        else:
            raise ValueError(f"Unbekannte Aktion: {action}")

        assert self._session
        url = f"{self.api_base}/services/{domain}/{service}"
        payload = {"entity_id": entity_id}
        payload.update({k: v for k, v in data.items() if not k.startswith("_")})
        async with self._session.post(url, json=payload) as resp:
            body = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"HA Service {domain}.{service} fehlgeschlagen ({resp.status}): {body[:300]}")
            try:
                return await resp.json()
            except Exception:
                return {"ok": True}

    def _services_for(self, domain: str) -> set[str]:
        # We don't keep the service registry; climate.toggle exists in recent HA.
        return {"toggle"} if domain == "climate" else set()
