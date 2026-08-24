"use strict";
// asr.js is the hardest module to unit-test honestly: most of it is getUserMedia/AudioContext
// browser wiring that has no meaningful fake short of a full jsdom + Web Audio shim. These tests
// cover what's actually pure: the exported junk-detection/rms/WAV-encode helpers, the public API
// shape, and the state-machine edges that don't need real audio (supported(), transcriber()
// defaults, stop() before start()). The getUserMedia-driven capture path is left uncovered here
// and is instead exercised end-to-end by the gauntlet demo-mode loop against a real browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, sameJSON } = require("./harness");

function boot() {
  const win = {
    CONFIG: { asr: {}, debug: false },
    console: console,
    navigator: { mediaDevices: null }, // no getUserMedia -> supported() should still work via SpeechRecognition check
  };
  load(win, "js/asr.js");
  return win;
}

test("asr: supported() is false with neither SpeechRecognition nor mediaDevices", () => {
  const win = boot();
  assert.equal(win.ASR.supported(), false);
});

test("asr: supported() is true when getUserMedia exists", () => {
  const win = boot();
  win.navigator.mediaDevices = { getUserMedia: () => {} };
  assert.equal(win.ASR.supported(), true);
});

test("asr: isListening() is false before start(), transcriber() defaults to plain whisper", () => {
  const win = boot();
  assert.equal(win.ASR.isListening(), false);
  sameJSON(win.ASR.transcriber(), { label: "whisper", degraded: false });
});

test("asr: stop() before start() does not throw and reports stopped", () => {
  const win = boot();
  assert.doesNotThrow(() => win.ASR.stop());
  assert.equal(win.ASR.isListening(), false);
});

test("asr: exposes flushRole/enableSelf/listDevices/meter/stopMeters (full API surface)", () => {
  const win = boot();
  ["start", "stop", "supported", "enableSelf", "flushRole", "listDevices", "meter", "stopMeters",
    "isListening", "engine", "transcriber"].forEach((k) => {
    assert.equal(typeof win.ASR[k], "function", k + " should be a function");
  });
});

test("asr._internal.isJunk: drops known whisper hallucinations, keeps real short lines", () => {
  const win = boot();
  const isJunk = win.ASR._internal.isJunk;
  assert.equal(isJunk("you"), true);
  assert.equal(isJunk("Thanks for watching!"), true);
  assert.equal(isJunk(""), true);
  assert.equal(isJunk("Objection."), false);
  assert.equal(isJunk("Correct."), false);
  assert.equal(isJunk("Why?"), false);
});

test("asr._internal.rms: root-mean-square of a sample buffer", () => {
  const win = boot();
  const rms = win.ASR._internal.rms;
  assert.equal(rms(new Float32Array([0, 0, 0])), 0);
  assert.ok(Math.abs(rms(new Float32Array([1, -1, 1, -1])) - 1) < 1e-9);
});

test("asr._internal.encodeWav: produces a valid 16-bit PCM WAV header", () => {
  const win = boot();
  const encodeWav = win.ASR._internal.encodeWav;
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const buf = encodeWav(samples, 16000, 16000);
  const view = new DataView(buf);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  assert.equal(riff, "RIFF");
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  assert.equal(wave, "WAVE");
  assert.equal(view.getUint32(24, true), 16000, "sample rate written into fmt chunk");
  assert.equal(buf.byteLength, 44 + samples.length * 2);
});

test("asr._internal.encodeWav: resamples when srcRate !== outRate", () => {
  const win = boot();
  const encodeWav = win.ASR._internal.encodeWav;
  const samples = new Float32Array(320); // 20ms @ 16kHz
  const buf = encodeWav(samples, 32000, 16000);
  assert.equal(buf.byteLength, 44 + 160 * 2, "downsampled to half the sample count");
});

// ---- Full capture pipeline, against a fake getUserMedia/AudioContext/fetch ----
// This is the actual regression surface the breakout plan called out: hearing-copilot calls
// ASR.flushRole() when its "who's speaking" toggle flips, so a short pause between speakers
// becomes a clean segment boundary instead of one merged, misattributed chunk. That behavior
// must survive the merge into a shared core module.

