// Self-contained Markdown -> HTML renderer. No dependencies, works offline.
// Supports the subset used by copilot prep docs: headings, hr, blockquotes, unordered/ordered
// lists, GFM tables, paragraphs, and inline bold / italic / code / links.
// Not a full CommonMark implementation; scoped to render prep markdown cleanly.

(function (global) {
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Inline: code first (protect its contents), then bold, italic, links.
  function inline(text) {
    let out = escapeHtml(text);
    const codes = [];
    out = out.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return " " + (codes.length - 1) + " ";
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, label, href) {
      const safe = href.replace(/"/g, "%22");
      return '<a href="' + safe + '" target="_blank" rel="noopener">' + label + "</a>";
    });
    out = out.replace(/ (\d+) /g, function (_, i) {
      return "<code>" + codes[+i] + "</code>";
    });
    return out;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    // split on unescaped pipes
    return s.split("|").map(function (c) { return c.trim(); });
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function render(md) {
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let i = 0;

    function flushParagraph(buf) {
      if (buf.length) {
        html.push("<p>" + inline(buf.join(" ")) + "</p>");
        buf.length = 0;
      }
    }

    while (i < lines.length) {
      let line = lines[i];

      // blank
      if (/^\s*$/.test(line)) { i++; continue; }

      // horizontal rule
      if (/^\s*---\s*$/.test(line) || /^\s*\*\*\*\s*$/.test(line)) {
        html.push("<hr>"); i++; continue;
      }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length;
        html.push("<h" + lvl + ">" + inline(h[2].trim()) + "</h" + lvl + ">");
        i++; continue;
      }

      // table: current line has a pipe and next line is a separator row
      if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const header = splitRow(line);
        i += 2; // skip header + separator
        const rows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && !/^\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        let t = '<table><thead><tr>';
        header.forEach(function (c) { t += "<th>" + inline(c) + "</th>"; });
        t += "</tr></thead><tbody>";
        rows.forEach(function (r) {
          t += "<tr>";
          for (let c = 0; c < header.length; c++) {
            t += "<td>" + inline(r[c] || "") + "</td>";
          }
          t += "</tr>";
        });
        t += "</tbody></table>";
        html.push(t);
        continue;
      }

      // blockquote (consume consecutive > lines)
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        html.push("<blockquote>" + render(buf.join("\n")) + "</blockquote>");
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        html.push("<ul>");
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          html.push("<li>" + inline(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>");
          i++;
        }
        html.push("</ul>");
        continue;
      }

      // ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        html.push("<ol>");
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          html.push("<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
          i++;
        }
        html.push("</ol>");
        continue;
      }

      // paragraph (gather until blank / block start)
      const buf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^\s*(#{1,6}\s|>|[-*+]\s|\d+\.\s|---\s*$)/.test(lines[i]) &&
             !(lines[i].indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        buf.push(lines[i]);
        i++;
      }
      flushParagraph(buf);
    }

    return html.join("\n");
  }

  global.MD = { render: render };
})(typeof window !== "undefined" ? window : globalThis);
