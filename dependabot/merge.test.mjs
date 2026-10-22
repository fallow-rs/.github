// Tests for merge.mjs, the merge decision in the reusable dependabot.yml
// workflow.
//
// Run: node --test dependabot/merge.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decideMerge, squashSubject, updateTypes } from "./merge.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./merge.mjs", import.meta.url));
const HEAD = "abc123";
const MINOR_COMMIT = {
  author: "dependabot[bot]",
  verified: true,
  message:
    "chore(deps): bump a from 1.2.0 to 1.3.0\n\n---\nupdated-dependencies:\n- dependency-name: a\n  dependency-version: 1.3.0\n  dependency-type: direct:production\n  update-type: version-update:semver-minor\n...\n",
};
const pass = (name) => ({ name, status: "completed", conclusion: "success" });

const input = (overrides = {}) => ({
  pr: { number: 7, headSha: HEAD, labels: [], mergeableState: "clean" },
  runHeadSha: HEAD,
  commits: [MINOR_COMMIT],
  checkRuns: [pass("Test"), pass("Lint")],
  combinedStatus: { state: "pending", total: 0 },
  ...overrides,
});

test("a minor update with every check passed merges", () => {
  assert.deepEqual(decideMerge(input()), {
    merge: true,
    reason: "every check passed",
    sync: false,
    edited: false,
  });
});

test("a run for an older head commit does not merge", () => {
  assert.equal(decideMerge(input({ runHeadSha: "old" })).merge, false);
});

test("a review or hand-off label stops the merge", () => {
  for (const label of ["needs-review", "needs-human"]) {
    const pr = { number: 7, headSha: HEAD, labels: [label], mergeableState: "clean" };
    assert.match(decideMerge(input({ pr })).reason, new RegExp(label, "u"));
  }
});

test("a commit from a person stops the merge", () => {
  const commits = [MINOR_COMMIT, { author: "octocat", message: "fix" }];
  assert.equal(decideMerge(input({ commits })).merge, false);
});

test("a signed repair commit of the App keeps the merge, an unsigned claude[bot] one does not", () => {
  const signed = { author: "fallow-dependabot[bot]", committer: "web-flow", verified: true, parents: 1, message: "fix" };
  assert.equal(decideMerge(input({ commits: [MINOR_COMMIT, signed] })).merge, true);
  const unsigned = { author: "claude[bot]", committer: "claude[bot]", verified: false, message: "fix" };
  assert.match(decideMerge(input({ commits: [MINOR_COMMIT, unsigned] })).reason, /claude\[bot\] has pushed/u);
});

test("a major update merges when every check passed", () => {
  const major = {
    ...MINOR_COMMIT,
    message: MINOR_COMMIT.message.replace("semver-minor", "semver-major"),
  };
  assert.equal(decideMerge(input({ commits: [major] })).merge, true);
});

test("an update without an update type merges when Dependabot names the dependency", () => {
  const sha = {
    author: "dependabot[bot]",
    verified: true,
    message:
      "chore(deps): bump x/action from abc to def\n\n---\nupdated-dependencies:\n- dependency-name: x/action\n  dependency-version: def\n  dependency-type: direct:production\n...\n",
  };
  assert.equal(decideMerge(input({ commits: [sha] })).merge, true);
  const plain = { author: "dependabot[bot]", verified: true, message: "chore(deps): bump a" };
  assert.match(decideMerge(input({ commits: [plain] })).reason, /metadata/u);
});

test("the update types of a group are read in order", () => {
  const message =
    "chore(deps): bump the x group with 2 updates\n\n---\nupdated-dependencies:\n- dependency-name: a\n  update-type: version-update:semver-patch\n- dependency-name: b\n  update-type: version-update:semver-major\n...\n";
  assert.deepEqual(updateTypes(message), ["patch", "major"]);
});

test("no checks, a running check or a failed check stops the merge", () => {
  assert.match(decideMerge(input({ checkRuns: [] })).reason, /no check/u);
  const running = [pass("Test"), { name: "Lint", status: "in_progress", conclusion: null }];
  assert.match(decideMerge(input({ checkRuns: running })).reason, /Lint/u);
  const failed = [pass("Test"), { name: "Lint", status: "completed", conclusion: "failure" }];
  assert.match(decideMerge(input({ checkRuns: failed })).reason, /Lint/u);
});

test("an ignored check does not stop the merge and does not count as a check", () => {
  const checkRuns = [
    pass("Test"),
    { name: "CodSpeed Performance Analysis", status: "completed", conclusion: "failure" },
  ];
  const options = { ignoreCheck: /^CodSpeed/u };
  assert.equal(decideMerge(input({ checkRuns }), options).merge, true);
  assert.equal(decideMerge(input({ checkRuns }), {}).merge, false);
  const onlyIgnored = [checkRuns[1]];
  assert.match(decideMerge(input({ checkRuns: onlyIgnored }), options).reason, /no check/u);
});

test("skipped and neutral checks count as passed", () => {
  const checkRuns = [
    pass("Test"),
    { name: "Bench", status: "completed", conclusion: "skipped" },
    { name: "Info", status: "completed", conclusion: "neutral" },
  ];
  assert.equal(decideMerge(input({ checkRuns })).merge, true);
});

test("a failed commit status or a merge conflict stops the merge", () => {
  assert.equal(decideMerge(input({ combinedStatus: { state: "failure", total: 1 } })).merge, false);
  const pr = { number: 7, headSha: HEAD, labels: [], mergeableState: "dirty" };
  assert.match(decideMerge(input({ pr })).reason, /conflict/u);
});

