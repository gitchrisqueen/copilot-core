"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./harness");

function render(md) {
  const win = { console: console };
  load(win, "js/md.js");
  return win.MD.render(md);
}

test("md: renders headings", () => {
  assert.equal(render("# Title"), "<h1>Title</h1>");
  assert.equal(render("### Sub"), "<h3>Sub</h3>");
});

test("md: renders a paragraph with inline formatting", () => {
  const html = render("Hello **bold** and *italic* and `code`.");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test("md: escapes HTML in content", () => {
  const html = render("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("md: renders unordered and ordered lists", () => {
  assert.equal(render("- a\n- b"), "<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
  assert.equal(render("1. a\n2. b"), "<ol>\n<li>a</li>\n<li>b</li>\n</ol>");
});

test("md: renders a GFM table", () => {
  const html = render("| A | B |\n|---|---|\n| 1 | 2 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test("md: renders a blockquote recursively", () => {
  const html = render("> quoted **text**");
  assert.match(html, /<blockquote>/);
  assert.match(html, /<strong>text<\/strong>/);
});

test("md: renders a link with escaped href quotes", () => {
  const html = render('[label](http://x/"y)');
  assert.match(html, /href="http:\/\/x\/%22y"/);
});

test("md: horizontal rule", () => {
  assert.equal(render("---"), "<hr>");
});
