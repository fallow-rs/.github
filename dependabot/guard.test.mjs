// Tests for guard.mjs, the patch check in the publish job of the reusable
// dependabot.yml workflow.
//
// Run: node --test dependabot/guard.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  addedLines,
  checkRepair,
  MAX_CHANGED_LINES,
  parseNumstat,
  parseRawModes,
} from "./guard.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./guard.mjs", import.meta.url));
const file = (path, added = 1, deleted = 1, mode = "100644") => ({ path, added, deleted, mode });

test("one commit with a test and a lockfile change passes and auto-merges", () => {
  const files = [file("scripts/workflow-policy.test.mjs"), file("package-lock.json", 900, 900)];
  assert.deepEqual(checkRepair({ commits: 1, files }), { ok: true, problems: [], merge: "auto" });
});

test("more than one commit is rejected", () => {
  assert.deepEqual(checkRepair({ commits: 2, files: [file("src/a.ts")] }).problems, [
    "the patch has 2 commits, not 1",
  ]);
});

test("a change under .github or to the changelog is rejected", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/scripts/dependabot-triage.mjs",
    "CHANGELOG.md",
    "changelog.d/fix.md",
  ]) {
    const result = checkRepair({ commits: 1, files: [file(path)] });
    assert.equal(result.ok, false, path);
    assert.match(result.problems[0], /may not change/u, path);
  }
});

const FALLOW = {
  generated: /^crates\/cli\/viz-assets\/|^tests\/coverage-producer-corpus\/manifest\.json$/u,
  reviewGenerated:
    /^(?:schema\.json|docs\/output-schema\.json|npm\/fallow\/types\/output-contract\.d\.ts|editors\/vscode\/src\/generated\/[\w.-]+\.ts|crates\/api\/[\w-]+\.json)$|(?:^|\/)generated-protocol\.mjs$/u,
};

test("a large hand-written change is rejected, while generated files do not count", () => {
  const big = MAX_CHANGED_LINES;
  assert.equal(checkRepair({ commits: 1, files: [file("crates/a/src/lib.rs", big, 1)] }).ok, false);
  const generated = [
    file("Cargo.lock", big, big),
    file("editors/vscode/pnpm-lock.yaml", big, big),
    file("crates/cli/viz-assets/viz.js", big, big),
    file("tests/coverage-producer-corpus/manifest.json", big, big),
  ];
  assert.equal(checkRepair({ commits: 1, files: generated }, FALLOW).ok, true);
});

test("a path with a control character is rejected and does not break the parse", () => {
  const records = ["1\t0\tsrc/a.ts", "2\t0\tdocs/x\n.github/workflows/ci.yml", "-\t-\tlogo.png"];
  const files = parseNumstat(`${records.join("\0")}\0`);
  assert.deepEqual(
    files.map(({ path }) => path),
    ["src/a.ts", "docs/x\n.github/workflows/ci.yml", "logo.png"],
  );
  assert.match(checkRepair({ commits: 1, files: [files[1]] }).problems[0], /control character/u);
});

test("regenerated contract files do not count toward the size limit but need review", () => {
  const big = MAX_CHANGED_LINES;
  const files = [
    file("schema.json", big, big),
    file("docs/output-schema.json", big, big),
    file("npm/fallow/types/output-contract.d.ts", big, big),
    file("editors/vscode/src/generated/output-contract.d.ts", big, big),
    file("crates/api/type-aware-protocol.json", big, big),
    file("tools/type-aware-sidecar/src/generated-protocol.mjs", big, big),
    file("Cargo.lock"),
  ];
  const result = checkRepair({ commits: 1, files }, FALLOW);
  assert.equal(result.ok, true, result.problems.join("; "));
  assert.equal(result.merge, "review");
});

test("a binary file is rejected", () => {
  const files = [file("assets/logo.png", null, null)];
  assert.match(checkRepair({ commits: 1, files }).problems[0], /binary/u);
});

test("a symbolic link or a submodule is rejected", () => {
  const link = checkRepair({ commits: 1, files: [file("docs/link", 1, 0, "120000")] });
  assert.match(link.problems[0], /symbolic link/u);
  const module = checkRepair({ commits: 1, files: [file("vendor/x", 1, 0, "160000")] });
  assert.match(module.problems[0], /submodule/u);
});

test("a change to code that a build runs is accepted but needs review", () => {
  for (const path of ["crates/mcp/src/server.rs", "crates/cli/build.rs", "hk.pkl"]) {
    const result = checkRepair({ commits: 1, files: [file(path), file("Cargo.lock")] });
    assert.equal(result.ok, true, path);
    assert.equal(result.merge, "review", path);
  }
  const snapshots = [file("crates/cli/tests/snapshots/a.snap")];
  assert.equal(checkRepair({ commits: 1, files: snapshots }).merge, "auto");
  const viz = [file("crates/cli/viz-assets/viz.js")];
  assert.equal(checkRepair({ commits: 1, files: viz }, FALLOW).merge, "auto");
});

