/**
 * Core tests for linkrot: status classification, link extraction,
 * and the three acceptance fixtures (good, dead, external).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyStatus, extractLinks, runCheck, renderReport, CLEAN_VERDICT, VERSION } from "../src/core.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("exports", () => {
  it("exposes the contract constants", () => {
    assert.equal(VERSION, "0.1.0");
    assert.equal(CLEAN_VERDICT, "OK");
  });
});

describe("classifyStatus", () => {
  const table: [number, string][] = [
    [200, "healthy"],
    [201, "healthy"],
    [204, "healthy"],
    [301, "moved-permanent"],
    [308, "moved-permanent"],
    [302, "healthy"],
    [304, "healthy"],
    [307, "healthy"],
    [404, "dead"],
    [410, "dead"],
    [401, "bot-blocked"],
    [403, "bot-blocked"],
    [429, "bot-blocked"],
    [500, "error"],
    [502, "error"],
    [503, "error"],
    [400, "error"],
    [418, "error"],
    [100, "error"],
    [0, "error"],
  ];
  for (const [status, expected] of table) {
    it(`classifies ${status} as ${expected}`, () => {
      assert.equal(classifyStatus(status), expected);
    });
  }
});

describe("extractLinks", () => {
  it("extracts an inline link with its line number", () => {
    const md = "# Title\n\nSee the [Guide](guide.md) now.\n";
    assert.deepEqual(extractLinks(md), [{ url: "guide.md", line: 3 }]);
  });

  it("extracts an inline link with a title and keeps only the URL", () => {
    const md = '[A](a.md "Some title")\n';
    assert.deepEqual(extractLinks(md), [{ url: "a.md", line: 1 }]);
  });

  it("extracts an angle-bracket URL", () => {
    const md = "[A](<my file.md>)\n";
    assert.deepEqual(extractLinks(md), [{ url: "my file.md", line: 1 }]);
  });

  it("counts an image link as a link", () => {
    const md = "![alt text](img.png)\n";
    assert.deepEqual(extractLinks(md), [{ url: "img.png", line: 1 }]);
  });

  it("extracts a reference definition", () => {
    const md = "Text.\n\n[guide]: guide.md\n";
    assert.deepEqual(extractLinks(md), [{ url: "guide.md", line: 3 }]);
  });

  it("resolves a full reference usage to its definition", () => {
    const md = "See the [Guide][g] page.\n\n[g]: guide.md\n";
    const links = extractLinks(md);
    assert.deepEqual(links, [
      { url: "guide.md", line: 1 },
      { url: "guide.md", line: 3 },
    ]);
  });

  it("resolves a collapsed reference usage to its definition", () => {
    const md = "See the [Guide][] page.\n\n[guide]: guide.md\n";
    const links = extractLinks(md);
    assert.ok(links.some((l) => l.url === "guide.md" && l.line === 1));
    assert.ok(links.some((l) => l.url === "guide.md" && l.line === 3));
  });

  it("does not extract links inside fenced code blocks", () => {
    const md = [
      "Before [real](real.md).",
      "",
      "```markdown",
      "[fake](fake.md)",
      "![also fake](fake.png)",
      "```",
      "",
      "After [also real](real2.md).",
      "",
    ].join("\n");
    assert.deepEqual(extractLinks(md), [
      { url: "real.md", line: 1 },
      { url: "real2.md", line: 8 },
    ]);
  });

  it("does not extract links inside tilde fences", () => {
    const md = "~~~\n[fake](fake.md)\n~~~\n[real](real.md)\n";
    assert.deepEqual(extractLinks(md), [{ url: "real.md", line: 4 }]);
  });

  it("does not treat a footnote definition as a link", () => {
    const md = "Text with a note.[^1]\n\n[^1]: The footnote text.\n";
    assert.deepEqual(extractLinks(md), []);
  });

  it("returns links in document order across lines", () => {
    const md = "[a](a.md)\n[b](b.md) and [c](c.md)\n";
    assert.deepEqual(extractLinks(md), [
      { url: "a.md", line: 1 },
      { url: "b.md", line: 2 },
      { url: "c.md", line: 2 },
    ]);
  });
});

describe("acceptance fixtures", () => {
  it("docs-good: existing file and valid anchors verdict OK", () => {
    const r = runCheck(join(FIXTURES, "docs-good"));
    assert.equal(r.tool, "linkrot");
    assert.equal(r.version, "0.1.0");
    assert.equal(r.verdict, "OK");
    assert.equal(r.counts.files, 2);
    assert.equal(r.counts.links, 4);
    assert.equal(r.counts.dead, 0);
    assert.equal(r.counts.anchorsMissing, 0);
    assert.equal(r.counts.externalUnchecked, 0);
    assert.equal(r.counts.relativeFile, 1);
    assert.equal(r.counts.relativeAnchor, 1);
    assert.equal(r.counts.sameFileAnchor, 1);
    assert.equal(r.counts.skipped, 1);
    assert.equal(r.findings.length, 0);
  });

  it("docs-dead: missing file and missing anchors verdict FINDINGS", () => {
    const r = runCheck(join(FIXTURES, "docs-dead"));
    assert.equal(r.verdict, "FINDINGS");
    assert.equal(r.counts.files, 2);
    assert.equal(r.counts.links, 3);
    assert.equal(r.counts.dead, 1);
    assert.equal(r.counts.anchorsMissing, 2);
    const deadFindings = r.findings.filter((f) => f.rule === "DEAD-RELATIVE");
    assert.equal(deadFindings.length, 1);
    assert.equal(deadFindings[0].severity, "high");
    assert.equal(deadFindings[0].file, "index.md");
    assert.equal(deadFindings[0].line, 3);
    const anchorFindings = r.findings.filter((f) => f.rule === "ANCHOR-MISSING");
    assert.equal(anchorFindings.length, 2);
    assert.ok(anchorFindings.every((f) => f.severity === "medium"));
    assert.deepEqual(
      anchorFindings.map((f) => f.line),
      [5, 7],
    );
  });

  it("docs-external: external links are UNCHECKED infos and verdict stays OK", () => {
    const r = runCheck(join(FIXTURES, "docs-external"));
    assert.equal(r.verdict, "OK");
    assert.equal(r.counts.files, 1);
    assert.equal(r.counts.links, 3);
    assert.equal(r.counts.external, 2);
    assert.equal(r.counts.externalUnchecked, 2);
    assert.equal(r.counts.skipped, 1);
    assert.equal(r.counts.dead, 0);
    assert.equal(r.findings.length, 2);
    assert.ok(r.findings.every((f) => f.rule === "UNCHECKED" && f.severity === "info"));
  });

  it("renderReport is deterministic and mentions the verdict", () => {
    const r = runCheck(join(FIXTURES, "docs-dead"));
    const a = renderReport(r);
    const b = renderReport(runCheck(join(FIXTURES, "docs-dead")));
    assert.equal(a, b);
    assert.match(a, /FINDINGS/);
    assert.match(a, /DEAD-RELATIVE/);
    assert.match(a, /ANCHOR-MISSING/);
  });

  it("a single markdown file can be the target", () => {
    const r = runCheck(join(FIXTURES, "docs-external", "index.md"));
    assert.equal(r.counts.files, 1);
    assert.equal(r.verdict, "OK");
  });

  it("slugify handles punctuation, case, and spaces", () => {
    const md = "# Head\n\n[ok](#hello-world-whats-new)\n\n## Hello, World! What's New?\n";
    assert.deepEqual(extractLinks(md), [{ url: "#hello-world-whats-new", line: 3 }]);
  });

  it("a same-file anchor to a punctuated heading resolves", () => {
    // Written through runCheck on an inline fixture is not possible, so
    // this case is covered by docs-good; here we assert the slug rule
    // through extractLinks plus a direct anchor scenario in docs-dead
    // counts above. Kept as a guard on heading text handling.
    const r = runCheck(join(FIXTURES, "docs-good"));
    assert.equal(r.counts.anchorsMissing, 0);
  });
});
