"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, sameJSON } = require("./harness");

function boot(config, fetchImpl) {
  const win = {
    CONFIG: { llm: config },
    console: console,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    fetch: fetchImpl || (() => Promise.reject(new Error("unexpected fetch")))
  };
  load(win, "js/llm-transport.js");
  return win;
}

test("llm: providerList ignores an unsubstituted %PLACEHOLDER% key", () => {
  const win = boot({
    provider: "openai",
    openai: { apiKey: "%OPENAI_API_KEY%", baseUrl: "http://x" },
    groq: { apiKey: "real-key", baseUrl: "http://y" },
    ollama: {}
  });
  const list = win.LLM.providerList();
  assert.ok(!list.includes("openai"), "placeholder key must not count as configured");
  assert.ok(list.includes("groq"));
});

test("llm: providerList includes ollama only when it has a url", () => {
  const win = boot({ provider: "ollama", ollama: { url: "http://localhost:11434" } });
  sameJSON(win.LLM.providerList(), ["ollama"]);
  const win2 = boot({ provider: "ollama", ollama: {} });
  sameJSON(win2.LLM.providerList(), []);
});

test("llm: chatJSON falls through providers in order until one succeeds", async () => {
  const calls = [];
  const win = boot(
    { provider: "openai", fallback: ["openai", "groq"],
      openai: { apiKey: "k1", baseUrl: "http://openai" },
      groq: { apiKey: "k2", baseUrl: "http://groq" } },
    (url) => {
      calls.push(url);
      if (url.indexOf("openai") !== -1) return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '{"a":1}' } }] }) });
    }
  );
  const result = await win.LLM.chatJSON("sys", "user");
  sameJSON(result, { a: 1 });
  assert.equal(calls.length, 2, "should have tried openai then fallen through to groq");
});

test("llm: chatJSON resolves null when every provider fails", async () => {
  const win = boot(
    { provider: "openai", openai: { apiKey: "k1", baseUrl: "http://openai" } },
    () => Promise.resolve({ ok: false })
  );
  const result = await win.LLM.chatJSON("sys", "user");
  assert.equal(result, null);
});

test("llm: registerTask/runTask builds system+user and appends the contextBlock hook", async () => {
  let seenBody = null;
  const win = boot(
    { provider: "ollama", ollama: { url: "http://ollama", model: "m" } },
    (url, init) => {
      seenBody = JSON.parse(init.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ message: { content: '{"ok":true}' } }) });
    }
  );
  win.CopilotCore = { llm: { contextBlock: function (name) { return "CONTEXT for " + name; } } };
  win.LLM.registerTask("summarize", {
    system: "Summarize the transcript.",
    buildUser: function (ctx) { return ctx.text; }
  });
  const result = await win.LLM.runTask("summarize", { text: "hello world" });
  sameJSON(result, { ok: true });
  const sysMsg = seenBody.messages.find(m => m.role === "system");
  assert.match(sysMsg.content, /Summarize the transcript\./);
  assert.match(sysMsg.content, /CONTEXT for summarize/);
  const userMsg = seenBody.messages.find(m => m.role === "user");
  assert.equal(userMsg.content, "hello world");
});

test("llm: runTask on an unregistered task resolves null without calling fetch", async () => {
  const win = boot({ provider: "ollama", ollama: { url: "http://ollama" } }, () => { throw new Error("must not fetch"); });
  const result = await win.LLM.runTask("nope", {});
  assert.equal(result, null);
});

test("llm: providerListFor overrides the chain for one call, falling back to default if empty", () => {
  const win = boot({
    provider: "ollama", ollama: { url: "http://ollama" },
    openai: { apiKey: "k1", baseUrl: "http://openai" }
  });
  sameJSON(win.LLM.providerListFor({ providers: ["openai"] }), ["openai"]);
  // an override naming only unconfigured providers falls back to the default chain
  sameJSON(win.LLM.providerListFor({ providers: ["groq"] }), win.LLM.providerList());
  // no opts / no opts.providers -> plain default chain
  sameJSON(win.LLM.providerListFor(undefined), win.LLM.providerList());
});

test("llm: available() is false when llm.enabled is false, true for a keyed cloud provider", async () => {
  const disabled = boot({ enabled: false, provider: "openai", openai: { apiKey: "k1", baseUrl: "http://x" } });
  assert.equal(await disabled.LLM.available(), false);

  const cloud = boot({ enabled: true, provider: "openai", openai: { apiKey: "k1", baseUrl: "http://x" } });
  assert.equal(await cloud.LLM.available(), true);
});

test("llm: available() pings the local ollama endpoint when only ollama is configured", async () => {
  let pinged = null;
  const win = boot({ enabled: true, provider: "ollama", ollama: { url: "http://localhost:11434" } },
    (url) => { pinged = url; return Promise.resolve({ ok: true }); });
  const ok = await win.LLM.available();
  assert.equal(ok, true);
  assert.equal(pinged, "http://localhost:11434/api/tags");
});

test("llm: available() is false with no configured providers at all", async () => {
  const win = boot({ enabled: true });
  assert.equal(await win.LLM.available(), false);
});

test("llm: last() reports the provider/model that answered", async () => {
  const win = boot(
    { provider: "ollama", ollama: { url: "http://ollama", model: "m1" } },
    () => Promise.resolve({ ok: true, json: () => Promise.resolve({ message: { content: "{}" } }) })
  );
  assert.equal(win.LLM.last(), null);
  await win.LLM.chatJSON("sys", "user");
  const last = win.LLM.last();
  assert.equal(last.provider, "ollama");
  assert.equal(last.model, "m1");
});
