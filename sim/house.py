#!/usr/bin/env python3
"""32 Demo Drive — house automation server.

Pure standard library (Python 3.11+) so it runs on the Pi with no installs.

  GET  /                 -> web UI (../web)
  GET  /api/state        -> full house state (rooms, lights, heating, energy, loft)
  POST /api/light        {id, on, level?}
  POST /api/heating      {room, setpoint}  |  {hotwater: true/false}
  POST /api/aircon       {power?, mode?, setpoint?, fan?}
  POST /api/blinds       {id, position}
  GET  /api/events       -> Server-Sent Events stream of state changes

Every integration is an adapter in adapters.py. Each runs in "live" mode when
config.json has credentials for it, otherwise in "demo" mode with a simulator,
so the UI is always fully usable.
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import queue
import socket
import ssl
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import scenes
from adapters import build_adapters
from model import House

ROOT = Path(__file__).resolve().parent
WEB = ROOT.parent / "web"
CONFIG = Path(os.environ.get("HOUSE_CONFIG", ROOT.parent / "config.json"))

log = logging.getLogger("house")


DEMO = os.environ.get("HOUSE_DEMO", "").lower() in ("1", "true", "yes")


def load_config() -> dict:
    if DEMO:
        log.warning("HOUSE_DEMO=1 — config ignored, nothing real will be touched")
        cfg = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
        return {"listen": cfg.get("listen", {})}  # keep listen settings only
    if CONFIG.exists():
        return json.loads(CONFIG.read_text())
    log.warning("no %s — every adapter runs in demo mode", CONFIG)
    return {}


class Hub:
    """Owns the House model, the adapters and the SSE subscribers."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.house = House.from_layout(ROOT / "layout.json")
        self.lock = threading.RLock()
        self.subscribers: list[queue.Queue] = []
        self.adapters = build_adapters(cfg, self)
        self.display_seen = None

    # adapters call this after mutating the model
    def changed(self) -> None:
        payload = self.snapshot_json()
        for q in list(self.subscribers):
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

    def snapshot_json(self) -> str:
        with self.lock:
            snap = self.house.to_dict()
            snap["integrations"] = {k: a.status() for k, a in self.adapters.items()}
            snap["serverTime"] = time.time()
            snap["demoMode"] = DEMO
            snap["scenes"] = scenes.catalogue()
            snap["displaySeen"] = self.display_seen
            return json.dumps(snap)

    def start(self) -> None:
        for a in self.adapters.values():
            threading.Thread(target=a.run_forever, name=a.name, daemon=True).start()

    # ---- commands from the UI -------------------------------------------
    def command(self, kind: str, body: dict, notify: bool = True) -> dict:
        if kind == "scene":
            return scenes.run(self, body["id"])
        adapter = {
            "light": "hubitat",
            "device": "hubitat",
            "hubitat-event": "hubitat",
            "heating": "wiser",
            "aircon": "aircon",
            "blinds": "blinds",
            "battery": "fox",
            "display": "display",
            "optimiser": "optimiser",
            "tesla": "tesla",
        }.get(kind)
        if adapter is None:
            raise KeyError(kind)
        result = self.adapters[adapter].command(kind, body)
        if notify:
            self.changed()
        return result or {"ok": True}


