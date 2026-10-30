/**
 * linkrot core: offline markdown link checking.
 *
 * The core is synchronous and offline by design. Relative links are
 * verified against the filesystem, anchors are verified against the
 * heading slugs of the target file, and external links are reported
 * as UNCHECKED info entries instead of being fetched. A 403 from a
 * bot wall is not a dead link, so offline mode never guesses at
 * external liveness. classifyStatus carries the vocabulary a future
 * online mode will use: healthy, dead, moved (with moved-permanent
 * for 301 and 308), bot-blocked, and error.
 *
 * Extraction covers inline links (including image links) and
 * reference-style definitions. Full and collapsed reference usages
 * are resolved to their definitions when the definition is present;
 * the definitions themselves are always checked. Bare URLs in prose
 * and autolinks are not extracted. Links inside fenced code blocks
 * are not extracted.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Finding, Report } from "./types.js";

export const VERSION = "0.1.0";
export const CLEAN_VERDICT = "OK";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/* ------------------------------------------------------------------ */
/* Status classification (online vocabulary)                           */
/* ------------------------------------------------------------------ */

/**
 * Classify an HTTP status code for a future online mode.
 * 301 and 308 are permanent redirects and get the distinct label
 * moved-permanent. Other 2xx and 3xx codes are healthy. 404 and 410
 * are dead. 401, 403, and 429 mean a bot wall or auth gate answered,
 * not that the page is gone, so they are bot-blocked. Everything
 * else, including 5xx, is error.
 */
export function classifyStatus(status: number): string {
  if (status === 301 || status === 308) return "moved-permanent";
  if (status >= 200 && status < 400) return "healthy";
  if (status === 404 || status === 410) return "dead";
  if (status === 401 || status === 403 || status === 429) return "bot-blocked";
  return "error";
}

/* ------------------------------------------------------------------ */
/* Slugs and headings                                                  */
/* ------------------------------------------------------------------ */

/**
 * Slugify a heading the GitHub way, simplified per spec: lowercase,
 * strip punctuation, spaces to hyphens. Inline markdown (links,
 * emphasis, code ticks) is removed first so the slug reflects the
 * rendered heading text.
 */
