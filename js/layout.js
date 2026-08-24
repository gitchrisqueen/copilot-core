// Copilot Core — layout controls: collapsible Live Copilot panel, and draggable
// row/column dividers. Self-initializing, kept separate from app render logic.
// Vanilla JS, no build step, works offline.
//
// Namespacing: localStorage keys are prefixed with window.CopilotCore.ns (set by the
// app's own config.js before this script loads). Falls back to "cc" if unset so the
// module still works when loaded standalone (e.g. in tests).
(function () {
  "use strict";

  var NS = (window.CopilotCore && window.CopilotCore.ns) || "cc";
  var LS = {
    collapsed: NS + "_copilot_collapsed",
    copilotH: NS + "_copilot_height",
    leftW: NS + "_left_width"
  };
  var DIVIDER = 6; // px, must match the grid track sizes in the app's css

  function el(id) { return document.getElementById(id); }
  function getNum(key) {
    try { var v = parseFloat(localStorage.getItem(key)); return isFinite(v) ? v : null; }
    catch (e) { return null; }
  }
  function setLS(key, val) { try { localStorage.setItem(key, String(val)); } catch (e) {} }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---------- collapsible Live Copilot ----------
  function isCollapsed() {
    try { return localStorage.getItem(LS.collapsed) === "1"; } catch (e) { return false; }
  }
  function applyCollapsed(collapsed, panel, rightCol) {
    panel.classList.toggle("collapsed", collapsed);
    rightCol.classList.toggle("copilot-collapsed", collapsed);
    var cbtn = el("copilot-collapse");
    if (cbtn) cbtn.innerHTML = collapsed ? "&#9656;" : "&#9662;";   // ▸ collapsed / ▾ expanded
    if (collapsed) {
      panel.style.height = ""; // header-only; the grid row is pinned to the header height below
      var bar = el("copilot-tabbar");
      var h = bar ? Math.round(bar.getBoundingClientRect().height) : 0;
      rightCol.style.setProperty("--collapsed-h", (h > 16 ? h : 42) + "px"); // deterministic, never 0
    } else {
      applyCopilotHeight(panel, rightCol); // restore the dragged height
    }
  }
  function initCollapse(panel, rightCol) {
    var btn = el("copilot-collapse");           // collapse is its own button (tabs live in the bar too)
    if (!btn) return;
    applyCollapsed(isCollapsed(), panel, rightCol);
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var next = !panel.classList.contains("collapsed");
      setLS(LS.collapsed, next ? "1" : "0");
      applyCollapsed(next, panel, rightCol);
    });
  }

  // ---------- copilot panel height (row divider) ----------
  function copilotBounds(rightCol) {
    var colH = rightCol.clientHeight;
    // leave room for the divider, the gaps, and a minimum binder height
    var min = 90;                                 // header-only-ish
    var max = Math.max(min, Math.round(colH * 0.70));
    return { min: min, max: max };
  }
  function applyCopilotHeight(panel, rightCol) {
    if (panel.classList.contains("collapsed")) return;
    var b = copilotBounds(rightCol);
    var h = getNum(LS.copilotH);
    if (h == null) { panel.style.height = ""; return; } // default: grid `auto`
    panel.style.height = clamp(h, b.min, b.max) + "px";
  }
  function initRowDivider(panel, rightCol) {
    var div = el("row-divider");
    if (!div) return;
    applyCopilotHeight(panel, rightCol);
    var startY, startH;
    div.addEventListener("pointerdown", function (e) {
      if (panel.classList.contains("collapsed")) return;
      e.preventDefault();
      startY = e.clientY;
      startH = panel.getBoundingClientRect().height;
      div.setPointerCapture(e.pointerId);
      div.classList.add("active");
      document.body.classList.add("dragging", "row-resizing");
    });
    div.addEventListener("pointermove", function (e) {
      if (startY == null) return;
      var b = copilotBounds(rightCol);
      var h = clamp(startH + (startY - e.clientY), b.min, b.max);
      panel.style.height = h + "px";
    });
    function end(e) {
      if (startY == null) return;
      startY = null;
      div.classList.remove("active");
      document.body.classList.remove("dragging", "row-resizing");
      try { div.releasePointerCapture(e.pointerId); } catch (err) {}
      setLS(LS.copilotH, Math.round(panel.getBoundingClientRect().height));
    }
    div.addEventListener("pointerup", end);
    div.addEventListener("pointercancel", end);
  }

  // ---------- left/right column widths (column divider) ----------
  function gridBounds(grid) {
    var total = grid.clientWidth;
    var padGap = 12 * 2 + DIVIDER + 12 * 2; // padding L/R + divider + two gaps
    var min = 320;
    var maxLeft = Math.max(min, total - padGap - min);
    return { min: min, max: maxLeft, total: total };
  }
  function applyLeftWidth(grid) {
    var w = getNum(LS.leftW);
    if (w == null) { grid.style.gridTemplateColumns = ""; return; } // default 1fr 6px 1fr
    var b = gridBounds(grid);
    w = clamp(w, b.min, b.max);
    grid.style.gridTemplateColumns = w + "px " + DIVIDER + "px 1fr";
  }
  function initColDivider(grid, leftCol) {
    var div = el("col-divider");
    if (!div) return;
    applyLeftWidth(grid);
    var startX, startW;
    div.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      startX = e.clientX;
      startW = leftCol.getBoundingClientRect().width;
      div.setPointerCapture(e.pointerId);
      div.classList.add("active");
      document.body.classList.add("dragging", "col-resizing");
    });
    div.addEventListener("pointermove", function (e) {
      if (startX == null) return;
      var b = gridBounds(grid);
      var w = clamp(startW + (e.clientX - startX), b.min, b.max);
      grid.style.gridTemplateColumns = w + "px " + DIVIDER + "px 1fr";
    });
    function end(e) {
      if (startX == null) return;
      startX = null;
      div.classList.remove("active");
      document.body.classList.remove("dragging", "col-resizing");
      try { div.releasePointerCapture(e.pointerId); } catch (err) {}
      setLS(LS.leftW, Math.round(leftCol.getBoundingClientRect().width));
    }
    div.addEventListener("pointerup", end);
    div.addEventListener("pointercancel", end);
  }

  function init() {
    var grid = document.querySelector(".grid");
    var leftCol = document.querySelector(".col.left");
    var rightCol = document.querySelector(".col.right");
    var panel = el("copilot-panel");
    if (!grid || !rightCol || !panel) return;

    initCollapse(panel, rightCol);
    initRowDivider(panel, rightCol);
    initColDivider(grid, leftCol);

    // re-clamp stored sizes to the current viewport on resize
    window.addEventListener("resize", function () {
      applyLeftWidth(grid);
      applyCopilotHeight(panel, rightCol);
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  // Exposed for tests (fakeDom-driven) and for apps that want to re-init after a DOM swap.
  window.CopilotLayout = { init: init, _LS: LS };
})();
