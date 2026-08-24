import http.client
import json
import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from copilot_core import logserver


def start_server(tmp_path, settings_path=None):
    server = logserver.build_server(str(tmp_path), settings_path=settings_path)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, server.server_address[1]


def request(port, method, path, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    parsed = json.loads(raw) if raw else None
    return resp.status, parsed


def test_post_appends_a_segment_and_get_returns_it_sorted_by_ts(tmp_path):
    server, port = start_server(tmp_path)
    try:
        status, body = request(port, "POST", "/", {"id": "t2", "ts": "2026-01-01T00:00:02", "date": "2026-01-01", "text": "second"})
        assert status == 200 and body["ok"] is True
        status, body = request(port, "POST", "/", {"id": "t1", "ts": "2026-01-01T00:00:01", "date": "2026-01-01", "text": "first"})
        assert status == 200

        status, body = request(port, "GET", "/log?date=2026-01-01")
        assert status == 200
        segs = body["segments"]
        assert [s["id"] for s in segs] == ["t1", "t2"], "sorted by ts, not insertion order"
    finally:
        server.shutdown()


def test_post_same_id_twice_is_an_edit_last_write_wins(tmp_path):
    server, port = start_server(tmp_path)
    try:
        request(port, "POST", "/", {"id": "t1", "ts": "2026-01-01T00:00:01", "date": "2026-01-01", "text": "original"})
        request(port, "POST", "/", {"id": "t1", "ts": "2026-01-01T00:00:01", "date": "2026-01-01", "text": "corrected"})
        status, body = request(port, "GET", "/log?date=2026-01-01")
        segs = body["segments"]
        assert len(segs) == 1
        assert segs[0]["text"] == "corrected"
    finally:
        server.shutdown()


def test_delete_removes_the_days_file(tmp_path):
    server, port = start_server(tmp_path)
    try:
        request(port, "POST", "/", {"id": "t1", "ts": "2026-01-01T00:00:01", "date": "2026-01-01", "text": "x"})
        status, body = request(port, "DELETE", "/log?date=2026-01-01")
        assert status == 200 and body["ok"] is True
        status, body = request(port, "GET", "/log?date=2026-01-01")
        assert body["segments"] == []
    finally:
        server.shutdown()


def test_settings_roundtrip(tmp_path):
    settings_path = tmp_path / "settings.json"
    server, port = start_server(tmp_path, settings_path=str(settings_path))
    try:
        status, body = request(port, "GET", "/settings")
        assert status == 200 and body == {}, "missing settings file -> {}"
        status, body = request(port, "POST", "/settings", {"asr": {"engine": "whisper"}})
        assert status == 200 and body["ok"] is True
        status, body = request(port, "GET", "/settings")
        assert body == {"asr": {"engine": "whisper"}}
        assert settings_path.exists()
    finally:
        server.shutdown()


def test_settings_post_rejects_non_object_body(tmp_path):
    server, port = start_server(tmp_path)
    try:
        status, body = request(port, "POST", "/settings", [1, 2, 3])
        assert status == 400 and body["ok"] is False
    finally:
        server.shutdown()


def test_safe_date_strips_unsafe_characters():
    assert logserver.safe_date("2026-01-01") == "2026-01-01"
    assert logserver.safe_date("../../etc/passwd") == "etcpasswd"
    assert logserver.safe_date("") != ""  # falls back to today's date, never empty