function makeStream(label) {
  return { getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ label }] };
}

function bootWithFakeAudio(cfg, fetchImpl) {
  const devices = [
    { kind: "audioinput", deviceId: "remote-id", label: "BlackHole 2ch" },
    { kind: "audioinput", deviceId: "mic-id", label: "MacBook Pro Microphone" }
  ];
  const win = {
    CONFIG: { asr: cfg, debug: false },
    console: console,
    FormData, Blob, setTimeout, clearTimeout,
    _contexts: [],
    navigator: {
      mediaDevices: {
        getUserMedia: (constraints) => {
          if (constraints.audio === true) return Promise.resolve(makeStream("primed"));
          const dev = devices.find((d) => d.deviceId === constraints.audio.deviceId.exact);
          return Promise.resolve(makeStream(dev ? dev.label : "unknown"));
        },
        enumerateDevices: () => Promise.resolve(devices)
      }
    },
    fetch: fetchImpl
  };
  win.AudioContext = function () {
    const node = { onaudioprocess: null, connect() {}, disconnect() {} };
    const ctx = {
      sampleRate: 16000, destination: {},
      createMediaStreamSource: () => ({ connect() {} }),
      createScriptProcessor: () => node,
      createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }),
      close: () => {},
      _node: node
    };
    win._contexts.push(ctx);
    return ctx;
  };
  load(win, "js/asr.js");
  return win;
}

function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 3); i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

function pushVoicedFrame(ctx) {
  // 4096 samples @ 16kHz = 256ms/frame, amplitude above the default VAD threshold (0.015).
  const data = new Float32Array(4096).fill(0.05);
  ctx._node.onaudioprocess({ inputBuffer: { getChannelData: () => data } });
}

test("asr: start() opens the configured remote device and begins capturing", async () => {
  const win = bootWithFakeAudio({ inputDeviceLabel: "blackhole", vad: { minMs: 999999, maxMs: 999999 } }, () => Promise.reject(new Error("no fetch expected yet")));
  const statuses = [];
  win.ASR.start({ onStatus: (s) => statuses.push(s), onFinal() {}, onError(e) { throw new Error("onError: " + e); } });
  await tick();
  assert.equal(win.ASR.isListening(), true);
  assert.equal(win._contexts.length, 1, "exactly one AudioContext for the single (remote) source");
  assert.ok(statuses.some((s) => s && s.indexOf("BlackHole") !== -1), "status reports the bound device");
});

test("asr: flushRole force-finalizes an in-flight utterance through the whisper path", async () => {
  const finals = [];
  const win = bootWithFakeAudio(
    { inputDeviceLabel: "blackhole", whisperUrl: "http://whisper", vad: { minMs: 999999, maxMs: 999999 } },
    () => Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ text: "hello there" })) })
  );
  win.ASR.start({ onFinal: (text, role) => finals.push({ text, role }), onStatus() {}, onError(e) { throw new Error("onError: " + e); } });
  await tick();
  const ctx = win._contexts[0];
  pushVoicedFrame(ctx); pushVoicedFrame(ctx); pushVoicedFrame(ctx); // ~768ms voiced, below any auto-flush threshold
  assert.equal(finals.length, 0, "no auto-flush yet -- minMs/maxMs are set huge");

  win.ASR.flushRole("remote");
  await tick(5);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, "hello there");
  assert.equal(finals[0].role, "remote");
});

test("asr: flushRole after two separate speaking turns produces two distinct segments", async () => {
  const finals = [];
  let call = 0;
  const win = bootWithFakeAudio(
    { inputDeviceLabel: "blackhole", whisperUrl: "http://whisper", vad: { minMs: 999999, maxMs: 999999 } },
    () => {
      call++;
      const text = call === 1 ? "first turn" : "second turn";
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ text })) });
    }
  );
  win.ASR.start({ onFinal: (text, role) => finals.push({ text, role }), onStatus() {}, onError(e) { throw new Error("onError: " + e); } });
  await tick();
  const ctx = win._contexts[0];

  pushVoicedFrame(ctx); pushVoicedFrame(ctx); // >= minVoicedMs (450ms default; 2 frames = 512ms)
  win.ASR.flushRole("remote");     // toggle flip after turn 1 -- forces a clean boundary
  await tick(5);

  pushVoicedFrame(ctx); pushVoicedFrame(ctx);
  win.ASR.flushRole("remote");     // toggle flip after turn 2
  await tick(5);

  assert.equal(finals.length, 2, "each turn must land as its own segment, not merged");
  assert.deepEqual(finals.map((f) => f.text), ["first turn", "second turn"]);
});

