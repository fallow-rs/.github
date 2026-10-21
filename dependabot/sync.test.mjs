// Tests for sync.mjs, which brings a Dependabot pull request up to date with
// its base branch.
//
// Run: node --test dependabot/sync.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resetTarget } from "./sync.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./sync.mjs", import.meta.url));
const APP = "fallow-dependabot[bot]";
const dependabot = (sha) => ({ sha, author: "dependabot[bot]", committer: "web-flow", verified: true });
const repair = (sha, committer = "claude[bot]") => ({ sha, author: "claude[bot]", committer });
const appMerge = (sha) => ({ sha, author: APP, committer: "web-flow", verified: true });

test("the reset target is the newest Dependabot commit when only automation follows it", () => {
  assert.equal(resetTarget([dependabot("d1"), appMerge("m1"), repair("r1")], APP), "d1");
});

test("a branch that ends with its Dependabot commit needs no reset", () => {
  assert.equal(resetTarget([dependabot("d1")], APP), null);
});

test("a commit from a person after the Dependabot commit blocks the reset", () => {
  const person = { sha: "p1", author: "someone", committer: "someone" };
  assert.equal(resetTarget([dependabot("d1"), person, repair("r1")], APP), null);
  // A maintainer who applied a repair patch keeps claude[bot] as the author.
  assert.equal(resetTarget([dependabot("d1"), repair("r1", "BartWaardenburg")], APP), null);
  const forged = { ...appMerge("m1"), verified: false };
  assert.equal(resetTarget([dependabot("d1"), forged], APP), null);
});

test("a branch without a Dependabot commit has no reset target", () => {
  assert.equal(resetTarget([repair("r1")], APP), null);
});

test("the script started as a process checks its environment before any request", () => {
  const run = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /missing environment: GITHUB_TOKEN/u);
});

