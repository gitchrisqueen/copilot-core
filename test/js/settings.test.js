"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, sameJSON } = require("./harness");

function boot(opts) {
  opts = opts || {};
  const calls = [];
  const win = {
    CONFIG: opts.config || { settingsUrl: "http://x/settings", llm: { provider: "ollama" } },
    console: console,
    fetch: function (url, init) {
      calls.push({ url, init });
      if (init && init.method === "POST") return Promise.resolve({ ok: true });
      if (opts.fetchFails) return Promise.reject(new Error("network down"));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.stored || { llm: { model: "x" } }) });
    }
  };
  load(win, "js/settings.js");
  return { win, calls };
}

test("settings: deep-merges fetched settings over CONFIG", async () => {
  const { win } = boot({ stored: { llm: { model: "gpt-x" } } });
  await win.SETTINGS.ready;
  assert.equal(win.CONFIG.llm.model, "gpt-x");
  assert.equal(win.CONFIG.llm.provider, "ollama"); // untouched sibling key survives the merge
});

test("settings: save() merges into CONFIG immediately and POSTs the full stored object", async () => {
  const { win, calls } = boot({ stored: { llm: { model: "gpt-x" } } });
  await win.SETTINGS.ready;
  win.SETTINGS.save({ asr: { engine: "whisper" } });
  assert.equal(win.CONFIG.asr.engine, "whisper");
  sameJSON(win.SETTINGS.stored().asr, { engine: "whisper" });
  const post = calls.filter(c => c.init && c.init.method === "POST")[0];
  assert.ok(post, "expected a POST to settingsUrl");
  const body = JSON.parse(post.init.body);
  assert.equal(body.llm.model, "gpt-x"); // previously-fetched settings preserved in the POST
  assert.equal(body.asr.engine, "whisper");
});

test("settings: a failed fetch resolves to {} without throwing", async () => {
  const { win } = boot({ fetchFails: true });
  const stored = await win.SETTINGS.ready;
  sameJSON(stored, {});
});

test("settings: no settingsUrl configured -> ready resolves immediately, save() is a no-op network-wise", async () => {
  const { win, calls } = boot({ config: {} });
  await win.SETTINGS.ready;
  win.SETTINGS.save({ x: 1 });
  assert.equal(calls.length, 0);
});
