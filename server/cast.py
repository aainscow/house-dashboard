"""Minimal Google Cast client — standard library only (no pychromecast).

Speaks the CastV2 protocol: TLS to port 8009, 4-byte length-prefixed
protobuf `CastMessage` frames carrying JSON payloads. Enough to

  * say(text)       — play a spoken announcement (Default Media Receiver)
  * play(url)       — play any audio URL
  * show(url)       — show a web page full-screen (DashCast receiver)
  * volume(level)   — set volume 0..1
  * status()        — receiver status (running app, volume)

Each call opens its own short connection, so it's safe from any thread.
"""
from __future__ import annotations

import json
import socket
import ssl
import struct
import time
import urllib.parse

DEFAULT_MEDIA_RECEIVER = "CC1AD845"
DASHCAST = "84912283"            # community "DashCast" receiver: shows a URL
NS_CONN = "urn:x-cast:com.google.cast.tp.connection"
NS_HEART = "urn:x-cast:com.google.cast.tp.heartbeat"
NS_RECV = "urn:x-cast:com.google.cast.receiver"
NS_MEDIA = "urn:x-cast:com.google.cast.media"
NS_DASH = "urn:x-cast:es.offd.dashcast"


# --- tiny protobuf encoder/decoder for CastMessage -------------------------
def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _field_str(num: int, s: str) -> bytes:
    b = s.encode()
    return _varint(num << 3 | 2) + _varint(len(b)) + b


def _field_int(num: int, v: int) -> bytes:
    return _varint(num << 3 | 0) + _varint(v)


def encode(src: str, dst: str, ns: str, payload: dict) -> bytes:
    body = (_field_int(1, 0) + _field_str(2, src) + _field_str(3, dst) +
            _field_str(4, ns) + _field_int(5, 0) + _field_str(6, json.dumps(payload)))
    return struct.pack(">I", len(body)) + body


def decode(buf: bytes) -> dict:
    i, out = 0, {}
    while i < len(buf):
        key, shift = 0, 0
        while True:
            b = buf[i]; i += 1
            key |= (b & 0x7F) << shift; shift += 7
            if not b & 0x80:
                break
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, shift = 0, 0
            while True:
                b = buf[i]; i += 1
                v |= (b & 0x7F) << shift; shift += 7
                if not b & 0x80:
                    break
            out[num] = v
        elif wt == 2:
            ln, shift = 0, 0
            while True:
                b = buf[i]; i += 1
                ln |= (b & 0x7F) << shift; shift += 7
                if not b & 0x80:
                    break
            out[num] = buf[i:i + ln]; i += ln
        else:
            raise ValueError("unsupported wire type")
    return {"source": out.get(2, b"").decode(), "dest": out.get(3, b"").decode(),
            "ns": out.get(4, b"").decode(), "data": json.loads(out.get(6, b"{}") or b"{}")}


