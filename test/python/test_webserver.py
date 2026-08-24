import http.client
import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from copilot_core import webserver


def start_server(**kwargs):
    server = webserver.build_server(**kwargs)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    port = server.server_address[1]
    return server, port


def get(port, path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path)
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, body


def test_secret_injection_replaces_placeholders_and_never_touches_disk(tmp_path):
    root = tmp_path
    (root / "app").mkdir()
    config_path = root / "app" / "config.js"
    original = 'window.CONFIG = { key: "%OPENAI_API_KEY%" };'
    config_path.write_text(original)
    env_path = root / ".env"
    env_path.write_text("OPENAI_API_KEY=sk-secret-value\n")

    server, port = start_server(
        root=str(root), config_path=str(config_path), env_path=str(env_path),
        keys=("OPENAI_API_KEY",),
    )
    try:
        status, body = get(port, "/app/config.js")
        assert status == 200
        assert b"sk-secret-value" in body
        # The secret must never be written back to the committed file on disk.
        assert "sk-secret-value" not in config_path.read_text()
        assert "%OPENAI_API_KEY%" in config_path.read_text()
    finally:
        server.shutdown()


def test_dotfiles_are_refused_even_though_env_lives_under_root(tmp_path):
    root = tmp_path
    (root / ".env").write_text("OPENAI_API_KEY=super-secret\n")
    server, port = start_server(root=str(root))
    try:
        status, body = get(port, "/.env")
        assert status == 404
        assert b"super-secret" not in body
    finally:
        server.shutdown()


def test_custom_virtual_route_is_served_before_falling_through_to_static(tmp_path):
    root = tmp_path
    calls = []

    def render_data():
        calls.append(1)
        return b"window.CASE = { title: 'demo' };"

    server, port = start_server(root=str(root), routes={"/app/data.js": render_data})
    try:
        status, body = get(port, "/app/data.js")
        assert status == 200
        assert b"window.CASE" in body
        assert len(calls) == 1
    finally:
        server.shutdown()


def test_ordinary_static_files_still_served_with_no_cache_headers(tmp_path):
    root = tmp_path
    (root / "index.html").write_text("<html>hi</html>")
    server, port = start_server(root=str(root))
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/index.html")
        resp = conn.getresponse()
        body = resp.read()
        assert resp.status == 200
        assert b"hi" in body
        assert resp.getheader("Cache-Control") == "no-store, no-cache, must-revalidate, max-age=0"
    finally:
        server.shutdown()


def test_load_env_real_env_var_overrides_file(tmp_path, monkeypatch):
    env_path = tmp_path / ".env"
    env_path.write_text("OPENAI_API_KEY=file-value\n")
    monkeypatch.setenv("OPENAI_API_KEY", "real-env-value")
    vals = webserver.load_env(str(env_path), keys=("OPENAI_API_KEY",))
    assert vals["OPENAI_API_KEY"] == "real-env-value"


def test_load_env_missing_file_returns_empty_dict(tmp_path):
    assert webserver.load_env(str(tmp_path / "nope.env"), keys=("OPENAI_API_KEY",)) == {}


def test_serve_prints_key_count_then_delegates_to_build_server(tmp_path, monkeypatch, capsys):
    env_path = tmp_path / ".env"
    env_path.write_text("OPENAI_API_KEY=x\n")
    calls = {}

    class FakeServer:
        def serve_forever(self):
            calls["served"] = True

    def fake_build_server(*a, **kw):
        calls["build_args"] = (a, kw)
        return FakeServer()

    monkeypatch.setattr(webserver, "build_server", fake_build_server)
    webserver.serve(str(tmp_path), 0, env_path=str(env_path), keys=("OPENAI_API_KEY", "GROQ_API_KEY"))
    out = capsys.readouterr().out
    assert "1/2 keys loaded" in out
    assert calls.get("served") is True