test("the script started as a process checks its environment before any request", () => {
  const run = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /missing environment: GITHUB_TOKEN/u);
});

test("a workflow run that is still queued or failed holds the merge before its checks exist", () => {
  const queued = [{ name: "Tests", status: "queued", conclusion: null }];
  assert.match(
    decideMerge(input({ workflowRuns: queued })).reason,
    /Tests workflow is still running/u,
  );
  const failed = [{ name: "Tests", status: "completed", conclusion: "failure" }];
  assert.match(decideMerge(input({ workflowRuns: failed })).reason, /Tests workflow ended/u);
  const waiting = [{ name: "Deploy", status: "completed", conclusion: "action_required" }];
  assert.equal(decideMerge(input({ workflowRuns: waiting })).merge, false);
  const done = [{ name: "Tests", status: "completed", conclusion: "success" }];
  assert.equal(decideMerge(input({ workflowRuns: done })).merge, true);
});

test("more items than one page holds the merge", () => {
  assert.match(decideMerge(input({ complete: false })).reason, /one page/u);
});

test("a commit without a GitHub login or an unsigned Dependabot commit holds the merge", () => {
  const spoofed = { author: null, message: "fix" };
  assert.match(decideMerge(input({ commits: [MINOR_COMMIT, spoofed] })).reason, /unknown author/u);
  const unsigned = { ...MINOR_COMMIT, verified: false };
  assert.match(decideMerge(input({ commits: [unsigned] })).reason, /verified signature/u);
});

const REPAIR_COMMIT = {
  author: "fallow-dependabot[bot]",
  committer: "web-flow",
  verified: true,
  parents: 1,
  message: "fix: repair",
};
const APP_MERGE = {
  author: "fallow-dependabot[bot]",
  committer: "web-flow",
  verified: true,
  parents: 2,
  message: "Merge branch 'main'",
};
const APP = { appLogin: "fallow-dependabot[bot]" };

test("a repaired pull request behind the base branch is brought up to date before it merges", () => {
  const commits = [MINOR_COMMIT, REPAIR_COMMIT];
  const behind = decideMerge(input({ commits, behindBy: 2 }), APP);
  assert.equal(behind.merge, false);
  assert.equal(behind.sync, true);
  const current = decideMerge(input({ commits, behindBy: 0 }), APP);
  assert.deepEqual([current.merge, current.edited], [true, true]);
});

test("a Dependabot-only pull request behind the base branch merges without an update", () => {
  const result = decideMerge(input({ behindBy: 3 }), APP);
  assert.equal(result.merge, true);
  assert.equal(result.sync, false);
});

test("a repaired pull request in conflict is synced, a Dependabot-only one is left to Dependabot", () => {
  const dirty = { number: 7, headSha: HEAD, labels: [], mergeableState: "dirty" };
  const repaired = decideMerge(input({ pr: dirty, commits: [MINOR_COMMIT, REPAIR_COMMIT] }), APP);
  assert.deepEqual([repaired.merge, repaired.sync], [false, true]);
  const own = decideMerge(input({ pr: dirty }), APP);
  assert.deepEqual([own.merge, own.sync], [false, false]);
});

test("commits of the App count as automation only for the App that the caller names", () => {
  const commits = [MINOR_COMMIT, APP_MERGE, REPAIR_COMMIT];
  assert.equal(decideMerge(input({ commits }), APP).merge, true);
  const other = { appLogin: "other-app[bot]" };
  assert.match(decideMerge(input({ commits }), other).reason, /fallow-dependabot\[bot\] has pushed/u);
});

test("a branch with only a merge of the base is synced too, so it never sticks", () => {
  const dirty = { number: 7, headSha: HEAD, labels: [], mergeableState: "dirty" };
  const result = decideMerge(input({ pr: dirty, commits: [MINOR_COMMIT, APP_MERGE] }), APP);
  assert.deepEqual([result.merge, result.sync], [false, true]);
});

test("a repair commit that a person pushed, or an unsigned App commit, holds the merge", () => {
  const applied = { author: "claude[bot]", committer: "BartWaardenburg", verified: false, message: "fix" };
  assert.match(decideMerge(input({ commits: [MINOR_COMMIT, applied] }), APP).reason, /has pushed/u);
  const forged = { ...APP_MERGE, verified: false };
  assert.match(decideMerge(input({ commits: [MINOR_COMMIT, forged] }), APP).reason, /has pushed/u);
});

test("the squash subject keeps the title and number when it fits", () => {
  assert.equal(squashSubject("chore(deps): bump a from 1.0.0 to 1.1.0", 7), "chore(deps): bump a from 1.0.0 to 1.1.0 (#7)");
});

test("a squash subject over 100 characters drops the directory of the update", () => {
  const title =
    "chore(deps-dev): bump follow-redirects from 1.16.0 to 1.16.1 in /tools/type-aware-sidecar/fixtures/app";
  assert.equal(
    squashSubject(title, 3726),
    "chore(deps-dev): bump follow-redirects from 1.16.0 to 1.16.1 (#3726)",
  );
  const long = `chore(deps): bump the ${"x".repeat(90)} group`;
  assert.equal(squashSubject(long, 1).length, 100);
  assert.match(squashSubject(long, 1), /\.\.\. \(#1\)$/u);
});
