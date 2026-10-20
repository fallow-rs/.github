// Tests for merge.mjs, the merge decision in the reusable dependabot.yml
// workflow.
//
// Run: node --test dependabot/merge.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decideMerge, updateTypes } from "./merge.mjs";

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
  assert.deepEqual(decideMerge(input()), { merge: true, reason: "every check passed" });
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

test("a repair commit by claude[bot] keeps the merge", () => {
  const commits = [MINOR_COMMIT, { author: "claude[bot]", message: "chore(deps): fix the pin" }];
  assert.equal(decideMerge(input({ commits })).merge, true);
});

test("a major update or an update without metadata does not merge", () => {
  const major = {
    ...MINOR_COMMIT,
    message: MINOR_COMMIT.message.replace("semver-minor", "semver-major"),
  };
  assert.match(decideMerge(input({ commits: [major] })).reason, /major/u);
  const plain = { author: "dependabot[bot]", message: "chore(deps): bump a" };
  assert.match(decideMerge(input({ commits: [plain] })).reason, /update type/u);
});

test("a group with one major update does not merge", () => {
  const group = {
    author: "dependabot[bot]",
    message:
      "chore(deps): bump the x group with 2 updates\n\n---\nupdated-dependencies:\n- dependency-name: a\n  update-type: version-update:semver-patch\n- dependency-name: b\n  update-type: version-update:semver-major\n...\n",
  };
  assert.deepEqual(updateTypes(group.message), ["patch", "major"]);
  assert.equal(decideMerge(input({ commits: [group] })).merge, false);
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
