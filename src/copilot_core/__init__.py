"""copilot_core: shared Python sidecars for live copilot apps (web server with secret
injection, transcript/settings/ASR-proxy log server, and a speaker-ID embedding engine).

Zero mandatory dependencies (stdlib only). The `speaker` extra pulls in numpy + sherpa-onnx
for real voice embeddings; without it, callers can still use SpeakerEngine with an injected
embed_fn (as the test suite does) so the pure clustering/threshold/EMA logic is usable and
testable without the ONNX model.
"""

__version__ = "0.1.1"
