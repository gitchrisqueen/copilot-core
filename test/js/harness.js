// Shared test harness: loads real shipped modules with `vm` against a faked `window`, so tests
// exercise the actual code path instead of a re-implementation of it.
//
// IMPORTANT: `load()` passes an ABSOLUTE path as vm's `filename` option. c8 (V8 coverage)
// attributes executed lines to whatever filename vm reports; a relative path makes every line
// in the loaded module attribute to nothing, silently reporting 0% coverage for it.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function deepMerge(dst, src) {
  Object.keys(src || {}).forEach(function (k) {
    if (isObj(src[k]) && isObj(dst[k])) deepMerge(dst[k], src[k]); else dst[k] = src[k];
  });
  return dst;
}

// A minimal localStorage backed by a plain object -- enough for layout.js/transcript.js.
function fakeLocalStorage() {
  var store = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    clear: function () { store = {}; },
    _dump: function () { return Object.assign({}, store); }
  };
}

// A deliberately small DOM stub: enough to smoke-load layout.js/transcript-rendering style
// modules and assert on textContent/class toggles, WITHOUT the weight of a full jsdom. If a test
// needs more DOM fidelity than this provides, that's the sanctioned point to add jsdom as a
// devDependency rather than growing this stub further.
function makeFakeElement(id) {
  var listeners = {};
  var classes = new Set();
  var el = {
    id: id || "",
    _text: "",
    style: {},
    dataset: {},
    children: [],
    get textContent() { return el._text; },
    set textContent(v) { el._text = String(v); },
    get innerHTML() { return el._text; },
    set innerHTML(v) { el._text = String(v); },
    classList: {
      add: function () { for (var i = 0; i < arguments.length; i++) classes.add(arguments[i]); },
      remove: function () { for (var i = 0; i < arguments.length; i++) classes.delete(arguments[i]); },
      toggle: function (c, force) {
        var on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: function (c) { return classes.has(c); }
    },
    addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener: function (ev, fn) {
      if (!listeners[ev]) return;
      listeners[ev] = listeners[ev].filter(function (f) { return f !== fn; });
    },
    dispatchEvent: function (ev) { (listeners[ev.type] || []).forEach(function (fn) { fn(ev); }); },
    getBoundingClientRect: function () { return { width: 400, height: 200, top: 0, left: 0 }; },
    setPointerCapture: function () {},
    releasePointerCapture: function () {},
    appendChild: function (c) { el.children.push(c); return c; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    get clientWidth() { return 800; },
    get clientHeight() { return 600; },
    setProperty: function () {} // for style objects used as CSSStyleDeclaration-ish
  };
  el.style.setProperty = function () {};
  return el;
}

function fakeDom(elementIds) {
  var byId = {};
  (elementIds || []).forEach(function (id) { byId[id] = makeFakeElement(id); });
  var docListeners = {};
  var winListeners = {};
  var document = {
    readyState: "complete",
    getElementById: function (id) { return byId[id] || null; },
    querySelector: function (sel) {
      // Support the couple of selectors layout.js actually uses.
      if (sel === ".grid") return byId[".grid"] || null;
      if (sel === ".col.left") return byId[".col.left"] || null;
      if (sel === ".col.right") return byId[".col.right"] || null;
      return null;
    },
    createElement: function () { return makeFakeElement(); },
    addEventListener: function (ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
    body: makeFakeElement()
  };
  var win = {
    document: document,
    localStorage: fakeLocalStorage(),
    addEventListener: function (ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    _byId: byId
  };
  return win;
}

function load(win, relFile) {
  var abs = path.join(ROOT, relFile);
  var code = fs.readFileSync(abs, "utf8");
  var ctx = vm.createContext(win);
  win.window = win;
  vm.runInContext(code, ctx, { filename: abs });
}

// Values returned by code executed via vm.runInContext live in a different realm: their object
// literals have a different Object/Array prototype than the test file's own. node:assert/strict's
// deepEqual checks prototypes and fails on structurally-identical cross-realm values ("same
// structure but are not reference-equal"). Compare through JSON instead wherever a value may have
// been constructed inside the loaded module.
function sameJSON(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    const assert = require("node:assert/strict");
    assert.fail((message ? message + "\n" : "") + "expected " + e + "\nactual   " + a);
  }
}

module.exports = { ROOT, isObj, deepMerge, makeFakeElement, fakeDom, fakeLocalStorage, load, sameJSON };
