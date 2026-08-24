// LLM transport layer: provider-agnostic chat client with failover across local Ollama (a CORS
// bridge that can proxy Ollama Cloud models) and OpenAI-compatible cloud endpoints (OpenAI, Groq,
// ollamacloud). All calls fail soft: on any error they resolve to null so the caller can fall back
// to an offline heuristic.
//
// This module carries ZERO domain prompts. Apps register their own tasks via LLM.registerTask()
// and invoke them with LLM.runTask(name, ctx); the base only owns retries, timeouts, provider
// fallback order, and JSON-mode parsing.
(function (global) {
  function cfg() { return (global.CONFIG && global.CONFIG.llm) || {}; }
  function provider() { return cfg().provider || "ollama"; }
  function confOf(name) { var c = cfg(); return c[name] || {}; }
  // "cloud" = an OpenAI-compatible HTTP endpoint with a Bearer key. "ollama" is the LOCAL server
  // with its native /api/chat (which can proxy :cloud-tagged models to Ollama Cloud).
  function isCloudName(name) { return name === "groq" || name === "openai" || name === "ollamacloud"; }

  // Records which provider/model actually answered last (surfaced in the UI + console).
  var lastUsed = null;
  function markUsed(name, model) { try { lastUsed = { provider: name, model: model || confOf(name).model, at: Date.now() }; } catch (e) {} }

  // Ordered list of providers to try. A cloud provider is only used if it has a real apiKey
  // (unsubstituted %PLACEHOLDER% values don't count); ollama is used if it has a url.
  // Override the order with CONFIG.llm.fallback = ["groq","openai","ollama"].
  function providerList() {
    var c = cfg();
    var order = (c.fallback && c.fallback.length) ? c.fallback.slice()
              : [c.provider || "ollama"].concat(["ollama", "openai", "groq"]);
    var seen = {}, out = [];
    order.forEach(function (name) {
      if (seen[name]) return; seen[name] = 1;
      var pc = c[name]; if (!pc) return;
      if (name === "ollama") { if (pc.url) out.push(name); }
      else if (pc.apiKey && pc.apiKey.indexOf("%") !== 0) out.push(name);
    });
    return out;
  }

  // Per-call provider override (e.g. a whole-transcript pass wants a stronger, larger-context
  // model than the app default). opts.providers = ["ollama","openai"]. Falls back to the default
  // chain if the override yields nothing usable.
  function providerListFor(opts) {
    if (!opts || !opts.providers || !opts.providers.length) return providerList();
    var c = cfg(), seen = {}, out = [];
    opts.providers.forEach(function (name) {
      if (seen[name]) return; seen[name] = 1;
      var pc = c[name]; if (!pc) return;
      if (name === "ollama") { if (pc.url) out.push(name); }
      else if (pc.apiKey && pc.apiKey.indexOf("%") !== 0) out.push(name);
    });
    return out.length ? out : providerList();
  }

  function withTimeout(ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms || 12000);
    return { signal: ctrl.signal, done: function () { clearTimeout(t); } };
  }

  // Try each provider in order; resolve with the first non-null result, else null.
  function sequence(list, attempt) {
    var i = 0;
    function next() {
      if (i >= list.length) return Promise.resolve(null);
      var name = list[i++];
      return Promise.resolve().then(function () { return attempt(name); })
        .then(function (r) { return (r != null) ? r : next(); })
        .catch(function () { return next(); });
    }
    return next();
  }

  function available() {
    var c = cfg();
    if (!c.enabled) return Promise.resolve(false);
    var list = providerList();
    if (!list.length) return Promise.resolve(false);
    if (list.some(isCloudName)) return Promise.resolve(true);
    var pc = confOf(list[0]), to = withTimeout(3000);
    return fetch(pc.url + "/api/tags", { signal: to.signal })
      .then(function (r) { to.done(); return r.ok; })
      .catch(function () { to.done(); return false; });
  }

  function modelFor(name, opts) { return (opts && opts.models && opts.models[name]) || confOf(name).model; }

  // One JSON-mode chat attempt against a single named provider. Returns parsed object or null.
  // opts = { providers, models:{ollama:"..."}, timeoutMs, maxTokens, numCtx }. All fields optional.
  function chatJSONOne(name, system, user, opts) {
    var c = cfg(), p = confOf(name), cloud = isCloudName(name);
    var to = withTimeout((opts && opts.timeoutMs) || c.timeoutMs);
    var model = modelFor(name, opts);
    var maxTok = (opts && opts.maxTokens) || 3000;
    var url, headers = { "Content-Type": "application/json" }, body;
    if (cloud) {
      url = p.baseUrl.replace(/\/$/, "") + "/chat/completions";
      headers["Authorization"] = "Bearer " + (p.apiKey || "");
      body = {
        model: model, temperature: 0.1, stream: false, max_completion_tokens: maxTok,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      };
      if (name === "groq") body.reasoning_effort = "low";  // gpt-oss: keep budget for content, not hidden reasoning
    } else {
      url = p.url.replace(/\/$/, "") + "/api/chat";
      body = {
        model: model, stream: false, format: "json", options: { temperature: 0.1 },
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      };
      if (opts && opts.numCtx) body.options.num_ctx = opts.numCtx;   // widen context for whole-transcript tasks
    }
    if (/gpt-oss|deepseek/i.test(model)) body.think = false;   // reasoning models: emit content, not hidden thinking
    return fetch(url, { method: "POST", headers: headers, signal: to.signal, body: JSON.stringify(body) })
      .then(function (r) { to.done(); return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return null;
        var content = cloud
          ? (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content)
          : (j.message && j.message.content);
        if (!content) return null;
        try { var parsed = JSON.parse(content); markUsed(name, model); return parsed; } catch (e) { return null; }
      })
      .catch(function () { to.done(); return null; });
  }

  // Returns parsed JSON from the first provider that answers, or null.
  function chatJSON(system, user, opts) {
    return sequence(providerListFor(opts), function (name) { return chatJSONOne(name, system, user, opts); });
  }

  // ---- Prompt-pack registry: apps own domain prompts, core owns transport ----
  var tasks = {};
  // def = { system: string|function(ctx), buildUser: function(ctx)->string, opts: object|function(ctx) }
  function registerTask(name, def) { tasks[name] = def; }
  function hasTask(name) { return !!tasks[name]; }
  // Always-appended context block hook (the generalized form of "the COMPANY & INTERVIEW block
  // must be in every prompt and no caller can drop it"). Set window.CopilotCore.llm.contextBlock =
  // function(taskName){ return "..."; } to have it appended to every registered task's system prompt.
  function contextBlock(name) {
    try {
      var hook = global.CopilotCore && global.CopilotCore.llm && global.CopilotCore.llm.contextBlock;
      return hook ? (hook(name) || "") : "";
    } catch (e) { return ""; }
  }
  function runTask(name, ctx) {
    var def = tasks[name];
    if (!def) return Promise.resolve(null);
    var system = typeof def.system === "function" ? def.system(ctx) : def.system;
    var block = contextBlock(name);
    if (block) system = system + "\n\n" + block;
    var user = def.buildUser ? def.buildUser(ctx) : "";
    var opts = typeof def.opts === "function" ? def.opts(ctx) : def.opts;
    return chatJSON(system, user, opts);
  }

  global.LLM = {
    provider: provider, providerList: providerList, providerListFor: providerListFor,
    available: available, withTimeout: withTimeout, sequence: sequence,
    chatJSON: chatJSON, chatJSONOne: chatJSONOne, modelFor: modelFor,
    registerTask: registerTask, runTask: runTask, hasTask: hasTask,
    last: function () { return lastUsed; }
  };
})(typeof window !== "undefined" ? window : globalThis);