class Handler(BaseHTTPRequestHandler):
    hub: Hub  # set on the class at startup
    server_version = "DemoDrive/1.0"
    # Proper HTTP/1.1: connections stay open between requests (every reply has a Content-Length), idle ones close
    # after 30 s. The old HTTP/1.0 way hung up after each reply and reset connections a client was already reusing,
    # which Chrome on Android retries and then gives up on (ERR_TOO_MANY_RETRIES); the Nest Hub tripped it too.
    protocol_version = "HTTP/1.1"
    timeout = 30

    def peer(self) -> str:
        """The client's address, IPv4 shown plainly (the dual-stack socket reports it as ::ffff:a.b.c.d)."""
        ip = self.client_address[0]
        return ip[7:] if ip.startswith("::ffff:") else ip

    def log_message(self, fmt, *args):
        """Access log: ~/.local/share/house/access-<port>.log (one line a request, trimmed at 1 MB)."""
        log.debug("%s %s", self.address_string(), fmt % args)
        try:
            path = Path.home() / ".local/share/house" / f"access-{self.server.server_address[1]}.log"
            if path.exists() and path.stat().st_size > 1_000_000:
                path.write_text("")
            ua = (self.headers.get("User-Agent", "") if getattr(self, "headers", None) else "")[:90]
            with path.open("a") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {self.peer()} {fmt % args} | {ua}\n")
        except Exception:
            pass

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        extra = dict(extra or {})
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", extra.pop("Cache-Control", "no-cache"))
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status=200):
        self._send(status, json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        ua = self.headers.get("User-Agent", "")
        disp = self.hub.adapters.get("display")
        if disp and disp.cfg.get("host") == self.peer():  # the Nest Hub is fetching us
            self.hub.display_seen = {"at": time.time(), "path": path, "ua": ua[:120]}
        if path == "/api/state":
            return self._send(200, self.hub.snapshot_json().encode(), "application/json")
        if path == "/api/events":
            return self._events()
        if path == "/healthz":
            return self._json({"ok": True})
        if path == "/hub.png":
            return self._hub_png()
        return self._static(path)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))   # always read the body: the connection carries on
        if not path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        try:
            body = json.loads(raw or b"{}")
            res = self.hub.command(path[len("/api/"):], body)
            self._json(res)
        except KeyError as e:
            self._json({"error": f"unknown: {e}"}, 404)
        except Exception as e:  # surface adapter errors to the UI
            log.exception("command failed")
            self._json({"error": str(e)}, 500)

    _png_cache = (0.0, b"")

    def _hub_png(self):
        """Nest Hub screen as an image (see hubimage.py). Cached for 20 s."""
        ts, data = Handler._png_cache
        if time.time() - ts > 20:
            try:
                import hubimage
            except ImportError:
                return self._json({"error": "Pillow not installed (run deploy.sh)"}, 503)
            data = hubimage.render(json.loads(self.hub.snapshot_json()))
            Handler._png_cache = (time.time(), data)
        self._send(200, data, "image/png")

    def _static(self, path: str):
        if path in ("", "/"):
            path = "/index.html"
        f = (WEB / path.lstrip("/")).resolve()
        if WEB.resolve() not in f.parents or not f.is_file():
            return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        ctype = "application/vnd.android.package-archive" if f.suffix == ".apk" else (mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        if ctype.startswith("text/") or ctype.endswith(("javascript", "json", "svg+xml")):
            ctype += "; charset=utf-8"
        # web/vendor/ holds pinned third-party libraries whose paths change with their version,
        # so browsers may keep them; everything else is re-fetched so edits show up at once.
        cache = {"Cache-Control": "public, max-age=31536000, immutable"} if path.startswith("/vendor/") else None
        self._send(200, f.read_bytes(), ctype, cache)

    def _events(self):
        q: queue.Queue = queue.Queue(maxsize=20)
        self.hub.subscribers.append(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")   # a stream has no length: it ends when the connection does
            self.end_headers()
            self.wfile.write(f"retry: 3000\ndata: {self.hub.snapshot_json()}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=15)
                    self.wfile.write(f"data: {data}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            self.hub.subscribers.remove(q)


class DualStackServer(ThreadingHTTPServer):
    """Listens on IPv6 and IPv4 at once. raspberrypi.local also resolves to the Pi's IPv6 address (fd00::…),
    which phones try first; when we only listened on IPv4, Android Chrome got ERR_TOO_MANY_RETRIES."""
    address_family = socket.AF_INET6
    request_queue_size = 64

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


TLS_DIR = Path(os.environ.get("HOUSE_TLS_DIR", Path.home() / ".local/share/house/tls"))


class TLSServer(DualStackServer):
    """HTTPS alongside the plain-HTTP server, with the Let's Encrypt certificate that deploy/https-setup.sh fetches
    into ~/.local/share/house/tls. The handshake happens per connection in its own thread, so a slow or broken
    client can't hold up the others."""

    def __init__(self, addr, handler, ctx):
        self.ctx = ctx
        super().__init__(addr, handler)

    def finish_request(self, request, client_address):
        request.settimeout(10)
        try:
            tls = self.ctx.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError):
            return  # e.g. a plain-HTTP request on the HTTPS port, or the handshake timed out
        try:
            self.RequestHandlerClass(tls, client_address, self)
        finally:
            try:
                tls.close()
            except OSError:
                pass


def start_tls(port: int):
    """If there's a certificate, serve HTTPS too: 8443 for the real dashboard, 8444 for the demo (HTTP port + 363)."""
    cert, key = TLS_DIR / "fullchain.pem", TLS_DIR / "key.pem"
    if not (cert.exists() and key.exists()):
        return None
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    tport = int(os.environ.get("TLS_PORT") or port + 363)
    srv = TLSServer(("::", tport), Handler, ctx)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, name="https", daemon=True).start()
    log.info("serving on https://[::]:%d", tport)
    return srv


def main():
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    cfg = load_config()
    hub = Hub(cfg)
    hub.start()
    Handler.hub = hub
    host = cfg.get("listen", {}).get("host", "0.0.0.0")
    port = int(os.environ.get("PORT") or cfg.get("listen", {}).get("port", 8080))
    srv = (DualStackServer(("::", port), Handler) if host in ("0.0.0.0", "", "::") else ThreadingHTTPServer((host, port), Handler))
    srv.daemon_threads = True
    log.info("serving on http://%s:%d", host, port)
    try:
        start_tls(port)
    except Exception:
        log.exception("HTTPS not started")
    srv.serve_forever()


if __name__ == "__main__":
    main()
