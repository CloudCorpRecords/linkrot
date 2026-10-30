# linkrot

Docs link checker that separates failure kinds instead of calling every bad response a dead link. Relative links and anchors are verified against the filesystem. External links are classified by what actually happened: healthy, dead, moved, bot-blocked, or error. A 403 from a bot wall is not a dead link, and linkrot never reports it as one.

## What it does

* Walks a target directory for markdown files (skipping node_modules, .git, and dist) or checks a single markdown file.
* Extracts inline links (image links count), reference-style definitions, and reference usages that resolve to a definition. Links inside fenced code blocks are ignored. Bare URLs in prose and autolinks are not extracted.
* Checks each link by class:
  * RELATIVE-FILE: the path part is resolved relative to the markdown file. A missing target is a DEAD-RELATIVE finding (high).
  * RELATIVE-ANCHOR: the file exists but the anchor slug is not among the target file heading slugs. That is an ANCHOR-MISSING finding (medium). Slugs are built by lowercasing, stripping punctuation, and turning spaces into hyphens.
  * SAME-FILE-ANCHOR: a link like #section in the same file, checked against that file heading slugs with the same ANCHOR-MISSING rule.
  * EXTERNAL: http and https links are reported as UNCHECKED info entries in offline mode. They are counted and never fail the check.
  * MAILTO and other schemes are skipped silently and counted under skipped.

## Install

```bash
npx @reneturcios/linkrot check .
```

Or install globally:

```bash
npm install -g @reneturcios/linkrot
```

## CLI

```bash
linkrot check [path] [--json]
linkrot mcp
linkrot --version
```

* `check` runs the offline check on a path (default: current directory). Exit code is 0 when the verdict is OK and 1 for any other verdict. Use `--json` for the machine-readable report.
* `mcp` starts the MCP server on stdio.
* `--version` prints the version.

## MCP

The MCP server exposes one tool:

* `check_links` with a `path` argument. It returns the same JSON report as `linkrot check --json`.

## Offline by default

Offline mode is the default and the shipped default. The core is synchronous and performs no network requests.

This is deliberate. The founding observation behind linkrot is that automated fetches routinely hit bot walls, login gates, and rate limits. A checker that fetches every external URL and treats any non-2xx response as dead will report healthy pages as broken whenever a site blocks bots. Offline mode avoids that failure entirely: it proves what can be proven locally (relative files and anchors) and reports external links honestly as UNCHECKED instead of guessing.

## Link classes and status vocabulary

When an online mode checks external URLs in the future, each HTTP status maps to exactly one class:

| Class | Meaning |
| --- | --- |
| healthy | 2xx, plus 3xx redirects that are not permanent moves (for example 302, 304, 307) |
| dead | 404 or 410: the page is gone |
| moved | A redirect to a new location. Permanent redirects (301, 308) get the distinct label moved-permanent. |
| bot-blocked | 401, 403, or 429: a bot wall, auth gate, or rate limit answered. The page may be fine for a human. |
| error | 5xx and anything else: the check itself could not get a trustworthy answer |

The function `classifyStatus(status)` implements this table and is unit tested. Keeping bot-blocked separate from dead is the point of the tool: conflating them turns every Cloudflare or login wall into a false dead-link report.

## Verdict rules

* Verdict is OK when there are no DEAD-RELATIVE and no ANCHOR-MISSING findings.
* Verdict is FINDINGS otherwise.
* UNCHECKED external entries never affect the verdict in offline mode.

The report counts files, links, dead, anchorsMissing, and externalUnchecked, plus per-class counts: relativeFile, relativeAnchor, sameFileAnchor, external, and skipped.

## Limits

* The offline core checks relative links and anchors only.
* External liveness is not checked offline. External links are reported UNCHECKED, never guessed as healthy or dead. A future online mode will classify them with the vocabulary above.
* Extraction covers inline links and reference definitions (with full and collapsed reference usages resolved). Shortcut reference links, bare URLs, and autolinks are not extracted.
* Anchor checks apply when the link target is a markdown file. Anchors pointing into non-markdown files are not verified.
* Heading slugs follow a simplified GitHub rule: lowercase, strip punctuation, spaces to hyphens, with duplicate headings suffixed -1, -2, and so on.

## Development

```bash
npm install
npm run build
npm test
```
