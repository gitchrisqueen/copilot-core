"""Tests for logserver's Together AI proxy and startup check, using a fake urllib.request so no
real network call is ever made in CI."""
import http.client
import io
import json
import os
import sys
import threading
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from copilot_core import logserver


class FakeResponse:
    def __init__(self, status, body, headers=None):
        self.status = status
        self._body = body
        self.headers = headers or {}

    def read(self):
        return self._body

    def getheader(self, name, default=None):  # pragma: no cover -- not exercised by these tests
        return self.headers.get(name, default)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def start_server(tmp_path):
    server = logserver.build_server(str(tmp_path))
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, server.server_address[1]


def post_multipart(port, path="/asr"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    body = b"--x\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nfakewav\r\n--x--\r\n"
    conn.request("POST", path, body=body, headers={"Content-Type": "multipart/form-data; boundary=x"})
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


def test_proxy_asr_success_passes_through_response(tmp_path, monkeypatch):
    def fake_urlopen(req, timeout=60):
        assert req.full_url == logserver.ASR_UPSTREAM
        return FakeResponse(200, json.dumps({"text": "hello"}).encode("utf-8"),
                             {"Content-Type": "application/json"})
    monkeypatch.setattr(logserver.urllib.request, "urlopen", fake_urlopen)
    server, port = start_server(tmp_path)
    try:
        status, data = post_multipart(port)
        assert status == 200
        assert json.loads(data) == {"text": "hello"}
    finally:
        server.shutdown()


def test_proxy_asr_retries_on_503_then_succeeds(tmp_path, monkeypatch):
    calls = {"n": 0}

    def fake_urlopen(req, timeout=60):
        calls["n"] += 1
        if calls["n"] < 3:
            raise urllib.error.HTTPError(logserver.ASR_UPSTREAM, 503, "busy", {}, io.BytesIO(b'{"error":"busy"}'))
        return FakeResponse(200, json.dumps({"text": "ok after retry"}).encode("utf-8"))
    monkeypatch.setattr(logserver.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(logserver.time, "sleep", lambda s: None)  # don't actually wait in tests
    server, port = start_server(tmp_path)
    try:
        status, data = post_multipart(port)
        assert status == 200
        assert json.loads(data)["text"] == "ok after retry"
        assert calls["n"] == 3
    finally:
        server.shutdown()


def test_proxy_asr_gives_up_after_repeated_5xx_and_passes_through_the_error(tmp_path, monkeypatch):
    def fake_urlopen(req, timeout=60):
        raise urllib.error.HTTPError(logserver.ASR_UPSTREAM, 503, "busy", {}, io.BytesIO(b'{"error":"still busy"}'))
    monkeypatch.setattr(logserver.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(logserver.time, "sleep", lambda s: None)
    server, port = start_server(tmp_path)
    try:
        status, data = post_multipart(port)
        assert status == 503
        assert b"still busy" in data
    finally:
        server.shutdown()


def test_proxy_asr_non_retryable_http_error_passes_through_immediately(tmp_path, monkeypatch):
    calls = {"n": 0}

    def fake_urlopen(req, timeout=60):
        calls["n"] += 1
        raise urllib.error.HTTPError(logserver.ASR_UPSTREAM, 401, "unauthorized", {}, io.BytesIO(b'{"error":"bad key"}'))
    monkeypatch.setattr(logserver.urllib.request, "urlopen", fake_urlopen)
    server, port = start_server(tmp_path)
    try:
        status, data = post_multipart(port)
        assert status == 401
        assert calls["n"] == 1, "a 401 must not be retried"
    finally:
        server.shutdown()


def test_proxy_asr_generic_exception_retries_then_returns_502(tmp_path, monkeypatch):
    def fake_urlopen(req, timeout=60):
        raise ConnectionResetError("boom")
    monkeypatch.setattr(logserver.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(logserver.time, "sleep", lambda s: None)
    server, port = start_server(tmp_path)
    try:
        status, data = post_multipart(port)
        assert status == 502
        assert json.loads(data)["error"]
    finally:
        server.shutdown()


def test_proxy_asr_uses_bearer_auth_from_environ_when_no_authorization_header(tmp_path, monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout=60):
        seen["auth"] = req.headers.get("Authorization")
        return FakeResponse(200, b'{"text":"x"}')
    monkeypatch.setattr(logserver.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("TOGETHER_API_KEY", "env-key-123")
    server, port = start_server(tmp_path)
    try:
        post_multipart(port)
        assert seen["auth"] == "Bearer env-key-123"
    finally:
        server.shutdown()


def test_startup_asr_check_no_key_configured(capsys, monkeypatch):
    monkeypatch.delenv("TOGETHER_API_KEY", raising=False)
    logserver.startup_asr_check()
    out = capsys.readouterr().out
    assert "not configured" in out


def test_startup_asr_check_connects_successfully(capsys, monkeypatch):
    monkeypatch.setenv("TOGETHER_API_KEY", "k")

    def fake_urlopen(req, timeout=10):
        return FakeResponse(200, b"{}")
    monkeypatch.setattr(logserver.urllib.request, "urlopen", fake_urlopen)
    logserver.startup_asr_check()
    out = capsys.readouterr().out
    assert "CONNECTED" in out


def test_startup_asr_check_reports_http_error(capsys, monkeypatch):
    monkeypatch.setenv("TOGETHER_API_KEY", "bad-key")

    def fake_urlopen(req, timeout=10):
        raise urllib.error.HTTPError(logserver.ASR_MODELS, 401, "unauthorized", {}, io.BytesIO(b""))
    monkeypatch.setattr(logserver.urllib.request, "urlopen", fake_urlopen)
    logserver.startup_asr_check()
    out = capsys.readouterr().out
    assert "connection check failed" in out


def test_startup_asr_check_reports_generic_error(capsys, monkeypatch):
    monkeypatch.setenv("TOGETHER_API_KEY", "k")

    def fake_urlopen(req, timeout=10):
        raise OSError("network unreachable")
    monkeypatch.setattr(logserver.urllib.request, "urlopen", fake_urlopen)
    logserver.startup_asr_check()
    out = capsys.readouterr().out
    assert "connection check error" in out
