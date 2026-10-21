// Tests for sync.mjs, which brings a Dependabot pull request up to date with
// its base branch.
//
// Run: node --test dependabot/sync.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resetTarget } from "./sync.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./sync.mjs", import.meta.url));
const APP = "fallow-dependabot[bot]";
const commit = (sha, author) => ({ sha, author });

test("the reset target is the newest Dependabot commit when only automation follows it", () => {
  const commits = [
    commit("d1", "dependabot[bot]"),
    commit("m1", APP),
    commit("r1", "claude[bot]"),
  ];
  assert.equal(resetTarget(commits, APP), "d1");
});

test("a branch that ends with its Dependabot commit needs no reset", () => {
  assert.equal(resetTarget([commit("d1", "dependabot[bot]")], APP), null);
});

test("a commit from a person after the Dependabot commit blocks the reset", () => {
  const commits = [commit("d1", "dependabot[bot]"), commit("p1", "someone"), commit("r1", "claude[bot]")];
  assert.equal(resetTarget(commits, APP), null);
});

test("a branch without a Dependabot commit has no reset target", () => {
  assert.equal(resetTarget([commit("r1", "claude[bot]")], APP), null);
});

test("the script started as a process checks its environment before any request", () => {
  const run = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /missing environment: GITHUB_TOKEN/u);
});

/**
 * Runs sync.mjs against a local stand-in for the GitHub API.
 * @param {(method: string, path: string, body: unknown) => { status: number, body?: unknown }} handle
 */
const runAgainst = async (handle) => {
  const { createServer } = await import("node:http");
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push(`${req.method} ${req.url}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`);
      const reply = handle(req.method, req.url, body);
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [SCRIPT_PATH], {
    env: {
      PATH: process.env.PATH,
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      PR: "7",
      APP_LOGIN: APP,
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  server.close();
  return { status, stdout, calls };
};

const pull = (sha, state = "dirty") => ({
  state: "open",
  user: { login: "dependabot[bot]" },
  head: { sha, ref: "dependabot/npm/x" },
  base: { ref: "main" },
  mergeable_state: state,
});

test("a conflict drops the repair commits, then merges the base branch", async () => {
  let head = "r1";
  const result = await runAgainst((method, path, body) => {
    if (method === "GET" && path === "/repos/o/r/pulls/7") return { status: 200, body: pull(head) };
    if (method === "PUT" && path === "/repos/o/r/pulls/7/update-branch") {
      return body.expected_head_sha === "d1" ? { status: 202 } : { status: 422 };
    }
    if (method === "GET" && path.startsWith("/repos/o/r/compare/")) return { status: 200, body: { behind_by: 2 } };
    if (method === "GET" && path.startsWith("/repos/o/r/pulls/7/commits")) {
      return {
        status: 200,
        body: [
          { sha: "d1", author: { login: "dependabot[bot]" } },
          { sha: "r1", author: { login: "claude[bot]" } },
        ],
      };
    }
    if (method === "PATCH" && path === "/repos/o/r/git/refs/heads/dependabot%2Fnpm%2Fx") {
      head = body.sha;
      return { status: 200 };
    }
    return { status: 404 };
  });
  assert.equal(result.status, 0, result.stdout);
  assert.ok(result.calls.includes('PATCH /repos/o/r/git/refs/heads/dependabot%2Fnpm%2Fx {"sha":"d1","force":true}'));
  assert.ok(result.calls.includes('PUT /repos/o/r/pulls/7/update-branch {"expected_head_sha":"d1"}'));
  assert.match(result.stdout, /merged the base branch/u);
});

test("an up-to-date branch is left alone, and a refusal that is no conflict fails the step", async () => {
  const handler = (behind, state) => (method, path) => {
    if (method === "GET" && path === "/repos/o/r/pulls/7") return { status: 200, body: pull("r1", state) };
    if (method === "PUT") return { status: 422, body: { message: "whatever" } };
    if (method === "GET" && path.startsWith("/repos/o/r/compare/")) return { status: 200, body: { behind_by: behind } };
    return { status: 404 };
  };
  const current = await runAgainst(handler(0, "clean"));
  assert.equal(current.status, 0);
  assert.match(current.stdout, /already up to date/u);
  assert.ok(!current.calls.some((call) => call.startsWith("PATCH")));
  const refused = await runAgainst(handler(3, "blocked"));
  assert.equal(refused.status, 1);
  assert.ok(!refused.calls.some((call) => call.startsWith("PATCH")));
});
