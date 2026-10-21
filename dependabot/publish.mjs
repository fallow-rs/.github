// Publishes the checked repair commit for the reusable dependabot.yml workflow.
// The guard checked the local commit HEAD on top of BEFORE. This script sends
// the same file changes through the GraphQL createCommitOnBranch mutation with
// the App token, so GitHub creates the commit, signs it and names the App as
// its author. `expectedHeadOid` makes the commit fail when the branch moved.
//
// The API cannot set a file mode, so a repair that changes a mode or adds an
// executable file is refused. After the commit, the script compares its tree
// with the checked tree. On a difference it moves the branch back and fails.
//
// Run: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo BRANCH=dependabot/... \
//   BEFORE=<sha> node dependabot/publish.mjs

import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Actions sets GITHUB_API_URL and GITHUB_GRAPHQL_URL. The tests point them at a
// local server.
const API = process.env.GITHUB_API_URL || "https://api.github.com";
const GRAPHQL = process.env.GITHUB_GRAPHQL_URL || `${API}/graphql`;
const REQUIRED_ENV = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "BRANCH", "BEFORE"];
const REGULAR_FILE = "100644";
const DELETED = "000000";

const git = (args, { cwd, encoding = "utf8" } = {}) =>
  execFileSync("git", args, { cwd, encoding, maxBuffer: 512 * 1024 * 1024 });

/**
 * Lists the changes from `before` to HEAD in the form of createCommitOnBranch.
 * @param {string} before
 * @param {{ cwd?: string }} [options]
 * @returns {{ additions: { path: string, contents: string }[], deletions: { path: string }[] }}
 */
export const fileChanges = (before, { cwd } = {}) => {
  const fields = git(["diff", "--raw", "-z", "--no-renames", before, "HEAD"], { cwd }).split("\0");
  const additions = [];
  const deletions = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode] = fields[index].slice(1).split(" ");
    const path = fields[index + 1];
    if (newMode === DELETED) {
      deletions.push({ path });
      continue;
    }
    if (newMode !== REGULAR_FILE || (oldMode !== DELETED && oldMode !== newMode)) {
      throw new Error(`${path} changes its file mode to ${newMode}, which a signed commit cannot keep`);
    }
    const contents = git(["show", `HEAD:${path}`], { cwd, encoding: "buffer" }).toString("base64");
    additions.push({ path, contents });
  }
  return { additions, deletions };
};

const request = async (method, url, token, body) => {
  const response = await fetch(url.startsWith("http") ? url : `${API}${url}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status >= 300) throw new Error(`${method} ${url}: HTTP ${response.status} ${data.message ?? ""}`.trim());
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data;
};

const CREATE = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

const RESET = `mutation($repo: ID!, $name: GitRefname!, $before: GitObjectID!, $after: GitObjectID!) {
  updateRefs(input: { repositoryId: $repo, refUpdates: [{ name: $name, beforeOid: $before, afterOid: $after, force: true }] }) {
    clientMutationId
  }
}`;

const main = async () => {
  const env = process.env;
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment: ${missing.join(", ")}`);
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, BRANCH: branch, BEFORE: before } = env;

  const changes = fileChanges(before);
  const message = git(["log", "-1", "--format=%B"]).trim();
  const [headline, ...rest] = message.split("\n");
  const body = rest.join("\n").trim();
  const created = await request("POST", GRAPHQL, token, {
    query: CREATE,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repo, branchName: branch },
        message: { headline, ...(body ? { body } : {}) },
        expectedHeadOid: before,
        fileChanges: changes,
      },
    },
  });
  const oid = created.data.createCommitOnBranch.commit.oid;

  const checked = git(["rev-parse", "HEAD^{tree}"]).trim();
  const commit = await request("GET", `/repos/${repo}/git/commits/${oid}`, token);
  if (commit.tree.sha !== checked) {
    const { node_id: repoId } = await request("GET", `/repos/${repo}`, token);
    await request("POST", GRAPHQL, token, {
      query: RESET,
      variables: { repo: repoId, name: `refs/heads/${branch}`, before: oid, after: before },
    });
    throw new Error(`the signed commit ${oid} has tree ${commit.tree.sha}, but the checked tree differs (${checked}); moved the branch back`);
  }
  console.log(`published the signed commit ${oid}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