/** Runs sync.mjs against a local stand-in for the GitHub REST and GraphQL APIs. */
const runAgainst = async (handle) => {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method, path: req.url, body });
      const reply = handle(req.method, req.url, body);
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [SCRIPT_PATH], {
    env: {
      PATH: process.env.PATH,
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      PR: "7",
      APP_LOGIN: APP,
      GITHUB_API_URL: url,
      GITHUB_GRAPHQL_URL: `${url}/graphql`,
      SYNC_POLL_DELAY_MS: "1",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  server.close();
  return { status, output, calls };
};

const pull = (sha, { mergeable = false, labels = [] } = {}) => ({
  state: "open",
  user: { login: "dependabot[bot]" },
  head: { sha, ref: "dependabot/npm/x" },
  base: { ref: "main", repo: { node_id: "R_1" } },
  mergeable,
  labels: labels.map((name) => ({ name })),
});

const toApi = (commit) => ({
  sha: commit.sha,
  author: { login: commit.author },
  committer: { login: commit.committer },
  commit: { verification: { verified: commit.verified ?? false }, message: "" },
});

/**
 * A repository stand-in. `head` moves on a reset. `lag` reads of the pull
 * request after the reset still show the old head, as GitHub can.
 */
const repository = ({ commits, lag = 0, firstMergeable = false }) => {
  const state = { head: commits.at(-1).sha, resetTo: null, reads: 0, lagLeft: lag };
  const handle = (method, path, body) => {
    if (method === "GET" && path === "/repos/o/r/pulls/7") {
      state.reads += 1;
      if (state.resetTo !== null && state.lagLeft > 0) {
        state.lagLeft -= 1;
        return { status: 200, body: pull(commits.at(-1).sha) };
      }
      // The first read after the failed update has no merge state yet.
      const mergeable = state.reads === 2 && firstMergeable === null ? null : false;
      return { status: 200, body: pull(state.head, { mergeable }) };
    }
    if (method === "PUT" && path === "/repos/o/r/pulls/7/update-branch") {
      return body.expected_head_sha === "d1" ? { status: 202 } : { status: 422 };
    }
    if (method === "GET" && path.startsWith("/repos/o/r/compare/main...")) {
      return { status: 200, body: { behind_by: 2 } };
    }
    if (method === "GET" && path.startsWith("/repos/o/r/pulls/7/commits")) {
      return { status: 200, body: commits.map(toApi) };
    }
    if (method === "POST" && path === "/graphql") {
      const update = body.variables;
      if (update.before !== state.head) return { status: 200, body: { errors: [{ message: "stale" }] } };
      state.head = update.after;
      state.resetTo = update.after;
      return { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
    }
    return { status: 404 };
  };
  return { state, handle };
};

test("a conflict drops the repair commits with a compare-and-swap, then merges the base", async () => {
  const repo = repository({ commits: [dependabot("d1"), appMerge("m1"), repair("r1")], lag: 2 });
  const result = await runAgainst(repo.handle);
  assert.equal(result.status, 0, result.output);
  const reset = result.calls.find((call) => call.path === "/graphql");
  assert.deepEqual(reset.body.variables, {
    repo: "R_1",
    name: "refs/heads/dependabot/npm/x",
    before: "r1",
    after: "d1",
  });
  const updates = result.calls.filter((call) => call.method === "PUT");
  assert.deepEqual(updates.map((call) => call.body.expected_head_sha), ["r1", "d1"]);
  assert.match(result.output, /merged the base branch/u);
});

test("an unknown merge state is read again before it counts as a conflict", async () => {
  const repo = repository({ commits: [dependabot("d1"), repair("r1")], firstMergeable: null });
  const result = await runAgainst(repo.handle);
  assert.equal(result.status, 0, result.output);
  assert.equal(repo.state.resetTo, "d1");
});

test("a person's commit on a branch in conflict is never reset", async () => {
  const person = { sha: "p1", author: "claude[bot]", committer: "BartWaardenburg" };
  const repo = repository({ commits: [dependabot("d1"), person] });
  const result = await runAgainst(repo.handle);
  assert.equal(result.status, 0, result.output);
  assert.equal(repo.state.resetTo, null);
  assert.ok(!result.calls.some((call) => call.path === "/graphql"));
  assert.match(result.output, /only Dependabot or a person can resolve it/u);
});

test("a hold label stops the update", async () => {
  const result = await runAgainst((method, path) =>
    method === "GET" && path === "/repos/o/r/pulls/7"
      ? { status: 200, body: pull("r1", { labels: ["needs-review"] }) }
      : { status: 404 },
  );
  assert.equal(result.status, 0, result.output);
  assert.ok(!result.calls.some((call) => call.method === "PUT"));
  assert.match(result.output, /needs-review label is set/u);
});

test("an up-to-date branch is left alone, and a refusal that is no conflict fails the step", async () => {
  const handler = (behind, mergeable) => (method, path) => {
    if (method === "GET" && path === "/repos/o/r/pulls/7") return { status: 200, body: pull("r1", { mergeable }) };
    if (method === "PUT") return { status: 422, body: { message: "whatever" } };
    if (method === "GET" && path.startsWith("/repos/o/r/compare/")) return { status: 200, body: { behind_by: behind } };
    return { status: 404 };
  };
  const current = await runAgainst(handler(0, true));
  assert.equal(current.status, 0, current.output);
  assert.match(current.output, /already up to date/u);
  const refused = await runAgainst(handler(3, true));
  assert.equal(refused.status, 1);
  assert.ok(!refused.calls.some((call) => call.path === "/graphql"));
});

test("a head that moved before the reset fails the compare-and-swap", async () => {
  const repo = repository({ commits: [dependabot("d1"), repair("r1")] });
  const handle = (method, path, body) => {
    if (method === "POST" && path === "/graphql") repo.state.head = "r2";
    return repo.handle(method, path, body);
  };
  const result = await runAgainst(handle);
  assert.equal(result.status, 1);
  assert.match(result.output, /reset the branch: stale/u);
  assert.equal(repo.state.resetTo, null);
});
