"""Minimal .env loader. No dependency on python-dotenv; parses simple KEY=VALUE lines only."""
import os


def load_env(path, keys=None):
    """Read a .env file (KEY=VALUE lines, '#' comments, optional quotes) into a dict.

    A real environment variable for a name in `keys` always overrides the file value. If
    `keys` is None, every KEY=VALUE line in the file is loaded (env still wins per-key).
    Missing file -> empty dict (never raises).
    """
    vals = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    names = keys if keys is not None else list(vals.keys())
    for k in names:
        if os.environ.get(k):
            vals[k] = os.environ[k]
    return vals


def seed_environ(path, keys=None):
    """Load a .env file into os.environ, without overriding real environment variables already set."""
    vals = load_env(path, keys)
    for k, v in vals.items():
        if not os.environ.get(k):
            os.environ[k] = v
    return vals
