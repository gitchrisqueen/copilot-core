# copilot-core

Shared base for a family of local-first, real-time "live copilot" apps: browser JS that
transcribes audio, tracks a live transcript, identifies speakers, and calls an LLM with
provider failover -- plus the small Python sidecars those apps run alongside a plain static
file server. Zero build step and no runtime npm dependencies; the Python package has no
mandatory dependencies either (the web/log servers and `.env` loader are stdlib only), but
`speaker.engine` imports numpy and needs the `speaker` extra for real embeddings.

This package carries **no domain logic and no domain prompts**. It exists because two sibling
apps -- [hearing-copilot](https://github.com/gitchrisqueen/hearing-copilot) and
[tech-interview-copilot](https://github.com/gitchrisqueen/tech-interview-copilot) -- forked from
a common ancestor and re-converged on nearly the same transcription/speaker-ID/LLM-transport
machinery. This is that machinery, extracted once.

## What's here

**JavaScript** (`js/`, loaded via plain `<script>` tags -- no bundler, no import maps; every
module publishes a `window` global):

| File | Publishes | What it does |
|---|---|---|
| `md.js` | `MD` | Dependency-free Markdown -> HTML (headings, tables, lists, inline formatting) |
| `layout.js` | `CopilotLayout` | Collapsible panel + draggable row/column dividers, namespaced localStorage keys |
| `settings.js` | `SETTINGS` | Fetches per-machine `settings.json`, deep-merges over `window.CONFIG` |
| `transcript.js` | `TLOG` | Dated, editable transcript store (localStorage + disk mirror) |
| `asr.js` | `ASR` | VAD-chunked dual audio capture, transcription with failover (Together AI -> local whisper, with a cooldown circuit breaker) or a separate Web Speech engine mode (`CONFIG.asr.engine = "webspeech"`, remote side only), speaker-ID hand-off |
| `llm-transport.js` | `LLM` | Provider failover (Ollama, Ollama Cloud, OpenAI, Groq), JSON-mode chat, and a `registerTask`/`runTask` prompt-pack registry -- apps own every prompt |
| `shell.js` | `CopilotShell` | `el`, HTML-escaping, a debug logger factory, a notification ring buffer |

`css/base.css` is the shared shell: design tokens, the two-column grid, panel/tabbar scaffolding,
dividers, the collapsible copilot panel, markdown typography, and a few generic components (card
shell, chip, notifier, transcript list, voice pills). Apps load their own `domain.css` after it.

**Python** (`src/copilot_core/`, installed as the `copilot-core` package):

| Module | What it does |
|---|---|
| `envfile` | Minimal `.env` loader (env vars always win over the file) |
| `webserver` | No-cache static file server that injects `.env` secrets into a `%PLACEHOLDER%` config file, refuses to serve dotfiles, and supports app-owned virtual routes |
| `logserver` | Transcript JSONL log + `/settings` store + a server-side Together AI transcription proxy |
| `speaker.engine` | `SpeakerEngine` -- CAM++ voice embeddings (via sherpa-onnx), online clustering, EMA-learned centroids, accept/suggest/margin thresholds. Accepts an injected `embed_fn` so it's testable (and usable) without the ONNX model. Needs numpy either way (`pip install 'copilot-core[speaker]'` for the real embedder). |

Each app's own `speaker-server.py` (an HTTP wrapper around `SpeakerEngine`, plus any
app-specific policy like mapping anonymous clusters to named roles) stays in that app's repo --
that mapping policy is inherently app-specific and isn't part of this package.

## Using it from an app

Neither package is on a public registry yet: the tag-driven release workflow exists, but its npm
and PyPI publish jobs have failed on every tag so far (registry auth is not configured), so
`npm install @gitchrisqueen/copilot-core` and `pip install copilot-core` both 404. Both sibling
apps install straight from a git tag instead, and that is the supported path today.

JS: `npm install github:gitchrisqueen/copilot-core#v0.1.1`, then load the files you need with
plain relative script tags before your own app scripts:

```html
<link rel="stylesheet" href="node_modules/@gitchrisqueen/copilot-core/css/base.css">
<link rel="stylesheet" href="app/domain.css">
<script src="node_modules/@gitchrisqueen/copilot-core/js/md.js"></script>
<script src="node_modules/@gitchrisqueen/copilot-core/js/settings.js"></script>
<script src="app/config.js"></script>
<!-- ...your app's own modules, then... -->
<script src="node_modules/@gitchrisqueen/copilot-core/js/layout.js"></script>
```

Python: `pip install 'copilot-core @ git+https://github.com/gitchrisqueen/copilot-core@v0.1.1'`,
then write a small wrapper for each sidecar:

```python
# app/web-server.py
from copilot_core.webserver import serve
serve(root=ROOT, port=PORT, config_path=CONFIG_PATH, env_path=ENV_PATH,
      routes={"/app/data.js": render_my_app_specific_route})
```

## Configuration surface

Apps set `window.CopilotCore` (in their own `config.js`, before core scripts load) to control the
shared modules:

```js
window.CopilotCore = {
  ns: "myapp",                          // localStorage key prefix (layout.js, transcript.js)
  transcript: {
    roleField: "speaker",                     // optional: rename the segment's role property (default "role")
                                               // -- lets an app with an existing schema (e.g. a large amount
                                               // of code already reading `seg.speaker`) adopt this module
                                               // without a rename sweep
    persistKeys: ["text", "role", "name"],   // which fields trigger a disk rewrite on update()
                                               // (defaults to ["text", <roleField>, "name"])
    labelFor: function (seg) { ... }          // optional custom display-label formatter
  },
  asr: {
    identifyParams: function (role, ts, voicedMs) { return { hint: "..." }; }  // optional extra
    // query params sent to the speaker-ID sidecar's /identify call
  },
  llm: {
    contextBlock: function (taskName) { return "..."; }  // optional block auto-appended to every
    // registered task's system prompt, so no caller can accidentally drop required context
  }
};
```

Register domain LLM tasks (core ships zero prompts):

```js
LLM.registerTask("summarize", {
  system: "You are ...",
  buildUser: function (ctx) { return ctx.transcript; },
  opts: { timeoutMs: 20000 }
});
const result = await LLM.runTask("summarize", ctx);
```

## Development

```bash
npm install && npm test          # node:test + c8 coverage (lcov + text)
pip install -e '.[dev]' && ruff check . && pytest --cov=copilot_core
```

The `npm test` script passes the `test/js/` directory to `node --test`, which newer Node
releases reject (on Node 26 it fails with "Cannot find module .../test/js"). CI runs the glob
form on Node 22, which is what to use if `npm test` fails for you:

```bash
npx c8 -r lcov -r text node --test test/js/**/*.test.js
```

CI (`.github/workflows/ci.yml`) runs the JS suite on Node 22, the Python suite plus `ruff check`
on Python 3.11 and 3.13, and shellcheck on any `*.command` scripts (there are none in this repo).
Coverage is uploaded to Codecov with an 80% project/patch gate (`codecov.yml`).

## Versioning

Semver, one version tracked across `package.json` and `pyproject.toml` (currently 0.1.1; tags
`v0.1.0` and `v0.1.1` exist). Apps pin an exact git tag (`package.json` / `requirements.txt`);
upgrades are deliberate PRs in each app's own repo. See [CONTRIBUTING](CONTRIBUTING.md) for the
branch/CI/release setup.

## License

MIT. See [LICENSE](LICENSE).
