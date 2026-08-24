import hashlib
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from copilot_core.speaker.engine import Profile, SpeakerEngine

EMB_DIM = 32


def deterministic_embed_fn(seed_label):
    """A fake embedder: same seed_label -> same (unit) vector, different labels -> different
    vectors, so clustering behavior is exercised without any real audio or the ONNX model."""
    def embed(samples, sample_rate):
        h = hashlib.sha256(seed_label.encode("utf-8")).digest()
        vec = np.frombuffer((h * ((EMB_DIM * 4) // len(h) + 1))[: EMB_DIM * 4], dtype=np.uint32).astype(np.float32)
        vec = vec / np.linalg.norm(vec)
        return vec
    return embed


def make_samples(n=96000):
    return np.zeros(n, dtype=np.float32)


def test_requires_model_path_or_embed_fn():
    with pytest.raises(ValueError):
        SpeakerEngine()


def test_first_chunk_spawns_a_new_anonymous_cluster():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    v = eng.identify(make_samples(), voiced_ms=3000)
    assert v["decision"] == "new"
    assert v["cluster"] == "V1"
    assert v["name"] is None
    assert len(eng.profiles) == 1


def test_same_voice_is_accepted_into_the_existing_cluster():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    eng.identify(make_samples(), voiced_ms=3000)  # spawns V1
    v = eng.identify(make_samples(), voiced_ms=3000)  # same seed -> same embedding -> accept
    assert v["decision"] == "accept"
    assert v["cluster"] == "V1"
    assert v["sim"] > 0.99  # identical vector


def test_short_unvoiced_chunk_never_spawns_a_cluster():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    v = eng.identify(make_samples(), voiced_ms=500)  # below min_spawn_ms
    assert v["decision"] == "unknown"
    assert v["cluster"] is None
    assert len(eng.profiles) == 0


def test_label_turns_an_anonymous_cluster_into_a_persistent_named_profile():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    eng.identify(make_samples(), voiced_ms=3000)
    assert eng.profiles[0].persistent is False
    eng.label("V1", "Alice")
    assert eng.profiles[0].name == "Alice"
    assert eng.profiles[0].persistent is True


def test_save_only_persists_named_profiles(tmp_path):
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    eng.identify(make_samples(), voiced_ms=3000)  # anonymous V1 -- never named
    path = str(tmp_path / "profiles.json")
    eng.save(path)
    loaded = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    assert loaded.load(path) == 0, "anonymous clusters must not be persisted"

    eng.label("V1", "Alice")
    eng.save(path)
    loaded2 = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    n = loaded2.load(path)
    assert n == 1
    assert loaded2.profiles[0].name == "Alice"


def test_merge_folds_source_cluster_into_destination_and_removes_it():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    eng.identify(make_samples(), voiced_ms=3000)  # V1 (alice-like)
    # Force a second distinct cluster by nudging the engine's embed_fn between calls.
    eng._embed_fn = deterministic_embed_fn("bob")
    eng.suggest = 2.0  # impossible threshold -> guarantees a new spawn instead of accept/suggest
    eng.accept = 2.0
    eng.identify(make_samples(), voiced_ms=3000)  # V2 (bob-like)
    assert len(eng.profiles) == 2

    merged = eng.merge("V2", "V1")
    assert merged is not None
    assert merged.pid == "V1"
    assert len(eng.profiles) == 1
    assert eng.profiles[0].n == 2  # combined chunk count


def test_confirm_trains_the_named_profile_on_the_exact_chunk_by_timestamp():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000, min_train_ms=999999)
    eng.identify(make_samples(), voiced_ms=3000, ts=1000)  # min_train_ms huge -> no passive EMA yet
    before_n = eng.profiles[0].n
    result = eng.confirm(1000, "V1")
    assert result is not None
    assert eng.profiles[0].n == before_n + 1


def test_embed_standardizes_short_and_long_input_to_embed_samples_length():
    eng = SpeakerEngine(embed_fn=lambda samples, sr: samples[:8].astype(np.float32) if len(samples) >= 8 else np.pad(samples, (0, 8 - len(samples))))
    short = np.ones(100, dtype=np.float32)
    long = np.ones(200000, dtype=np.float32)
    # _standardize is what feeds embed_fn; assert it always produces EMBED_SAMPLES-length input.
    assert len(eng._standardize(short)) == SpeakerEngine.EMBED_SAMPLES
    assert len(eng._standardize(long)) == SpeakerEngine.EMBED_SAMPLES


def test_remove_deletes_a_profile():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    eng.identify(make_samples(), voiced_ms=3000)
    assert eng.remove("V1") is True
    assert eng.remove("V1") is False
    assert len(eng.profiles) == 0


def test_confirm_returns_none_for_an_unknown_timestamp():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    eng.identify(make_samples(), voiced_ms=3000, ts=1000)
    assert eng.confirm(9999, "V1") is None  # no chunk was remembered at ts=9999


def test_confirm_returns_none_for_an_unknown_pid():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    eng.identify(make_samples(), voiced_ms=3000, ts=1000)
    assert eng.confirm(1000, "V999") is None


def test_merge_returns_none_when_either_pid_is_unknown_or_they_are_the_same():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    eng.identify(make_samples(), voiced_ms=3000)  # V1
    assert eng.merge("V1", "V1") is None
    assert eng.merge("V1", "V999") is None
    assert eng.merge("V999", "V1") is None


def test_label_returns_none_for_an_unknown_pid():
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    assert eng.label("V999", "Nobody") is None


def test_load_returns_zero_on_corrupt_json(tmp_path):
    path = tmp_path / "profiles.json"
    path.write_text("{not valid json")
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    assert eng.load(str(path)) == 0


def test_load_returns_zero_when_file_is_missing(tmp_path):
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000)
    assert eng.load(str(tmp_path / "nope.json")) == 0


def test_below_suggest_threshold_with_existing_profiles_spawns_or_reports_unknown():
    # A voice unlike the one profile on record: below both thresholds -> spawn (enough audio) or
    # unknown (not enough audio), exercising _spawn_or_unknown's "existing profiles" call path.
    eng = SpeakerEngine(embed_fn=deterministic_embed_fn("alice"), min_spawn_ms=2000, accept=2.0, suggest=2.0)
    eng.identify(make_samples(), voiced_ms=3000)  # V1, alice-like
    eng._embed_fn = deterministic_embed_fn("carol")
    v = eng.identify(make_samples(), voiced_ms=3000)  # thresholds impossible -> always below suggest
    assert v["decision"] == "new"
    assert len(eng.profiles) == 2

    v2 = eng.identify(make_samples(), voiced_ms=500, allow_spawn=False)  # too little audio, spawn disabled
    assert v2["decision"] == "unknown"
    assert v2["cluster"] is None


def test_profile_to_dict_from_dict_roundtrip():
    emb = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    p = Profile("V1", "Alice", emb, n=3)
    d = p.to_dict()
    p2 = Profile.from_dict(d)
    assert p2.pid == "V1"
    assert p2.name == "Alice"
    assert p2.n == 3
    assert np.allclose(p2.centroid, p.centroid)
