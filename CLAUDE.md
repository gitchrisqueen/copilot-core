# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repo.

## Purpose

Shared, domain-free base for the "live copilot" apps (hearing-copilot, tech-interview-copilot):
browser JS for transcription, transcript storage, layout, settings and LLM transport with
provider failover, plus small Python sidecars (static web server, log server, speaker-ID
engine). It ships **no domain logic and no prompts**; apps register their own tasks.

## Stack

- **JS** (`js/`, `css/base.css`): plain browser scripts loaded with `<script>` tags. No bundler,
  no ES modules, no runtime npm dependencies. Each file publishes one `window` global
  (`MD`, `CopilotLayout`, `SETTINGS`, `TLOG`, `ASR`, `LLM`, `CopilotShell`).
- **Python** (`src/copilot_core/`): Python >= 3.9, stdlib only except `speaker.engine`
  (numpy; sherpa-onnx via the `speaker` extra). Built with hatchling.
- Node >= 18 (CI uses Node 22); Python 3.11 and 3.13 in CI.

## Running tests

```bash
npm ci
npm run check                                   # node --check on every js/*.js
npx c8 -r lcov -r text node --test test/js/**/*.test.js   # what CI runs

pip install -e '.[dev]'
ruff check .
pytest --cov=copilot_core test/python/
```

`npm test` passes a directory to `node --test`, which fails on newer Node versions; use the glob
form above if it does. Codecov enforces an 80% project and patch gate (`codecov.yml`).

## Conventions

- Zero-build: do not add a bundler, transpiler, or runtime npm/pip dependency without a clear
  reason in the PR.
- Keep every JS module a self-contained `window` global; apps depend on script load order.
- No domain prompts or app-specific policy here (for example, speaker-to-role mapping stays in
  each app's own sidecar).
- Python style is `ruff` with `E`, `F`, `W` only (see `pyproject.toml`); I/O around sidecars
  fails soft on purpose.
- One version, kept in lockstep across `package.json` and `pyproject.toml` (semver). Releases
  are tag-driven (`vX.Y.Z`); apps pin an exact git tag.
- Every PR runs `ci.yml` (`js`, `python`, `shell`) and `claude-review`. See `CONTRIBUTING.md`
  for branch protection and release setup.
- Never commit secrets; `example.env` documents the variables.
