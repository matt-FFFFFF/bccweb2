#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Unit suite for scripts/spdx-header.mjs — stdlib-only (node:test + node:assert),
 * runs without node_modules: `node --test scripts/__tests__/spdx-header.test.mjs`.
 *
 * Drives the exported pure functions directly with in-memory fixtures; never
 * touches git, child_process, or the filesystem. Assertions avoid hard-coding
 * the (informational) copyright year by building expectations from headerLines().
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isInScope,
  headerLines,
  hasHeader,
  applyFix,
  COPYRIGHT_RE,
  LICENSE_RE,
} from "../spdx-header.mjs";

const LINE = { kind: "line", prefix: "// " };
const CSS = { kind: "block", open: "/* ", close: " */" };

// ─── isInScope ────────────────────────────────────────────────────────────────

test("isInScope: // style for JS/TS-family suffixes", () => {
  for (const f of ["foo.ts", "a.tsx", "b.mts", "c.cts", "d.js", "e.mjs", "f.cjs"]) {
    const style = isInScope(f);
    assert.equal(style?.kind, "line", `${f} should be a line style`);
    assert.equal(style?.prefix, "// ", `${f} should use the // prefix`);
  }
});

test("isInScope: # style for terraform/yaml/shell/toml + exact basenames", () => {
  const hashFiles = [
    "main.tf",
    "common-dev.tfvars",
    "dev.tfvars.example",
    "x.backend.hcl",
    "y.tftest.hcl",
    "ci.yml",
    "a.yaml",
    "s.sh",
    ".mise.toml",
    "Dockerfile.dev",
    "Caddyfile",
    "Makefile",
  ];
  for (const f of hashFiles) {
    const style = isInScope(f);
    assert.equal(style?.kind, "line", `${f} should be a line style`);
    assert.equal(style?.prefix, "# ", `${f} should use the # prefix`);
  }
});

test("isInScope: exact-basename # rules match under a directory prefix", () => {
  // Basenames are matched on the last path segment, not just at repo root.
  assert.equal(isInScope("apps/api/Dockerfile.dev")?.prefix, "# ");
  assert.equal(isInScope("apps/web/Caddyfile")?.prefix, "# ");
});

test("isInScope: block style for .css", () => {
  const style = isInScope("a.css");
  assert.equal(style?.kind, "block");
  assert.equal(style?.open, "/* ");
  assert.equal(style?.close, " */");
});

test("isInScope: .tfvars.example wins over a bare .example (longest suffix first)", () => {
  // There is no `.example` rule; the file must resolve via `.tfvars.example`.
  assert.equal(isInScope("iac/env/dev.tfvars.example")?.prefix, "# ");
});

test("isInScope: null for excluded / unlisted paths", () => {
  const outOfScope = [
    "vite-env.d.ts",
    "x.d.mts",
    "x.d.cts",
    "host.json",
    "README.md",
    "apps/web/index.html",
    ".github/FUNDING.yml",
    ".azurite/.gitkeep",
    "plain",
  ];
  for (const f of outOfScope) {
    assert.equal(isInScope(f), null, `${f} should be out of scope`);
  }
});

// ─── hasHeader ────────────────────────────────────────────────────────────────

test("hasHeader: compliant two-line content is detected", () => {
  const [c, l] = headerLines(LINE);
  assert.equal(hasHeader(`${c}\n${l}\n`), true);
});

test("hasHeader: licence-only is false", () => {
  const [, l] = headerLines(LINE);
  assert.equal(hasHeader(`${l}\nimport x;\n`), false);
});

test("hasHeader: copyright-only is false", () => {
  const [c] = headerLines(LINE);
  assert.equal(hasHeader(`${c}\nimport x;\n`), false);
});

test("hasHeader: empty content is false", () => {
  assert.equal(hasHeader(""), false);
});

// ─── applyFix ─────────────────────────────────────────────────────────────────

test("applyFix: no-SPDX .ts gets two // lines prepended", () => {
  const [c, l] = headerLines(LINE);
  const result = applyFix("import x;\n", LINE);
  assert.equal(result, `${c}\n${l}\nimport x;\n`);
  assert.equal(result, applyFix(result, LINE), "idempotent");
});

test("applyFix: shebang stays on line 0, SPDX inserted below it", () => {
  const [c, l] = headerLines(LINE);
  const content = "#!/usr/bin/env node\nconsole.log(1);\n";
  const result = applyFix(content, LINE);
  const lines = result.split("\n");
  assert.equal(lines[0], "#!/usr/bin/env node");
  assert.equal(lines[1], c);
  assert.equal(lines[2], l);
  assert.equal(lines[3], "console.log(1);");
  assert.equal(result, applyFix(result, LINE), "idempotent");
});

test("applyFix: upgrade case inserts copyright directly above existing licence", () => {
  const content = "// SPDX-License-Identifier: MPL-2.0\nimport x;\n";
  const result = applyFix(content, LINE);
  const lines = result.split("\n");
  const copyMatches = lines.filter((x) => COPYRIGHT_RE.test(x)).length;
  const licMatches = lines.filter((x) => LICENSE_RE.test(x)).length;
  assert.equal(copyMatches, 1, "exactly one copyright line");
  assert.equal(licMatches, 1, "exactly one licence line");
  const ci = lines.findIndex((x) => COPYRIGHT_RE.test(x));
  const li = lines.findIndex((x) => LICENSE_RE.test(x));
  assert.equal(li, ci + 1, "copyright directly above licence");
  assert.equal(result, applyFix(result, LINE), "idempotent");
});

test("applyFix: two-line .ts file becomes a valid 4-line header'd output", () => {
  const [c, l] = headerLines(LINE);
  const content = "const a = 1;\nconst b = 2;";
  const result = applyFix(content, LINE);
  const lines = result.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], c);
  assert.equal(lines[1], l);
  assert.equal(hasHeader(result), true);
  assert.equal(result, applyFix(result, LINE), "idempotent");
});

test("applyFix: no-SPDX .css gets two block-comment lines at the top", () => {
  const [c, l] = headerLines(CSS);
  const content = "body { color: red; }\n";
  const result = applyFix(content, CSS);
  const lines = result.split("\n");
  assert.equal(lines[0], c);
  assert.equal(lines[1], l);
  assert.ok(lines[0].startsWith("/* ") && lines[0].endsWith(" */"));
  assert.equal(hasHeader(result), true);
  assert.equal(result, applyFix(result, CSS), "idempotent");
});

test("applyFix: already-compliant content is returned unchanged", () => {
  const [c, l] = headerLines(LINE);
  const content = `${c}\n${l}\nimport x;\n`;
  assert.equal(applyFix(content, LINE), content);
});

test("applyFix: empty content is skipped", () => {
  assert.equal(applyFix("", LINE), "");
});
