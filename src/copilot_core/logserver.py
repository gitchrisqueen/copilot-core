#!/usr/bin/env python3
"""Transcript log writer + settings store + Together ASR proxy, shared by both copilot apps.

Three jobs, all tiny and localhost-only:
  /log       POST appends each finalized transcript segment as one JSON line to
             <logdir>/transcript-<date>.jsonl (durable on disk, survives a browser crash).
             GET returns the day's segments; DELETE removes a day's file.
  /settings  GET returns the per-machine settings.json file; POST replaces it. Non-secret
             config only -- API keys stay in .env and never pass through here.
  /asr       POST proxies multipart audio to Together AI's transcription endpoint server-side
             (the browser cannot call it directly: no CORS on their API, and the key must not
             reach the page).
"""
import datetime
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ASR_UPSTREAM = "https://api.together.ai/v1/audio/transcriptions"
ASR_MODELS = "https://api.together.ai/v1/models"
UA = "copilot-core-asr/1.0 (+https://localhost)"   # default urllib UA gets Cloudflare-1010'd


def safe_date(s):
    s = s or datetime.date.today().isoformat()
    return "".join(c for c in s if c.isalnum() or c in "-_") or datetime.date.today().isoformat()


def build_handler(logdir, settings_path):
    os.makedirs(logdir, exist_ok=True)

    def asr_log(msg):
        try:
            with open(os.path.join(logdir, "asr.log"), "a", encoding="utf-8") as f:
                f.write(datetime.datetime.now().isoformat(timespec="seconds") + "  " + msg + "\n")
        except Exception:
            pass

    class Handler(BaseHTTPRequestHandler):
        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

        def do_OPTIONS(self):
            self.send_response(204); self._cors(); self.end_headers()

        def _json(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status); self._cors()
            self.send_header("Content-Type", "application/json"); self.end_headers()
            try:
                self.wfile.write(body)
            except Exception:
                pass

        def do_DELETE(self):
            u = urlparse(self.path)
            if u.path == "/log":
                date = safe_date((parse_qs(u.query).get("date") or [""])[0])
                path = os.path.join(logdir, "transcript-%s.jsonl" % date)
                try:
                    if os.path.exists(path):
                        os.remove(path)
                    return self._json({"ok": True, "deleted": os.path.basename(path)})
                except Exception as e:
                    return self._json({"ok": False, "error": str(e)}, 400)
            return self._json({"ok": True})

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/settings":
                try:
                    with open(settings_path, encoding="utf-8") as f:
                        return self._json(json.load(f))
                except Exception:
                    return self._json({})
            if u.path == "/log":
                date = safe_date((parse_qs(u.query).get("date") or [""])[0])
                path = os.path.join(logdir, "transcript-%s.jsonl" % date)
                order, byid = [], {}
                if os.path.exists(path):
                    with open(path, encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                rec = json.loads(line)
                            except Exception:
                                continue
                            rid = rec.get("id")
                            if rid is None:
                                continue
                            if rid not in byid:
                                order.append(rid)
                            byid[rid] = rec  # last line per id wins (edits)
                segs = [byid[i] for i in order]
                segs.sort(key=lambda r: r.get("ts", ""))
                return self._json({"segments": segs})
            return self._json({"ok": True})

        def _proxy_asr(self):
            n = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(n) if n else b""
            up_headers = {
                "Content-Type": self.headers.get("Content-Type", "application/octet-stream"),
                "User-Agent": UA,
                "Accept": "application/json",
            }
            auth = self.headers.get("Authorization", "") or (
                ("Bearer " + os.environ["TOGETHER_API_KEY"]) if os.environ.get("TOGETHER_API_KEY") else "")
            if auth:
                up_headers["Authorization"] = auth
            t0 = datetime.datetime.now()
            for attempt in range(3):
                try:
                    req = urllib.request.Request(ASR_UPSTREAM, data=body, headers=up_headers, method="POST")
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        data = resp.read()
                        ms = int((datetime.datetime.now() - t0).total_seconds() * 1000)
                        asr_log("together %s in %dms (%d bytes)%s" % (
                            resp.status, ms, len(body), ("" if attempt == 0 else " [after %d retry]" % attempt)))
                        self.send_response(resp.status); self._cors()
                        self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json")); self.end_headers()
                        self.wfile.write(data)
                        return
                except urllib.error.HTTPError as e:
                    edata = e.read()
                    if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                        asr_log("together HTTP %s -> retry %d" % (e.code, attempt + 1))
                        time.sleep(0.4 * (attempt + 1)); continue
                    asr_log("together HTTP %s: %s" % (e.code, edata[:160].decode("utf-8", "replace")))
                    self.send_response(e.code); self._cors()
                    self.send_header("Content-Type", "application/json"); self.end_headers()
                    try: self.wfile.write(edata)
                    except Exception: pass
                    return
                except Exception as e:
                    if attempt < 2:
                        asr_log("together error %s -> retry %d" % (e, attempt + 1))
                        time.sleep(0.4 * (attempt + 1)); continue
                    asr_log("together error: %s" % e)
                    return self._json({"error": str(e)}, 502)

        def do_POST(self):
            path0 = urlparse(self.path).path
            if path0 == "/asr":
                return self._proxy_asr()
            if path0 == "/settings":
                try:
                    n = int(self.headers.get("Content-Length", 0) or 0)
                    obj = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
                    if not isinstance(obj, dict):
                        raise ValueError("settings must be a JSON object")
                    tmp = settings_path + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as f:
                        json.dump(obj, f, ensure_ascii=False, indent=2)
                    os.replace(tmp, settings_path)
                    return self._json({"ok": True})
                except Exception as e:
                    return self._json({"ok": False, "error": str(e)}, 400)
            # default: transcript segment append
            try:
                n = int(self.headers.get("Content-Length", 0) or 0)
                rec = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
                path = os.path.join(logdir, "transcript-%s.jsonl" % safe_date(rec.get("date")))
                rec["_written"] = datetime.datetime.now().isoformat(timespec="seconds")
                with open(path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                return self._json({"ok": True})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 400)

        def log_message(self, *a):  # keep the console quiet
            pass

    return Handler


def build_server(logdir, port=0, host="127.0.0.1", settings_path=None):
    """Build (but do not start) a ThreadingHTTPServer. port=0 lets the OS pick a free port
    (used by tests); the bound port is available as server.server_address[1]."""
    settings_path = settings_path or os.path.join(logdir, "settings.json")
    handler = build_handler(logdir, settings_path)
    return ThreadingHTTPServer((host, port), handler)


def startup_asr_check():
    """One-time line at boot: is Together configured and reachable?"""
    key = os.environ.get("TOGETHER_API_KEY", "").strip()
    if not key:
        print("[asr] Together not configured (no key) -> transcription uses local whisper", flush=True)
        return
    try:
        req = urllib.request.Request(ASR_MODELS, headers={
            "Authorization": "Bearer " + key, "User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            print("[asr] Together transcription CONNECTED via /asr proxy (HTTP %s); "
                  "per-call activity -> logs/asr.log" % r.status, flush=True)
    except urllib.error.HTTPError as e:
        print("[asr] Together key set but connection check failed (HTTP %s) -> will fall back to whisper" % e.code, flush=True)
    except Exception as e:
        print("[asr] Together connection check error (%s) -> will fall back to whisper" % e, flush=True)


def serve(logdir, port, settings_path=None, host="127.0.0.1"):
    settings_path = settings_path or os.path.join(logdir, "settings.json")
    print("log/settings server on %s:%d -> %s/transcript-<date>.jsonl + %s" % (host, port, logdir, settings_path))
    startup_asr_check()
    build_server(logdir, port, host, settings_path).serve_forever()
