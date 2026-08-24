#!/usr/bin/env python3
"""Static file server shared by both copilot apps: disables caching, injects .env secrets into
a committed %PLACEHOLDER% config file, and supports app-owned virtual routes (e.g. a hearing app
serving its active profile's data.js, or a prompt-pack file).

Secrets: the app's config.js is committed with placeholders (e.g. "%TOGETHER_API_KEY%") and no
real keys. When the browser requests it, this server substitutes each placeholder with the
matching value from a local, git-ignored .env file. Keys stay on the machine and never enter the
repo; substitution happens in memory, the file on disk is untouched.

Security: dotfiles (anything with a path segment starting with ".", e.g. ".env") are refused by
default even though the served root may contain them -- this module is meant to be safe to point
at a whole project directory, not just a public assets folder.
"""
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_KEYS = ("OPENAI_API_KEY", "GROQ_API_KEY", "OLLAMA_API_KEY", "TOGETHER_API_KEY")


def load_env(env_path, keys):
    """Read env_path (KEY=VALUE lines) into a dict; a real environment variable overrides."""
    vals = {}
    try:
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    for k in keys:
        if os.environ.get(k):
            vals[k] = os.environ[k]
    return vals


def render_config(config_path, env_vals, keys):
    """Return config_path's bytes with %KEY% placeholders replaced by env_vals (unset -> "")."""
    txt = open(config_path, encoding="utf-8").read()
    for k in keys:
        txt = txt.replace("%" + k + "%", env_vals.get(k, ""))
    return txt.encode("utf-8")


def _is_dotfile_path(path):
    return any(part.startswith(".") and part not in (".", "..") for part in path.split("/"))


def build_handler(root, config_path=None, config_route="/app/config.js", env_path=None, keys=DEFAULT_KEYS, routes=None):
    """Build a NoCacheHandler class bound to the given static root + secret-injection + routes.

    routes: optional dict of {path_suffix: render_fn}. render_fn() -> bytes, matched by
    endswith() against the request path (before the query string), checked before config_route
    so an app can shadow/replace the config route entirely if it wants to.
    """
    routes = dict(routes or {})
    env_vals = load_env(env_path, keys) if env_path else {}

    class NoCacheHandler(SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            super().end_headers()

        def do_GET(self):
            path0 = self.path.split("?", 1)[0]
            if _is_dotfile_path(path0):
                self.send_error(404, "Not Found")
                return
            for suffix, render_fn in routes.items():
                if path0.endswith(suffix):
                    body = render_fn()
                    self._send_js(body)
                    return
            if config_path and path0.endswith(config_route):
                body = render_config(config_path, env_vals, keys)
                self._send_js(body)
                return
            return super().do_GET()

        def _send_js(self, body):
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    return NoCacheHandler


def build_server(root, port=0, host="127.0.0.1", config_path=None, config_route="/app/config.js",
                  env_path=None, keys=DEFAULT_KEYS, routes=None):
    """Build (but do not start) a ThreadingHTTPServer. port=0 lets the OS pick a free port
    (used by tests); the bound port is available as server.server_address[1]."""
    handler = partial(build_handler(root, config_path, config_route, env_path, keys, routes), directory=root)
    return ThreadingHTTPServer((host, port), handler)


def serve(root, port, host="127.0.0.1", config_path=None, config_route="/app/config.js",
          env_path=None, keys=DEFAULT_KEYS, routes=None):
    """Build and run forever. This is what an app's thin web-server.py wrapper calls."""
    if env_path:
        env_vals = load_env(env_path, keys)
        loaded = sum(1 for k in keys if env_vals.get(k))
        print("[web] config secret injection: %d/%d keys loaded from .env" % (loaded, len(keys)), flush=True)
    server = build_server(root, port, host, config_path, config_route, env_path, keys, routes)
    server.serve_forever()
