// Tests for publish.mjs, which turns the checked repair commit into a commit
// that GitHub signs for the App.
//
// Run: node --test dependabot/publish.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fileChanges } from "./publish.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./publish.mjs", import.meta.url));

/** A repository with a base commit and a repair commit on top. */
const repository = (repair) => {
  const dir = mkdtempSync(join(tmpdir(), "repair-publish-"));
  const git = (...args) => {
    const run = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "keep.txt"), "keep\n");
  writeFileSync(join(dir, "old.txt"), "old\n");
  writeFileSync(join(dir, "package-lock.json"), '{ "v": 1 }\n');
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const before = git("rev-parse", "HEAD");
  repair(dir, git);
  git("add", "-A");
  git("commit", "--quiet", "-m", "fix: repair the lockfile\n\nThe body explains why.");
  return { dir, before, tree: git("rev-parse", "HEAD^{tree}"), git };
};

const standardRepair = (dir) => {
  writeFileSync(join(dir, "package-lock.json"), '{ "v": 2 }\n');
  writeFileSync(join(dir, "new dir file.txt"), "new\n");
  rmSync(join(dir, "old.txt"));
};

test("the file changes name every addition with its content and every deletion", () => {
  const repo = repository(standardRepair);
  const changes = fileChanges(repo.before, { cwd: repo.dir });
  assert.deepEqual(changes.deletions, [{ path: "old.txt" }]);
  const additions = Object.fromEntries(
    changes.additions.map((item) => [item.path, Buffer.from(item.contents, "base64").toString()]),
  );
  assert.deepEqual(additions, { "new dir file.txt": "new\n", "package-lock.json": '{ "v": 2 }\n' });
});

test("a mode change or an executable new file is refused, because the API cannot keep it", () => {
  const changed = repository((dir) => chmodSync(join(dir, "keep.txt"), 0o755));
  assert.throws(() => fileChanges(changed.before, { cwd: changed.dir }), /keep\.txt changes its file mode/u);
  const added = repository((dir) => {
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(dir, "run.sh"), 0o755);
  });
  assert.throws(() => fileChanges(added.before, { cwd: added.dir }), /run\.sh changes its file mode/u);
});

/** Runs publish.mjs in `dir` against a stand-in for the GitHub API. */
const runAgainst = async (dir, before, handle) => {
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
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      BRANCH: "dependabot/npm/x",
      BEFORE: before,
      GITHUB_API_URL: url,
      GITHUB_GRAPHQL_URL: `${url}/graphql`,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  server.close();
  return { status, output, calls };
};

const api = (tree) => (method, path, body) => {
  if (method === "GET" && path === "/repos/o/r") return { status: 200, body: { node_id: "R_1" } };
  if (method === "POST" && path === "/graphql" && body.query.includes("createCommitOnBranch")) {
    return { status: 200, body: { data: { createCommitOnBranch: { commit: { oid: "signed1" } } } } };
  }
  if (method === "GET" && path === "/repos/o/r/git/commits/signed1") {
    return { status: 200, body: { tree: { sha: tree }, verification: { verified: true } } };
  }
  if (method === "POST" && path === "/graphql" && body.query.includes("updateRefs")) {
    return { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
  }
  return { status: 404 };
};

test("the repair becomes one signed commit on top of the checked head", async () => {
  const repo = repository(standardRepair);
  const result = await runAgainst(repo.dir, repo.before, api(repo.tree));
  assert.equal(result.status, 0, result.output);
  const create = result.calls.find((call) => call.body?.query?.includes("createCommitOnBranch"));
  const input = create.body.variables.input;
  assert.deepEqual(input.branch, { repositoryNameWithOwner: "o/r", branchName: "dependabot/npm/x" });
  assert.equal(input.expectedHeadOid, repo.before);
  assert.deepEqual(input.message, { headline: "fix: repair the lockfile", body: "The body explains why." });
  assert.equal(input.fileChanges.deletions.length, 1);
  assert.ok(!result.calls.some((call) => call.body?.query?.includes("updateRefs")));
  assert.match(result.output, /signed1/u);
});

test("a signed commit with another tree is rolled back and fails the step", async () => {
  const repo = repository(standardRepair);
  const result = await runAgainst(repo.dir, repo.before, api("0".repeat(40)));
  assert.equal(result.status, 1);
  const rollback = result.calls.find((call) => call.body?.query?.includes("updateRefs"));
  assert.deepEqual(rollback.body.variables, {
    repo: "R_1",
    name: "refs/heads/dependabot/npm/x",
    before: "signed1",
    after: repo.before,
  });
  assert.match(result.output, /tree differs/u);
});

test("a refused commit, such as a moved head, fails the step without a rollback", async () => {
  const repo = repository(standardRepair);
  const result = await runAgainst(repo.dir, repo.before, (method, path, body) =>
    body?.query?.includes("createCommitOnBranch")
      ? { status: 200, body: { errors: [{ message: "Expected branch to point to x" }] } }
      : api(repo.tree)(method, path, body),
  );
  assert.equal(result.status, 1);
  assert.match(result.output, /Expected branch to point/u);
  assert.ok(!result.calls.some((call) => call.body?.query?.includes("updateRefs")));
});
