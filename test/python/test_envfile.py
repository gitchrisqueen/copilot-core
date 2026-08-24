import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from copilot_core.envfile import load_env, seed_environ


def write_env(tmp_path, content):
    p = tmp_path / ".env"
    p.write_text(content)
    return str(p)


def test_load_env_parses_key_value_lines(tmp_path):
    path = write_env(tmp_path, "FOO=bar\nBAZ=\"quoted\"\n# comment\n\nQUX='single'\n")
    vals = load_env(path)
    assert vals == {"FOO": "bar", "BAZ": "quoted", "QUX": "single"}


def test_load_env_missing_file_returns_empty_dict(tmp_path):
    assert load_env(str(tmp_path / "nope.env")) == {}


def test_load_env_real_environ_overrides_file(tmp_path, monkeypatch):
    path = write_env(tmp_path, "FOO=file_value\n")
    monkeypatch.setenv("FOO", "env_value")
    vals = load_env(path, keys=["FOO"])
    assert vals["FOO"] == "env_value"


def test_load_env_unset_env_does_not_override(tmp_path, monkeypatch):
    monkeypatch.delenv("FOO", raising=False)
    path = write_env(tmp_path, "FOO=file_value\n")
    vals = load_env(path, keys=["FOO"])
    assert vals["FOO"] == "file_value"


def test_seed_environ_does_not_clobber_existing_env_var(tmp_path, monkeypatch):
    monkeypatch.setenv("SEEDED", "already-set")
    path = write_env(tmp_path, "SEEDED=from-file\nNEWVAR=new\n")
    seed_environ(path)
    assert os.environ["SEEDED"] == "already-set"
    assert os.environ["NEWVAR"] == "new"
    del os.environ["NEWVAR"]