class Cast:
    def __init__(self, host: str, port: int = 8009, timeout: float = 8.0):
        self.host, self.port, self.timeout = host, port, timeout
        self.sock: ssl.SSLSocket | None = None
        self.req = 0
        self.sender = "sender-house"

    # --- plumbing ---
    def __enter__(self):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # Cast devices use self-signed certs
        raw = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.sock = ctx.wrap_socket(raw)
        self._send("receiver-0", NS_CONN, {"type": "CONNECT"})
        return self

    def __exit__(self, *a):
        try:
            self.sock.close()
        except Exception:
            pass

    def _send(self, dst, ns, payload):
        if "type" in payload and payload["type"] not in ("CONNECT", "CLOSE", "PONG", "PING"):
            self.req += 1
            payload = {**payload, "requestId": self.req}
        self.sock.sendall(encode(self.sender, dst, ns, payload))
        return payload.get("requestId")

    def _recv(self) -> dict:
        hdr = self._read(4)
        (n,) = struct.unpack(">I", hdr)
        msg = decode(self._read(n))
        if msg["ns"] == NS_HEART and msg["data"].get("type") == "PING":
            self._send(msg["source"], NS_HEART, {"type": "PONG"})
        return msg

    def _read(self, n):
        b = b""
        while len(b) < n:
            chunk = self.sock.recv(n - len(b))
            if not chunk:
                raise ConnectionError("cast device closed the connection")
            b += chunk
        return b

    def _wait(self, pred, timeout=None):
        end = time.time() + (timeout or self.timeout)
        while time.time() < end:
            m = self._recv()
            if pred(m):
                return m
        raise TimeoutError("no reply from cast device")

    def _receiver_status(self):
        rid = self._send("receiver-0", NS_RECV, {"type": "GET_STATUS"})
        return self._wait(lambda m: m["ns"] == NS_RECV and m["data"].get("requestId") == rid)["data"]

    def _launch(self, app_id: str) -> str:
        st = self._receiver_status()
        for app in st.get("status", {}).get("applications", []) or []:
            if app.get("appId") == app_id:
                tid = app["transportId"]
                break
        else:
            self._send("receiver-0", NS_RECV, {"type": "LAUNCH", "appId": app_id})
            def launched(m):
                if m["ns"] != NS_RECV:
                    return False
                if m["data"].get("type") in ("LAUNCH_ERROR", "INVALID_REQUEST"):
                    raise RuntimeError(f"cast launch failed: {m['data']}")
                st = m["data"].get("status")
                apps = st.get("applications") if isinstance(st, dict) else None
                return any(isinstance(a, dict) and a.get("appId") == app_id for a in apps or [])
            m = self._wait(launched, 20)
            tid = next(a["transportId"] for a in m["data"]["status"]["applications"] if a["appId"] == app_id)
        self._send(tid, NS_CONN, {"type": "CONNECT"})
        return tid

    # --- public API ---
    def status(self) -> dict:
        st = self._receiver_status().get("status", {})
        apps = st.get("applications") or []
        return {"app": apps[0].get("displayName") if apps else None,
                "appId": apps[0].get("appId") if apps else None,
                "volume": st.get("volume", {}).get("level"),
                "muted": st.get("volume", {}).get("muted")}

    def stop(self):
        """Close whatever app we launched, so the Hub returns to its photo frame."""
        st = self._receiver_status().get("status", {})
        for app in st.get("applications") or []:
            if app.get("appId") in (DEFAULT_MEDIA_RECEIVER, DASHCAST):
                self._send("receiver-0", NS_RECV, {"type": "STOP", "sessionId": app["sessionId"]})

    def mute(self, muted: bool):
        self._send("receiver-0", NS_RECV, {"type": "SET_VOLUME", "volume": {"muted": bool(muted)}})

    def volume(self, level: float):
        self._send("receiver-0", NS_RECV, {"type": "SET_VOLUME", "volume": {"level": max(0.0, min(1.0, level))}})

    def play(self, url: str, mime="audio/mpeg", title="House"):
        tid = self._launch(DEFAULT_MEDIA_RECEIVER)
        rid = self._send(tid, NS_MEDIA, {"type": "LOAD", "autoplay": True, "currentTime": 0, "media": {
            "contentId": url, "contentType": mime, "streamType": "BUFFERED",
            "metadata": {"metadataType": 0, "title": title}}})
        self._wait(lambda m: m["ns"] == NS_MEDIA and m["data"].get("requestId") == rid, 15)

    def say(self, text: str, lang="en-GB", volume: float | None = None):
        """Speak, briefly unmuting / raising volume if needed, then put it back."""
        before = self.status()
        if before["muted"]:
            self.mute(False)
        if volume is not None:
            self.volume(volume)
        q = urllib.parse.urlencode({"ie": "UTF-8", "client": "tw-ob", "tl": lang, "q": text[:200]})
        self.play("https://translate.google.com/translate_tts?" + q, title=text[:60])
        time.sleep(1.5 + len(text) * 0.07)  # roughly how long the speech takes
        if volume is not None and before["volume"] is not None:
            self.volume(before["volume"])
        if before["muted"]:
            self.mute(True)

    def show(self, url: str, reload_seconds: int = 0):
        tid = self._launch(DASHCAST)
        self._send(tid, NS_DASH, {"url": url, "force": True, "reload": bool(reload_seconds),
                                  "reload_time": reload_seconds})


if __name__ == "__main__":  # quick manual test: python3 cast.py 192.168.1.30 status|say "hi"|show URL
    import sys
    host, cmd = sys.argv[1], sys.argv[2]
    with Cast(host) as c:
        if cmd == "status":
            print(c.status())
        elif cmd == "say":
            c.say(sys.argv[3]); print("said")
        elif cmd == "show":
            c.show(sys.argv[3]); print("showing")
        elif cmd == "stop":
            c.stop(); print("stopped")
        elif cmd == "volume":
            c.volume(float(sys.argv[3])); print("ok")
