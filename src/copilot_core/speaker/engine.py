# Speaker-identification core: per-chunk voice embeddings (sherpa-onnx CAM++, or an injected
# embed_fn for testing) + named profiles + online clustering. Deliberately UI-free and
# server-free; an app's speaker-server.py wraps it in a sidecar.
#
# Decision policy (two thresholds):
#   - sim >= accept  -> auto-assign to that voice
#   - sim >= suggest -> show it as a suggestion, never auto-apply
#   - below both     -> spawn a NEW cluster (only when the chunk has enough clean audio to trust
#                       the embedding), otherwise report unknown. Never a guess.
# The best match must also beat the runner-up by min_margin_pct, so an ambiguous chunk between two
# similar voices is never auto-assigned. Centroids learn by EMA only from confident, long-enough
# chunks, so one bad chunk cannot rot a profile.
#
# Clusters here carry a NAME only -- there is no party/role concept. An app that needs to map
# anonymous clusters to named roles (e.g. a courtroom's plaintiff/court/defendant) builds that as
# its own layer around this engine (a UI hint + a mapping histogram); it does not belong here
# because the mapping policy is inherently app-specific.

import json
import os
import tempfile
from collections import deque

import numpy as np


class Profile:
    def __init__(self, pid, name, emb, n=1):
        self.pid = pid                  # stable id, e.g. "V1"
        self.name = name                # display name, or None until the user names it
        self.centroid = emb / np.linalg.norm(emb)
        self.n = n                      # chunks absorbed (reporting only)

    def absorb(self, emb, ema):
        c = (1.0 - ema) * self.centroid + ema * (emb / np.linalg.norm(emb))
        self.centroid = c / np.linalg.norm(c)
        self.n += 1

    @property
    def persistent(self):
        # Named voices are worth keeping across sessions. Anonymous clusters (V1..Vn that nobody
        # named) die with the session.
        return bool(self.name)

    def to_dict(self):
        return dict(pid=self.pid, name=self.name, n=self.n,
                    centroid=[round(float(x), 6) for x in self.centroid])

    @classmethod
    def from_dict(cls, d):
        return cls(d["pid"], d.get("name"), np.array(d["centroid"], dtype=np.float32),
                   n=int(d.get("n", 1)))