export function slugifyHeading(text: string): string {
  let t = text.trim();
  t = t.replace(/\s+#+\s*$/, "");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  t = t.replace(/[*`~]/g, "");
  t = t.toLowerCase();
  t = t.replace(/[^\p{L}\p{N}\s\-_]/gu, "");
  t = t.trim().replace(/\s+/g, "-");
  return t;
}

interface FenceState {
  char: string;
  len: number;
}

function fenceMarker(line: string): FenceState | null {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  return { char: m[1][0], len: m[1].length };
}

/** Advance the fence state for one line; returns true if the line is a fence delimiter. */
function stepFence(state: FenceState | null, line: string): { state: FenceState | null; isDelimiter: boolean } {
  const marker = fenceMarker(line);
  if (!marker) return { state, isDelimiter: false };
  if (!state) return { state: marker, isDelimiter: true };
  if (marker.char === state.char && marker.len >= state.len) return { state: null, isDelimiter: true };
  return { state, isDelimiter: false };
}

/**
 * Heading slugs of a markdown document, with duplicate headings
 * suffixed the GitHub way (second occurrence gets -1, third -2).
 * Headings inside fenced code blocks are ignored.
 */
export function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  let fence: FenceState | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const step = stepFence(fence, line);
    fence = step.state;
    if (step.isDelimiter || fence) continue;
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const base = slugifyHeading(m[1]);
    if (!base) continue;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

/* ------------------------------------------------------------------ */
/* Link extraction                                                     */
/* ------------------------------------------------------------------ */

const DEF_RE = /^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/;
const INLINE_RE = /!?\[[^\]]*\]\(([^)]*)\)/g;
const REF_USE_RE = /!?\[[^\]]*\]\[([^\]]*)\]/g;
const REF_TEXT_RE = /!?\[([^\]]*)\]\[/;

function normalizeRefId(id: string): string {
  return id.trim().toLowerCase().replace(/\s+/g, " ");
}

function urlFromInlineInner(inner: string): string {
  const t = inner.trim();
  if (!t) return "";
  if (t.startsWith("<")) {
    const end = t.indexOf(">");
    return end > 0 ? t.slice(1, end) : "";
  }
  return t.split(/\s+/)[0] ?? "";
}

/**
 * Extract links from markdown. Returns inline links (images count),
 * reference definitions, and reference usages resolved to their
 * definition URL. Links inside fenced code blocks are skipped.
 * Each entry carries the raw URL and its 1-based line number.
 */
export function extractLinks(markdown: string): { url: string; line: number }[] {
  const lines = markdown.split(/\r?\n/);
  const defs = new Map<string, string>();
  for (const line of lines) {
    const m = DEF_RE.exec(line);
    if (!m) continue;
    if (m[1].startsWith("^")) continue;
    defs.set(normalizeRefId(m[1]), m[2]);
  }
  const out: { url: string; line: number }[] = [];
  let fence: FenceState | null = null;
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const step = stepFence(fence, line);
    fence = step.state;
    if (step.isDelimiter || fence) return;
    const defMatch = DEF_RE.exec(line);
    if (defMatch && !defMatch[1].startsWith("^")) {
      out.push({ url: defMatch[2], line: lineNo });
      return;
    }
    const found: { url: string; idx: number }[] = [];
    for (const m of line.matchAll(INLINE_RE)) {
      const url = urlFromInlineInner(m[1]);
      if (url) found.push({ url, idx: m.index ?? 0 });
    }
    for (const m of line.matchAll(REF_USE_RE)) {
      const textMatch = REF_TEXT_RE.exec(m[0]);
      const label = m[1] ? m[1] : (textMatch ? textMatch[1] : "");
      const url = defs.get(normalizeRefId(label));
      if (url) found.push({ url, idx: m.index ?? 0 });
    }
    found.sort((a, b) => a.idx - b.idx);
    for (const f of found) out.push({ url: f.url, line: lineNo });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

interface MdFile {
  abs: string;
  rel: string;
}

function isMarkdownName(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

function walkDir(dir: string, root: string, out: MdFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walkDir(abs, root, out);
    } else if (st.isFile() && isMarkdownName(name)) {
      out.push({ abs, rel: relative(root, abs).split(sep).join("/") });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Checking                                                            */
/* ------------------------------------------------------------------ */

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function anchorMatches(fragment: string, slugs: Set<string>): boolean {
  const decoded = decodeSafe(fragment);
  if (slugs.has(decoded)) return true;
  if (slugs.has(decoded.toLowerCase())) return true;
  return slugs.has(slugifyHeading(decoded));
}

export function runCheck(target: string): Report {
  const root = resolve(target);
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    throw new Error(`target not found: ${target}`);
  }
  const files: MdFile[] = [];
  const rootDir = rootStat.isDirectory() ? root : dirname(root);
  if (rootStat.isFile()) {
    if (isMarkdownName(basename(root))) files.push({ abs: root, rel: basename(root) });
  } else if (rootStat.isDirectory()) {
    walkDir(root, root, files);
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const slugCache = new Map<string, Set<string>>();
  const slugsFor = (abs: string, knownContent?: string): Set<string> => {
    const cached = slugCache.get(abs);
    if (cached) return cached;
    let slugs: Set<string>;
    if (knownContent !== undefined) {
      slugs = headingSlugs(knownContent);
    } else {
      try {
        slugs = headingSlugs(readFileSync(abs, "utf8"));
      } catch {
        slugs = new Set<string>();
      }
    }
    slugCache.set(abs, slugs);
    return slugs;
  };

  const findings: Finding[] = [];
  let links = 0;
  let dead = 0;
  let anchorsMissing = 0;
  let externalUnchecked = 0;
  let relativeFile = 0;
  let relativeAnchor = 0;
  let sameFileAnchor = 0;
  let external = 0;
  let skipped = 0;

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.abs, "utf8");
    } catch {
      continue;
    }
    const ownSlugs = slugsFor(file.abs, content);
    for (const link of extractLinks(content)) {
      links += 1;
      const raw = link.url.trim();
      if (!raw) {
        skipped += 1;
        continue;
      }
      if (raw.startsWith("#")) {
        sameFileAnchor += 1;
        const fragment = raw.slice(1);
        if (fragment && !anchorMatches(fragment, ownSlugs)) {
          anchorsMissing += 1;
          findings.push({
            rule: "ANCHOR-MISSING",
            severity: "medium",
            file: file.rel,
            line: link.line,
            message: `Anchor not found in this file: ${raw}`,
            evidence: raw,
          });
        }
        continue;
      }
      if (raw.startsWith("//")) {
        external += 1;
        externalUnchecked += 1;
        findings.push({
          rule: "UNCHECKED",
          severity: "info",
          file: file.rel,
          line: link.line,
          message: `External link not checked in offline mode: ${raw}`,
          evidence: raw,
        });
        continue;
      }
      const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
      if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        if (scheme === "http" || scheme === "https") {
          external += 1;
          externalUnchecked += 1;
          findings.push({
            rule: "UNCHECKED",
            severity: "info",
            file: file.rel,
            line: link.line,
            message: `External link not checked in offline mode: ${raw}`,
            evidence: raw,
          });
        } else {
          skipped += 1;
        }
        continue;
      }
      const hashIdx = raw.indexOf("#");
      const beforeHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
      const fragment = hashIdx >= 0 ? raw.slice(hashIdx + 1) : "";
      const pathPart = beforeHash.split("?")[0];
      if (!pathPart) {
        sameFileAnchor += 1;
        if (fragment && !anchorMatches(fragment, ownSlugs)) {
          anchorsMissing += 1;
          findings.push({
            rule: "ANCHOR-MISSING",
            severity: "medium",
            file: file.rel,
            line: link.line,
            message: `Anchor not found in this file: ${raw}`,
            evidence: raw,
          });
        }
        continue;
      }
      if (fragment) relativeAnchor += 1;
      else relativeFile += 1;
      const decodedPath = decodeSafe(pathPart);
      const resolved = decodedPath.startsWith("/")
        ? resolve(rootDir, `.${decodedPath}`)
        : resolve(dirname(file.abs), decodedPath);
      if (!existsSync(resolved)) {
        dead += 1;
        findings.push({
          rule: "DEAD-RELATIVE",
          severity: "high",
          file: file.rel,
          line: link.line,
          message: `Relative link target does not exist: ${raw}`,
          evidence: raw,
        });
        continue;
      }
      if (fragment) {
        let targetIsMd = false;
        try {
          targetIsMd = statSync(resolved).isFile() && isMarkdownName(resolved);
        } catch {
          targetIsMd = false;
        }
        if (targetIsMd && !anchorMatches(fragment, slugsFor(resolved))) {
          anchorsMissing += 1;
          findings.push({
            rule: "ANCHOR-MISSING",
            severity: "medium",
            file: file.rel,
            line: link.line,
            message: `Anchor not found in target file: ${raw}`,
            evidence: raw,
          });
        }
      }
    }
  }

  findings.sort(
    (a, b) =>
      ((a.file ?? "") < (b.file ?? "") ? -1 : (a.file ?? "") > (b.file ?? "") ? 1 : 0) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );

  const hasFailures = dead > 0 || anchorsMissing > 0;
  const verdict = hasFailures ? "FINDINGS" : CLEAN_VERDICT;
  const counts: Record<string, number> = {
    files: files.length,
    links,
    findings: findings.length,
    dead,
    anchorsMissing,
    externalUnchecked,
    relativeFile,
    relativeAnchor,
    sameFileAnchor,
    external,
    skipped,
  };
  const summary = `Checked ${files.length} file(s), ${links} link(s): ${dead} dead relative, ${anchorsMissing} missing anchor(s), ${externalUnchecked} external unchecked, ${skipped} skipped.`;
  return { tool: "linkrot", version: VERSION, target, verdict, counts, findings, summary };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderReport(report: Report): string {
  const c = report.counts;
  const out: string[] = [];
  out.push(`linkrot check ${report.target}: ${report.verdict}`);
  out.push(
    `  files: ${c.files ?? 0}, links: ${c.links ?? 0}, dead: ${c.dead ?? 0}, missing anchors: ${c.anchorsMissing ?? 0}, external unchecked: ${c.externalUnchecked ?? 0}, skipped: ${c.skipped ?? 0}`,
  );
  out.push(`  ${report.summary}`);
  for (const f of report.findings) {
    out.push(`  [${f.severity.toUpperCase()}] ${f.file ?? ""}:${f.line ?? 0} ${f.rule} ${f.message}`);
  }
  if (report.verdict === CLEAN_VERDICT) {
    out.push("OK: no dead relative links or missing anchors found. External links were not fetched in offline mode.");
  } else {
    out.push("FINDINGS: at least one dead relative link or missing anchor needs fixing.");
  }
  return out.join("\n");
}
