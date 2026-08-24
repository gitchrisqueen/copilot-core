// Speech-to-text with voice-activity chunking and optional dual capture.
//  - "remote" = config.asr.inputDeviceLabel: the other party's audio (e.g. a BlackHole loopback).
//  - "self"   = config.asr.selfDeviceLabel: your mic, only if captureSelf / enableSelf(true).
// Devices are bound EXPLICITLY by label after priming mic permission, so a missing label never
// silently falls back to the default input (which can cause a source to be captured twice).
// onFinal(text, role, startTs[, voiceVerdict]) where role is "remote" or "self".
//
// This module is the union of two apps that forked from a common ancestor: it keeps every
// capability either app needs so it can serve as the shared base.
//  - self-mic auto-detection (resolveSelfDefault), Config-tab device list/level meter
//    (listDevices/meter/stopMeters), and the %PLACEHOLDER% Together-key guard
//  - flushRole(): force-finalizes in-flight utterances (call when a "who's speaking" toggle
//    flips, so a short pause between speakers becomes a clean boundary instead of one merged
//    chunk with the wrong attribution)
//  - identifyVoice() extra-params hook: apps that map voice clusters to named roles (e.g. a
//    courtroom's plaintiff/court/defendant) can pass a recent UI hint alongside the audio via
//    window.CopilotCore.asr.identifyParams(role, ts, voicedMs) -> {extra query params}
(function (global) {
  var CFG = function () { return (global.CONFIG && global.CONFIG.asr) || {}; };
  var DBG = function () { return !!(global.CONFIG && global.CONFIG.debug); };
  function log() { if (DBG() && global.console) console.log.apply(console, ["[asr]"].concat([].slice.call(arguments))); }
  var listening = false, cbs = {}, mode = "whisper";
  // Which transcriber actually served the most recent chunk (drives the status label + degraded color).
  var srcState = { useTg: false, source: null };
  // Circuit breaker for Together: after repeated failures (e.g. their 503 outages) skip it for a
  // cooldown so we don't waste a round-trip on every chunk; re-probe after, reset on first success.
  var tgBreaker = { fails: 0, until: 0 };
  // Together's serverless capacity 503s on BURSTS, so calls are serialized through this queue.
  var tgQueue = Promise.resolve();
  var rec = null;               // webspeech
  var caps = [];                // whisper captures
  var inputs = null;            // cached list of audioinput devices (label-populated)
  var wantSelf = false;         // single source of truth for whether to capture the "me" mic
  var pending = {};             // role -> true while a getUserMedia is mid-flight (prevents double-open)
  var meters = [];              // live Config-tab level meters (separate, temporary captures)

  function supported() {
    return !!(global.SpeechRecognition || global.webkitSpeechRecognition) ||
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // ----- Web Speech (remote only) -----
  function startWebSpeech() {
    var SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!SR) { cbs.onError && cbs.onError("Web Speech not supported; use Chrome or whisper mode."); return; }
    rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = CFG().lang || "en-US";
    rec.onresult = function (e) {
      var interim = "", finalText = "";
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      if (interim && cbs.onInterim) cbs.onInterim(interim);
      if (finalText && cbs.onFinal) cbs.onFinal(finalText.trim(), "remote", Date.now());
    };
    rec.onerror = function (e) { cbs.onError && cbs.onError("ASR error: " + (e.error || "unknown")); };
    rec.onend = function () { if (listening) { try { rec.start(); } catch (x) {} } };
    try { rec.start(); cbs.onStatus && cbs.onStatus("listening"); }
    catch (x) { cbs.onError && cbs.onError("Could not start Web Speech: " + x.message); }
  }

  // Prime permission (so labels populate), then enumerate. Cached after first call.
  function ensureDevices(refresh) {
    if (inputs && !refresh) return Promise.resolve(inputs);
    return navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); })
      .then(function () { return navigator.mediaDevices.enumerateDevices(); })
      .then(function (ds) { inputs = ds.filter(function (d) { return d.kind === "audioinput"; }); log("inputs", inputs.map(function (d) { return d.label; })); return inputs; });
  }
  function resolve(label) {
    label = (label || "").toLowerCase(); if (!label || !inputs) return null;
    var m = inputs.filter(function (d) { return d.label.toLowerCase().indexOf(label) !== -1; })[0];
    return m ? { id: m.deviceId, label: m.label } : null;
  }
  // Your mic when no label is configured: the first input that is not the remote (e.g. loopback) device.
  function resolveSelfDefault() {
    if (!inputs) return null;
    var remote = resolve(CFG().inputDeviceLabel);
    var loopbackPat = CFG().loopbackLabelPattern ? new RegExp(CFG().loopbackLabelPattern, "i") : /blackhole/i;
    var m = inputs.filter(function (d) {
      if (remote && d.deviceId === remote.id) return false;
      if (loopbackPat.test(d.label)) return false;
      return d.deviceId !== "default" && d.deviceId !== "communications";
    })[0] || inputs.filter(function (d) { return !loopbackPat.test(d.label); })[0];
    return m ? { id: m.deviceId, label: m.label } : null;
  }
  function labelList() { return (inputs || []).map(function (d) { return d.label; }).join(", "); }
  function rms(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); }

  function openSource(role, dev) {
    // Guard against BOTH an existing stream AND one that is mid-open (getUserMedia is async, so two
    // concurrent starts would each pass a "does a cap exist?" check and open the mic twice).
    if (caps.some(function (c) { return c.role === role; }) || pending[role]) return;
    pending[role] = true;
    navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: dev.id }, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(function (stream) {
      pending[role] = false;
      // race guard: if "Me" was switched off (or we stopped) while this was resolving, abandon it
      if ((role === "self" && !wantSelf) || !listening || caps.some(function (c) { return c.role === role; })) {
        stream.getTracks().forEach(function (t) { t.stop(); }); return;
      }
      var bound = (stream.getAudioTracks()[0] && stream.getAudioTracks()[0].label) || dev.label;
      log("capturing", role, "->", bound);
      cbs.onStatus && cbs.onStatus(role + ": " + bound);
      var ctx = new (global.AudioContext || global.webkitAudioContext)();
      var src = ctx.createMediaStreamSource(stream);
      var node = ctx.createScriptProcessor(4096, 1, 1);
      var sink = ctx.createGain(); sink.gain.value = 0;
      var cap = { role: role, dev: dev.id, stream: stream, ctx: ctx, node: node, sink: sink, chunks: [], accMs: 0, silMs: 0, voiced: false, voicedMs: 0, startTs: 0 };
      node.onaudioprocess = function (e) {
        var input = e.inputBuffer.getChannelData(0);
        var frameMs = input.length / ctx.sampleRate * 1000;
        if (cap.chunks.length === 0) cap.startTs = Date.now();   // when this utterance began
        cap.chunks.push(new Float32Array(input));
        cap.accMs += frameMs;
        var v = CFG().vad || {};
        if (rms(input) > (v.threshold || 0.015)) { cap.voiced = true; cap.silMs = 0; cap.voicedMs += frameMs; }
        else { cap.silMs += frameMs; }
        var minMs = v.minMs || 1200, silenceMs = v.silenceMs || 700, maxMs = v.maxMs || 14000;
        if (cap.voiced && cap.accMs >= minMs && cap.silMs >= silenceMs) flush(cap);
        else if (cap.accMs >= maxMs) flush(cap);
      };
      src.connect(node); node.connect(sink); sink.connect(ctx.destination);
      caps.push(cap);
    }).catch(function (e) {
      // Clear the in-flight flag on failure too, or a rejected getUserMedia permanently blocks
      // retrying this capture role for the rest of the session.
      pending[role] = false;
      cbs.onError && cbs.onError(role + " capture failed (" + dev.label + "): " + e.message);
    });
  }

  // Known whisper silence/noise hallucinations. Only exact matches are dropped, so real short
  // lines ("Objection.", "Correct.", "Why?") are never affected.
  var JUNK = { "you": 1, "so": 1, "the": 1, "okay": 1, "ok": 1, "bye": 1, "uh": 1, "um": 1,
    "thanks for watching": 1, "thank you for watching": 1, "thanks for watching!": 1,
    "please subscribe": 1, "subscribe": 1, "music": 1, "silence": 1 };
  function isJunk(txt) {
    var t = txt.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    return t === "" || JUNK[t] === 1;
  }

  function flush(cap) {
    var chunks = cap.chunks, voiced = cap.voiced, voicedMs = cap.voicedMs, startTs = cap.startTs || Date.now();
    cap.chunks = []; cap.accMs = 0; cap.silMs = 0; cap.voiced = false; cap.voicedMs = 0; cap.startTs = 0;
    if (!chunks.length || !voiced) return;
    var v = CFG().vad || {};
    if (voicedMs < (v.minVoicedMs || 450)) { log("drop chunk: only", Math.round(voicedMs), "ms voiced"); return; }
    var len = chunks.reduce(function (n, a) { return n + a.length; }, 0);
    var buf = new Float32Array(len), off = 0;
    chunks.forEach(function (a) { buf.set(a, off); off += a.length; });
    if (rms(buf) < (v.minRms || 0.006)) { log("drop chunk: low energy", rms(buf).toFixed(4)); return; }
    var wav = encodeWav(buf, cap.ctx.sampleRate, 16000);
    // Voice fingerprint in parallel with transcription (speaker sidecar, if configured). The
    // promise always resolves (verdict or null on timeout/error), and transcription is the slow
    // leg (~1-3 s vs ~60 ms), so joining on it below adds no real latency. Self mic is skipped:
    // that channel is already attributed.
    var vp = identifyVoice(wav, cap.role, startTs, voicedMs);
    var tg = CFG().together || {};
    var configuredTg = (CFG().transcriber !== "whisper") && !!tg.apiKey && !!tg.url &&
                       tg.apiKey.indexOf("%") !== 0;                                // ignore unsubstituted placeholder
    var cooling = configuredTg && Date.now() < tgBreaker.until;                     // skipping during a cooldown
    var useTg = configuredTg && !cooling;
    srcState.useTg = configuredTg;   // status shows Together as intended even while cooling
    // Build a fresh multipart body per fetch (FormData can't be safely reused). config.asr.prompt
    // is the caller's domain vocabulary prime (courtroom terms, CS terms, whatever the app needs).
    function buildFd(withModel) {
      var fd = new FormData();
      var model = tg.model || "openai/whisper-large-v3";
      if (withModel) { fd.append("model", model); fd.append("language", "en"); }
      fd.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
      fd.append("response_format", "json");
      // temperature + prompt are Whisper-only; NVIDIA Parakeet 400s on them.
      var sendWhisperParams = withModel ? /whisper/i.test(model) : true;
      if (sendWhisperParams) {
        fd.append("temperature", "0");
        var prompt = CFG().prompt; if (prompt) fd.append("prompt", prompt);
      }
      return fd;
    }
    function handle(t) {
      if (!t) return;
      var txt = t; try { var j = JSON.parse(t); txt = j.text || j.transcription || ""; } catch (e) {}
      txt = (txt || "").replace(/\[BLANK_AUDIO\]/gi, "").trim();
      if (!txt) return;
      if (isJunk(txt)) { log("drop hallucination:", txt); return; }
      if (!cbs.onFinal) return;
      if (vp) vp.then(function (v) { cbs.onFinal(txt, cap.role, startTs, v); });
      else cbs.onFinal(txt, cap.role, startTs);
    }
    function whisper(fellBack) {
      fetch(CFG().whisperUrl, { method: "POST", body: buildFd(false) })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (t) { srcState.source = "whisper"; srcState.degraded = !!fellBack; if (cbs.onStatus) cbs.onStatus(); handle(t); })
        .catch(function () { cbs.onError && cbs.onError("whisper server unreachable at " + CFG().whisperUrl); });
    }
    if (useTg) {
      tgQueue = tgQueue.then(function () {
        return fetch(tg.url, { method: "POST", body: buildFd(true), headers: { "Authorization": "Bearer " + tg.apiKey } })
          .then(function (r) { return r.ok ? r.text() : Promise.reject("together status " + r.status); })
          .then(function (t) { tgBreaker.fails = 0; tgBreaker.until = 0; srcState.source = "together"; srcState.degraded = false; if (cbs.onStatus) cbs.onStatus(); handle(t); })
          .catch(function (e) {
            tgBreaker.fails++;
            if (tgBreaker.fails >= 2) { tgBreaker.until = Date.now() + 45000; log("together failing (" + e + "); cooling 45s -> local whisper"); }
            else { log("together transcription failed, falling back to local whisper:", e); }
            whisper(true);
          });
      }).catch(function () {});   // keep the serial chain alive even if a handler throws
    } else {
      whisper(configuredTg);   // configured but cooling -> degraded; not configured -> plain local whisper
    }
  }

  // POST the utterance WAV to the local speaker-ID sidecar. Returns a promise that ALWAYS
  // resolves (verdict object, or null on disabled/self/timeout/error), never rejects, so a slow
  // or missing sidecar can never hold up or break the transcript.
  //
  // scopeParam/scopeId let an app namespace clusters per its own concept (a courtroom "case",
  // an interview "session", ...). identifyParams(role, ts, voicedMs) is an optional app hook for
  // ad-hoc extras (e.g. a "who's speaking" UI hint the sidecar uses as a mapping prior) -- set it
  // on window.CopilotCore.asr before ASR.start() if needed.
  function identifyVoice(wav, role, ts, voicedMs) {
    var sc = (global.CONFIG && global.CONFIG.speakerId) || {};
    if (!sc.enabled || !sc.url || role === "self") return null;
    var scopeParam = sc.scopeParam || "session";
    var scopeId = sc.scopeId || "default";
    var q = "?ts=" + ts + "&voiced=" + Math.round(voicedMs) +
            "&" + scopeParam + "=" + encodeURIComponent(scopeId);
    try {
      var hook = global.CopilotCore && global.CopilotCore.asr && global.CopilotCore.asr.identifyParams;
      var extra = hook ? hook(role, ts, voicedMs) : null;
      if (extra) {
        Object.keys(extra).forEach(function (k) { q += "&" + k + "=" + encodeURIComponent(extra[k]); });
      }
    } catch (e) {}
    var p = fetch(sc.url + "/identify" + q, {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    var to = new Promise(function (res) { setTimeout(function () { res(null); }, sc.timeoutMs || 1500); });
    return Promise.race([p, to]);
  }

  function encodeWav(samples, srcRate, outRate) {
    var data = samples;
    if (srcRate !== outRate) {
      var ratio = srcRate / outRate, outLen = Math.floor(samples.length / ratio);
      data = new Float32Array(outLen);
      for (var i = 0; i < outLen; i++) {
        var idx = i * ratio, lo = Math.floor(idx), hi = Math.min(lo + 1, samples.length - 1);
        data[i] = samples[lo] + (samples[hi] - samples[lo]) * (idx - lo);
      }
    }
    var buffer = new ArrayBuffer(44 + data.length * 2), view = new DataView(buffer);
    function wr(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
    wr(0, "RIFF"); view.setUint32(4, 36 + data.length * 2, true); wr(8, "WAVE");
    wr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, outRate, true); view.setUint32(28, outRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    wr(36, "data"); view.setUint32(40, data.length * 2, true);
    var o = 44; for (var j = 0; j < data.length; j++) { var s = Math.max(-1, Math.min(1, data[j])); view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
    return buffer;
  }

  function stopCap(cap) {
    try { cap.node.disconnect(); } catch (x) {}
    try { cap.sink.disconnect(); } catch (x) {}
    try { cap.ctx.close(); } catch (x) {}
    if (cap.stream) cap.stream.getTracks().forEach(function (t) { t.stop(); });
  }

  function startRemote() {
    var r = resolve(CFG().inputDeviceLabel);
    var name = CFG().inputLabelName || "Remote input";
    if (!r) { cbs.onError && cbs.onError(name + " \"" + CFG().inputDeviceLabel + "\" not found. Inputs: " + labelList()); return; }
    openSource("remote", r);
  }
  function startSelf() {
    if (!wantSelf) return;
    var r = resolve(CFG().inputDeviceLabel);
    var s = CFG().selfDeviceLabel ? resolve(CFG().selfDeviceLabel) : resolveSelfDefault();
    var selfName = CFG().selfLabelName || "Your mic";
    var remoteName = CFG().inputLabelName || "remote input";
    if (!s) { cbs.onError && cbs.onError(selfName + " \"" + (CFG().selfDeviceLabel || "(auto)") + "\" not found; Me capture off. Inputs: " + labelList()); return; }
    if (r && s.id === r.id) { cbs.onError && cbs.onError("Me capture off: your mic resolved to the SAME device as the " + remoteName + " (" + s.label + "). Pick your real mic on the Config tab."); return; }
    openSource("self", s);
  }

  function start(callbacks) {
    if (listening) return;
    cbs = callbacks || {}; listening = true;
    wantSelf = !!CFG().captureSelf;
    mode = (CFG().engine === "webspeech") ? "webspeech" : "whisper";
    if (mode === "webspeech") { startWebSpeech(); return; }
    ensureDevices().then(function () {
      startRemote();
      if (wantSelf) startSelf();
    }).catch(function (e) { cbs.onError && cbs.onError("Mic permission needed: " + e.message); });
  }
  // Force-finalize the current utterance(s) now (call this when a "who's speaking" toggle
  // changes, so a short pause between speakers still becomes a clean boundary instead of one
  // merged chunk with the wrong attribution).
  function flushRole(role) {
    caps.forEach(function (cap) { if (!role || cap.role === role) flush(cap); });
  }
  function enableSelf(on) {
    wantSelf = on;                        // set first so in-flight/late starts honor it
    if (mode !== "whisper" || !listening) return;
    if (on) ensureDevices().then(function () { if (wantSelf) startSelf(); }).catch(function () {});
    else { caps.filter(function (c) { return c.role === "self"; }).forEach(stopCap); caps = caps.filter(function (c) { return c.role !== "self"; }); }
  }
  function stop() {
    listening = false; pending = {};
    if (rec) { try { rec.stop(); } catch (x) {} rec = null; }
    caps.forEach(stopCap); caps = [];
    cbs.onStatus && cbs.onStatus("stopped");
  }

  // ----- Config tab helpers -----
  // List the available audio input device labels (primes permission on first call).
  function listDevices(refresh) {
    return ensureDevices(refresh).then(function (ds) { return ds.map(function (d) { return d.label; }); });
  }
  // Live level meter for a device label: opens a lightweight capture and calls cb(rms) per frame.
  // Returns a promise resolving to a stop() function. Used by a Config tab to verify routing.
  function meter(label, cb) {
    return ensureDevices().then(function () {
      var dev = resolve(label);
      if (!dev) return function () {};
      return navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: dev.id }, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      }).then(function (stream) {
        var ctx = new (global.AudioContext || global.webkitAudioContext)();
        var src = ctx.createMediaStreamSource(stream);
        var node = ctx.createScriptProcessor(2048, 1, 1);
        var sink = ctx.createGain(); sink.gain.value = 0;
        node.onaudioprocess = function (e) { try { cb(rms(e.inputBuffer.getChannelData(0))); } catch (x) {} };
        src.connect(node); node.connect(sink); sink.connect(ctx.destination);
        var m = { stream: stream, ctx: ctx, node: node, sink: sink };
        meters.push(m);
        return function stop() {
          try { node.disconnect(); sink.disconnect(); ctx.close(); } catch (x) {}
          stream.getTracks().forEach(function (t) { t.stop(); });
          meters = meters.filter(function (x) { return x !== m; });
        };
      });
    }).catch(function () { return function () {}; });
  }
  function stopMeters() {
    meters.forEach(function (m) {
      try { m.node.disconnect(); m.sink.disconnect(); m.ctx.close(); } catch (x) {}
      m.stream.getTracks().forEach(function (t) { t.stop(); });
    });
    meters = [];
  }

  // Label + degraded flag for the status line. If configured for Together but the last chunk was
  // served by the local whisper fallback, mark it degraded so the UI can warn (yellow).
  function transcriber() {
    if (!srcState.useTg) return { label: "whisper", degraded: false };
    if (srcState.source === "whisper") return { label: "whisper", degraded: true };   // fell back
    return { label: "whisper via together.ai", degraded: false };
  }
  global.ASR = {
    start: start, stop: stop, supported: supported, enableSelf: enableSelf, flushRole: flushRole,
    listDevices: listDevices, meter: meter, stopMeters: stopMeters,
    isListening: function () { return listening; }, engine: function () { return mode; }, transcriber: transcriber,
    // exposed for tests
    _internal: { isJunk: isJunk, encodeWav: encodeWav, rms: rms }
  };
})(typeof window !== "undefined" ? window : globalThis);
