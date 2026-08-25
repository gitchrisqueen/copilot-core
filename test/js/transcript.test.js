"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeLocalStorage, sameJSON } = require("./harness");

function boot(opts) {
  opts = opts || {};
  const diskCalls = [];
  const win = {
    CopilotCore: { ns: opts.ns || "t", transcript: opts.transcriptCfg },
    CONFIG: { logServer: { enabled: true, url: "http://x/log" } },
    localStorage: fakeLocalStorage(),
    console: console,
    fetch: function (url, init) { diskCalls.push({ url, init }); return Promise.resolve({ ok: true }); }
  };
  load(win, "js/transcript.js");
  return { win, diskCalls };
}

test("transcript: add() creates a segment and mirrors it to disk", () => {
  const { win, diskCalls } = boot();
  const seg = win.TLOG.add("remote", "hello", { matchedId: "R3" });
  assert.equal(seg.role, "remote");
  assert.equal(seg.text, "hello");
  assert.equal(seg.matchedId, "R3");
  assert.equal(diskCalls.length, 1);
  assert.equal(diskCalls[0].url, "http://x/log");
});

test("transcript: default persistKeys -> only text/role/name updates hit disk", () => {
  const { win, diskCalls } = boot();
  const seg = win.TLOG.add("remote", "hello");
  diskCalls.length = 0;
  win.TLOG.update(seg.id, { matchedId: "R9" }); // transient metadata only
  assert.equal(diskCalls.length, 0);
  win.TLOG.update(seg.id, { role: "self" }); // a real reassignment
  assert.equal(diskCalls.length, 1);
});

test("transcript: custom persistKeys config is honored", () => {
  const { win, diskCalls } = boot({ transcriptCfg: { persistKeys: ["text", "matchedId"] } });
  const seg = win.TLOG.add("remote", "hello");
  diskCalls.length = 0;
  win.TLOG.update(seg.id, { matchedId: "R9" });
  assert.equal(diskCalls.length, 1, "matchedId is a configured persist key here");
});

test("transcript: remove() and dates() work (hearing-app needs)", () => {
  const { win } = boot();
  const seg = win.TLOG.add("remote", "hello");
  assert.equal(win.TLOG.dates().length, 1);
  win.TLOG.remove(seg.id);
  assert.equal(win.TLOG.all().length, 0);
});

test("transcript: hydrate() merges by id, server record wins", () => {
  const { win } = boot();
  const seg = win.TLOG.add("remote", "hello");
  win.TLOG.hydrate([{ id: seg.id, ts: seg.ts, date: seg.date, role: "remote", text: "corrected", name: "" }]);
  assert.equal(win.TLOG.all()[0].text, "corrected");
});

test("transcript: exportText uses the default label (name or role, uppercased)", () => {
  const { win } = boot();
  win.TLOG.add("remote", "hi there");
  const text = win.TLOG.exportText(win.TLOG.today());
  assert.match(text, /REMOTE: hi there/);
});

test("transcript: exportText honors a custom labelFor hook", () => {
  const { win } = boot({ transcriptCfg: { labelFor: (s) => (s.role === "remote" ? "PLAINTIFF" : "ME") } });
  win.TLOG.add("remote", "objection");
  const text = win.TLOG.exportText(win.TLOG.today());
  assert.match(text, /PLAINTIFF: objection/);
});

test("transcript: roleField renames the schema's role property (e.g. an app with an existing `speaker` field)", () => {
  const { win, diskCalls } = boot({ transcriptCfg: { roleField: "speaker" } });
  const seg = win.TLOG.add("plaintiff", "objection");
  assert.equal(seg.speaker, "plaintiff", "value lands under the configured field name");
  assert.equal(seg.role, undefined, "the default 'role' field is not also written");
  assert.equal(win.TLOG._roleField(), "speaker");

  diskCalls.length = 0;
  win.TLOG.update(seg.id, { speaker: "defendant" }); // default persistKeys tracks the configured field
  assert.equal(diskCalls.length, 1, "reassigning the renamed role field still triggers a disk rewrite");

  const text = win.TLOG.exportText(win.TLOG.today());
  assert.match(text, /DEFENDANT: objection/, "default label formatter reads the renamed field too");
});

test("transcript: clearDate removes locally and issues a DELETE to the log server", () => {
  const { win, diskCalls } = boot();
  const today = win.TLOG.today();
  win.TLOG.add("remote", "hi");
  diskCalls.length = 0;
  win.TLOG.clearDate(today);
  assert.equal(win.TLOG.byDate(today).length, 0);
  const del = diskCalls.find((c) => c.init && c.init.method === "DELETE");
  assert.ok(del, "expected a DELETE call");
  assert.match(del.url, /\/log\?date=/);
});

test("transcript: clearDate is a no-op on disk when logServer is disabled", () => {
  const { win, diskCalls } = boot();
  win.CONFIG.logServer.enabled = false;
  const today = win.TLOG.today();
  win.TLOG.add("remote", "hi"); // this add() call also tries disk (no-op since disabled)
  diskCalls.length = 0;
  win.TLOG.clearDate(today);
  assert.equal(diskCalls.length, 0);
});

test("transcript: load() recovers from corrupt localStorage JSON", () => {
  const { win } = boot();
  win.localStorage.setItem(win.TLOG._key(), "{not json");
  const data = win.TLOG.load();
  sameJSON(data, []);
});

test("transcript: hydrate() with no segments is a no-op", () => {
  const { win } = boot();
  win.TLOG.add("remote", "hi");
  const before = win.TLOG.all().length;
  win.TLOG.hydrate([]);
  assert.equal(win.TLOG.all().length, before);
});