test("asr: flushRole with no in-flight audio is a safe no-op", async () => {
  const win = bootWithFakeAudio({ inputDeviceLabel: "blackhole" }, () => Promise.reject(new Error("no fetch expected")));
  win.ASR.start({ onFinal() {}, onStatus() {}, onError(e) { throw new Error("onError: " + e); } });
  await tick();
  assert.doesNotThrow(() => win.ASR.flushRole("remote"));
  assert.doesNotThrow(() => win.ASR.flushRole()); // no role filter -> flush every open capture
});

test("asr: stop() tears down capture and isListening() reflects it", async () => {
  const win = bootWithFakeAudio({ inputDeviceLabel: "blackhole" }, () => Promise.reject(new Error("no fetch")));
  win.ASR.start({ onFinal() {}, onStatus() {}, onError(e) { throw new Error("onError: " + e); } });
  await tick();
  assert.equal(win.ASR.isListening(), true);
  win.ASR.stop();
  assert.equal(win.ASR.isListening(), false);
});

test("asr: start() reports an error when the configured remote device label is not found", async () => {
  const errors = [];
  const win = bootWithFakeAudio({ inputDeviceLabel: "nonexistent-device" }, () => Promise.reject(new Error("no fetch")));
  win.ASR.start({ onFinal() {}, onStatus() {}, onError: (e) => errors.push(e) });
  await tick();
  assert.equal(win._contexts.length, 0, "never opens a source for an unresolved device label");
  assert.ok(errors.some((e) => /not found/.test(e)));
});

test("asr: enableSelf(true) opens a second capture using the auto-detected non-loopback mic", async () => {
  const win = bootWithFakeAudio({ inputDeviceLabel: "blackhole", vad: { minMs: 999999, maxMs: 999999 } }, () => Promise.reject(new Error("no fetch")));
  win.ASR.start({ onFinal() {}, onStatus() {}, onError(e) { throw new Error("onError: " + e); } });
  await tick();
  assert.equal(win._contexts.length, 1);
  win.ASR.enableSelf(true);
  await tick(4);
  assert.equal(win._contexts.length, 2, "a second AudioContext for the auto-detected self mic");
});

test("asr: listDevices() and meter()/stopMeters() exercise the Config-tab helpers", async () => {
  const win = bootWithFakeAudio({ inputDeviceLabel: "blackhole" }, () => Promise.reject(new Error("no fetch")));
  const labels = await win.ASR.listDevices();
  assert.deepEqual(labels.slice().sort(), ["BlackHole 2ch", "MacBook Pro Microphone"].sort());

  const stopFn = await win.ASR.meter("blackhole", () => {});
  assert.equal(typeof stopFn, "function");
  assert.doesNotThrow(() => stopFn());
  assert.doesNotThrow(() => win.ASR.stopMeters());
});

test("asr: identifyVoice is skipped for the self role and when speakerId is disabled", async () => {
  const win = bootWithFakeAudio(
    { inputDeviceLabel: "blackhole", whisperUrl: "http://whisper", speakerId: { enabled: false }, vad: { minMs: 999999, maxMs: 999999 } },
    () => Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ text: "hi" })) })
  );
  const finals = [];
  win.ASR.start({ onFinal: (t, r, ts, verdict) => finals.push({ t, r, verdict }), onStatus() {}, onError(e) { throw new Error("onError: " + e); } });
  await tick();
  pushVoicedFrame(win._contexts[0]); pushVoicedFrame(win._contexts[0]);
  win.ASR.flushRole("remote");
  await tick(5);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].verdict, undefined, "no voice verdict when speakerId is disabled");
});