class SpeakerEngine:
    # Empirical finding: the sherpa-onnx CAM++ export returns garbage embeddings for certain
    # input DURATIONS (3 s, 5 s, 7 s, 8.5 s, 15 s are broken while 2/4/6/8/10/12/20 s are fine,
    # independent of content). Variable-length VAD chunks therefore embedded as noise about half
    # the time. Every embedding input is standardized to a fixed known-good length: longer audio
    # is center-cropped, shorter audio is TILED (repetition preserves the voice; zero-padding does
    # not). Do not remove this.
    EMBED_SAMPLES = 96000   # 6.0 s at 16 kHz

    def __init__(self, model_path=None, num_threads=2, accept=0.65, suggest=0.45,
                 min_margin_pct=15.0, ema=0.10, min_train_ms=1500, min_spawn_ms=2000,
                 provider="cpu", embed_fn=None):
        """model_path: path to the sherpa-onnx CAM++ .onnx model (lazily imports sherpa_onnx).
        embed_fn(samples: np.ndarray, sample_rate: int) -> np.ndarray: inject a fake/deterministic
        embedder for tests, so the clustering/threshold/EMA math is testable without the 28 MB
        ONNX model or the sherpa_onnx package. Exactly one of model_path/embed_fn must be given.
        """
        if embed_fn is not None:
            self._embed_fn = embed_fn
            self.extractor = None
        elif model_path is not None:  # pragma: no cover -- requires the real sherpa-onnx package
            # and a downloaded ONNX model; never exercised in CI (see test/python/test_engine.py's
            # module docstring). Covered instead by the manual eval/diarization bake-off.
            import sherpa_onnx  # lazy: only required on the real-embedding path
            cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=model_path, num_threads=num_threads, provider=provider)
            if not cfg.validate():
                raise ValueError("bad speaker embedding model config: " + model_path)
            self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
            self._embed_fn = None
        else:
            raise ValueError("SpeakerEngine requires either model_path or embed_fn")
        self.accept = accept
        self.suggest = suggest
        self.min_margin_pct = min_margin_pct
        self.ema = ema
        self.min_train_ms = min_train_ms
        self.min_spawn_ms = min_spawn_ms
        self.profiles = []
        self._next_cluster = 1
        # Recent chunk embeddings by ts, so a user correction arriving seconds later (/confirm)
        # can still train on the exact audio it is about.
        self._recent = deque(maxlen=600)

    def _standardize(self, samples):
        n = len(samples)
        if n >= self.EMBED_SAMPLES:
            off = (n - self.EMBED_SAMPLES) // 2
            return samples[off:off + self.EMBED_SAMPLES]
        reps = int(np.ceil(self.EMBED_SAMPLES / max(1, n)))
        return np.tile(samples, reps)[:self.EMBED_SAMPLES]

    def embed(self, samples, sample_rate=16000):
        std = self._standardize(samples)
        if self._embed_fn is not None:
            emb = np.asarray(self._embed_fn(std, sample_rate), dtype=np.float32)
        else:
            s = self.extractor.create_stream()
            s.accept_waveform(sample_rate=sample_rate, waveform=std)
            s.input_finished()
            emb = np.array(self.extractor.compute(s), dtype=np.float32)
        return emb / np.linalg.norm(emb)

    # ----- profile management -----
    def label(self, pid, name):
        """Name a voice (or rename it). This is what turns an anonymous cluster into a
        persistent profile, and what the transcript labels its lines with."""
        for p in self.profiles:
            if p.pid == pid:
                p.name = (name or None)
                return p
        return None

    def confirm(self, ts, pid):
        """A user correction: the chunk at `ts` belongs to voice `pid`. Train that profile on
        that exact embedding (stronger than the passive EMA, still capped)."""
        emb = None
        for t, e, _cluster in self._recent:
            if t == ts:
                emb = e
                break
        if emb is None:
            return None
        for p in self.profiles:
            if p.pid == pid:
                p.absorb(emb, min(0.25, self.ema * 2))
                return p
        return None

    def merge(self, src_pid, dst_pid):
        """Fold one cluster into another (the same person split into two voices). The destination
        absorbs the source centroid, weighted by how much audio each has behind it."""
        src = dst = None
        for p in self.profiles:
            if p.pid == src_pid:
                src = p
            elif p.pid == dst_pid:
                dst = p
        if src is None or dst is None or src is dst:
            return None
        total = src.n + dst.n
        weight = min(0.5, src.n / float(total))
        dst.absorb(src.centroid, weight)
        dst.n = total          # absorb() already bumped n by 1; the merged count is the real total
        self.profiles = [p for p in self.profiles if p.pid != src_pid]
        return dst

    def remove(self, pid):
        before = len(self.profiles)
        self.profiles = [p for p in self.profiles if p.pid != pid]
        return len(self.profiles) < before

    # ----- persistence (named profiles only; see Profile.persistent) -----
    def save(self, path):
        data = dict(version=1, profiles=[p.to_dict() for p in self.profiles if p.persistent],
                    next_cluster=self._next_cluster)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)   # atomic: a crash mid-save never corrupts the store

    def load(self, path):
        try:
            with open(path) as f:
                data = json.load(f)
        except (FileNotFoundError, ValueError):
            return 0
        loaded = [Profile.from_dict(d) for d in data.get("profiles", [])]
        self.profiles = loaded + [p for p in self.profiles if not p.persistent]
        self._next_cluster = max(int(data.get("next_cluster", 1)), self._next_cluster)
        return len(loaded)

    # ----- the per-chunk decision -----
    def identify(self, samples, voiced_ms, sample_rate=16000, allow_spawn=True, train=True,
                 ts=None):
        """Return a verdict dict for one VAD chunk. When `ts` is given the embedding is
        remembered so a later /confirm can train on it."""
        emb = self.embed(samples, sample_rate)
        v = self._decide(emb, voiced_ms, allow_spawn, train)
        if ts is not None and v.get("cluster"):
            self._recent.append((ts, emb, v["cluster"]))
        return v

    def _decide(self, emb, voiced_ms, allow_spawn, train):
        if not self.profiles:
            return self._spawn_or_unknown(emb, voiced_ms, allow_spawn)

        sims = np.array([float(p.centroid @ emb) for p in self.profiles])
        order = np.argsort(-sims)
        best_i = int(order[0])
        best = float(sims[best_i])
        second = float(sims[int(order[1])]) if len(sims) > 1 else -1.0
        margin_pct = 100.0 * (best - second) / best if best > 0 else 0.0
        p = self.profiles[best_i]

        if best >= self.accept and (len(sims) == 1 or margin_pct >= self.min_margin_pct):
            if train and voiced_ms >= self.min_train_ms:
                p.absorb(emb, self.ema)
            decision = "accept"
        elif best >= self.suggest:
            decision = "suggest"
        else:
            return self._spawn_or_unknown(emb, voiced_ms, allow_spawn, best=best,
                                          margin_pct=margin_pct)

        return dict(decision=decision, cluster=p.pid, name=p.name,
                    sim=round(best, 4), margin_pct=round(margin_pct, 1))

    def _spawn_or_unknown(self, emb, voiced_ms, allow_spawn, best=None, margin_pct=None):
        # A voice unlike every profile: a NEW cluster if there is enough clean audio to trust the
        # embedding, otherwise an explicit unknown.
        if allow_spawn and voiced_ms >= self.min_spawn_ms:
            pid = "V%d" % self._next_cluster
            self._next_cluster += 1
            self.profiles.append(Profile(pid, None, emb))
            return dict(decision="new", cluster=pid, name=None,
                        sim=best if best is None else round(best, 4),
                        margin_pct=margin_pct if margin_pct is None else round(margin_pct, 1))
        return dict(decision="unknown", cluster=None, name=None,
                    sim=best if best is None else round(best, 4),
                    margin_pct=margin_pct if margin_pct is None else round(margin_pct, 1))