test("a file in manifest paths auto-merges only when its added lines set versions", () => {
  const SKILLS = {
    generated: /^fallow\/codex-app\//u,
    manifest: /^(?:\.claude-plugin\/marketplace\.json|fallow\/\.(?:claude|codex)-plugin\/plugin\.json)$/u,
  };
  const files = [
    file("codex-app/package-lock.json"),
    file("fallow/codex-app/server.mjs", 40, 40),
    file("fallow/.codex-plugin/plugin.json"),
    file(".claude-plugin/marketplace.json", 2, 2),
  ];
  const bump = ['  "version": "1.4.36",', '      "version": "1.4.36",'];
  assert.equal(checkRepair({ commits: 1, files, manifestLines: bump }, SKILLS).merge, "auto");
  const hook = [...bump, '  "hooks": "./hooks/run.sh",'];
  assert.equal(checkRepair({ commits: 1, files, manifestLines: hook }, SKILLS).merge, "review");
  assert.equal(checkRepair({ commits: 1, files, manifestLines: bump }).merge, "review");
});

test("a lockfile change with registry sources only auto-merges", () => {
  const files = [file("crates/cli/tests/snapshots/a.snap"), file("Cargo.lock")];
  assert.equal(checkRepair({ commits: 1, files }).merge, "auto");
});

test("the raw diff gives the new mode of each path", () => {
  const raw = [":100644 120000 aaa bbb T", "docs/link", ":000000 100644 000 ccc A", "a b.txt", ""];
  assert.deepEqual(
    [...parseRawModes(raw.join("\0"))],
    [
      ["docs/link", "120000"],
      ["a b.txt", "100644"],
    ],
  );
});

test("the script started as a process checks the patch in a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "repair-guard-"));
  const git = (...args) => {
    const run = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const before = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "CHANGELOG.md"), "entry\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "repair");

  const run = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, BEFORE: before },
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /CHANGELOG\.md may not change/u);
});

test("the script reads MANIFEST_PATHS for the version lines of a plugin manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "repair-guard-"));
  const git = (...args) => {
    const run = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "plugin.json"), '{\n  "version": "1.0.0"\n}\n');
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const before = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "plugin.json"), '{\n  "version": "1.0.1"\n}\n');
  git("commit", "--quiet", "-am", "repair");

  const merge = (manifestPaths) => {
    const output = join(dir, `output-${manifestPaths.length}.txt`);
    writeFileSync(output, "");
    const run = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, BEFORE: before, GITHUB_OUTPUT: output, MANIFEST_PATHS: manifestPaths },
    });
    assert.equal(run.status, 0, run.stdout);
    return readFileSync(output, "utf8").trim();
  };
  assert.equal(merge("^plugin\\.json$"), "merge=auto");
  assert.equal(merge(""), "merge=review");
});

test("without options lockfiles do not count toward the size limit and snapshots are generated", () => {
  const big = MAX_CHANGED_LINES;
  assert.equal(
    checkRepair({ commits: 1, files: [file("crates/cli/viz-assets/viz.js", big, big)] }).ok,
    false,
  );
  const lock = [file("bun.lock", big, big), file("yarn.lock", big, big), file("a.snap", big, big)];
  assert.deepEqual(checkRepair({ commits: 1, files: lock }), {
    ok: true,
    problems: [],
    merge: "auto",
  });
});

test("a repair of lockfiles, manifests and tests auto-merges when every source is the registry", () => {
  const files = [
    file("bun.lock", 20, 30),
    file("site/package.json"),
    file("crates/a/Cargo.toml"),
    file("scripts/workflow-policy.test.mjs"),
    file("src/__tests__/parse.test.ts"),
    file("crates/a/tests/it.rs"),
  ];
  const sourceLines = [
    '    "@oxc-project/runtime": ["@oxc-project/runtime@0.153.0", "", {}, "sha512-abc"],',
    '      "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz",',
  ];
  const manifestLines = [
    '        "vite": "npm:@voidzero-dev/vite-plus-core@1.1.0",',
    'serde = "1.0.210"',
  ];
  assert.equal(checkRepair({ commits: 1, files, sourceLines, manifestLines }).merge, "auto");
});

test("a new package source outside the registry needs review", () => {
  const files = [file("package.json"), file("Cargo.toml"), file("package-lock.json")];
  for (const line of [
    '    "a": "github:x/y",',
    '    "a": "git+ssh://git@github.com/x/y.git",',
    '    "a": "file:../a",',
    '    "a": "link:../a",',
    'a = { git = "https://github.com/x/y" }',
    'a = { path = "../a" }',
    '      "resolved": "https://evil.example/a.tgz",',
  ]) {
    assert.equal(checkRepair({ commits: 1, files, sourceLines: [line] }).merge, "review", line);
    assert.equal(checkRepair({ commits: 1, files, manifestLines: [line] }).merge, "review", line);
  }
});

test("a change to application code still needs review", () => {
  const files = [file("src/server.ts"), file("package.json")];
  assert.equal(checkRepair({ commits: 1, files }).merge, "review");
});

test("added lines come from hunks only", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    "+++ b/package.json",
    "@@ -1 +1,2 @@",
    '-    "a": "1.0.0",',
    '+    "a": "1.1.0",',
  ].join("\n");
  assert.deepEqual(addedLines(diff), ['    "a": "1.1.0",']);
});

test("a manifest line that is not a dependency version needs review", () => {
  const files = [file("package.json")];
  for (const line of [
    '    "postinstall": "node evil.js",',
    '    "test": "vitest run",',
    'build = "build.rs"',
  ]) {
    assert.equal(checkRepair({ commits: 1, files, manifestLines: [line] }).merge, "review", line);
  }
  const ok = [
    '    "vite": "^7.1.0",',
    '    "a": "npm:b@1.2.3",',
    'serde = "1.0.210"',
    'tokio = { version = "1.48", features = ["rt"] }',
    "  },",
  ];
  assert.equal(checkRepair({ commits: 1, files, manifestLines: ok }).merge, "auto");
});
