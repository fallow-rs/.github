// Brings a Dependabot pull request up to date with its base branch, for the
// reusable dependabot.yml workflow. A repair then builds on the current base,
// so two repairs cannot raise the same version or build the same output.
//
// 1. It asks GitHub to merge the base branch into the pull request branch.
// 2. When that merge has a conflict, it drops the repair and merge commits
//    after the newest Dependabot commit, and tries the merge again. The
//    conflict then comes from Dependabot's own change, and Dependabot rebases
//    a branch that holds only its own commits.
//
// A hold label or a commit from a person stops it. The reset is a
// compare-and-swap on the head that this run read, so a new push is never
// lost. The push starts CI, and the triage or merge job decides again.
//
// The token must be an App token: a push with GITHUB_TOKEN starts no workflow.
// APP_LOGIN is the login of that App.
//
// Run: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR=7 \
//   APP_LOGIN=fallow-dependabot[bot] node dependabot/sync.mjs

import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_APP_LOGIN, DEPENDABOT, HOLD_LABELS, isAutomationCommit, toCommit } from "./identity.mjs";

// Actions sets GITHUB_API_URL and GITHUB_GRAPHQL_URL. The tests point them at a
// local server.
const API = process.env.GITHUB_API_URL || "https://api.github.com";
const GRAPHQL = process.env.GITHUB_GRAPHQL_URL || `${API}/graphql`;
const REQUIRED_ENV = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR"];
const UNPROCESSABLE = 422;
const MAX_COMMITS = 100;
// GitHub computes the merge state and moves the head after a push with a
// delay. The script waits for them at most POLL_ATTEMPTS times.
const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = Number(process.env.SYNC_POLL_DELAY_MS ?? 3000);

/**
 * Finds the commit to reset a branch to: the newest Dependabot commit, when
 * only automation commits follow it.
 * @param {{ sha: string, author: string | null, committer?: string | null, verified?: boolean }[]} commits
 *   Oldest first.
 * @param {string} appLogin
 * @returns {string | null} The commit, or null when no reset is possible or needed.
 */
export const resetTarget = (commits, appLogin) => {
  const index = commits.findLastIndex((commit) => commit.author === DEPENDABOT);
  if (index === -1 || index === commits.length - 1) return null;
  const later = commits.slice(index + 1);
  return later.every((commit) => isAutomationCommit(commit, appLogin)) ? commits[index].sha : null;
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
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  return { status: response.status, data };
};

const expectOk = ({ status, data }, what) => {
  if (status >= 300) throw new Error(`${what}: HTTP ${status} ${data.message ?? ""}`.trim());
  return data;
};

/** Reads the pull request, and waits while GitHub still computes its merge state. */
const readPull = async (repo, number, token, { headSha } = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    const pull = expectOk(await request("GET", `/repos/${repo}/pulls/${number}`, token), "read the pull request");
    const settled = pull.mergeable !== null && (headSha === undefined || pull.head.sha === headSha);
    if (settled || attempt === POLL_ATTEMPTS) return pull;
    await sleep(POLL_DELAY_MS);
  }
};

/**
 * Asks GitHub to merge the base branch into the pull request branch.
 * @returns {Promise<"updated" | "current" | "conflict">}
 */
const updateBranch = async (repo, number, headSha, token) => {
  const result = await request("PUT", `/repos/${repo}/pulls/${number}/update-branch`, token, {
    expected_head_sha: headSha,
  });
  if (result.status < 300) return "updated";
  if (result.status !== UNPROCESSABLE) return expectOk(result, "update the branch");
  // A 422 means up to date, in conflict or a moved head. The state tells
  // which, so this does not depend on the wording of the error message.
  const pull = await readPull(repo, number, token);
  if (pull.head.sha !== headSha) throw new Error("the branch moved; the next run decides again");
  const comparison = expectOk(
    await request("GET", `/repos/${repo}/compare/${encodeURIComponent(pull.base.ref)}...${headSha}`, token),
    "compare the branch",
  );
  if (comparison.behind_by === 0) return "current";
  if (pull.mergeable === false) return "conflict";
  return expectOk(result, "update the branch");
};

/** Moves the branch from `before` to `after`, and fails when the branch is no longer at `before`. */
const resetBranch = async (pull, before, after, token) => {
  const query = `mutation($repo: ID!, $name: GitRefname!, $before: GitObjectID!, $after: GitObjectID!) {
    updateRefs(input: { repositoryId: $repo, refUpdates: [{ name: $name, beforeOid: $before, afterOid: $after, force: true }] }) {
      clientMutationId
    }
  }`;
  const variables = {
    repo: pull.base.repo.node_id,
    name: `refs/heads/${pull.head.ref}`,
    before,
    after,
  };
  const result = expectOk(await request("POST", GRAPHQL, token, { query, variables }), "reset the branch");
  if (result.errors?.length) throw new Error(`reset the branch: ${result.errors[0].message}`);
};

const main = async () => {
  const env = process.env;
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment: ${missing.join(", ")}`);
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const appLogin = env.APP_LOGIN || DEFAULT_APP_LOGIN;
  const number = Number(env.PR);
  const pull = await readPull(repo, number, token);
  if (pull.state !== "open" || pull.user?.login !== DEPENDABOT) {
    console.log(`#${number}: not an open Dependabot pull request`);
    return;
  }
  const label = HOLD_LABELS.find((name) => pull.labels.some((item) => item.name === name));
  if (label) {
    console.log(`#${number}: the ${label} label is set`);
    return;
  }

  const first = await updateBranch(repo, number, pull.head.sha, token);
  if (first !== "conflict") {
    console.log(`#${number}: ${first === "updated" ? "merged the base branch" : "already up to date"}`);
    return;
  }

  const listed = expectOk(
    await request("GET", `/repos/${repo}/pulls/${number}/commits?per_page=${MAX_COMMITS}`, token),
    "list the commits",
  );
  const commits = listed.map(toCommit);
  const target = commits.length < MAX_COMMITS ? resetTarget(commits, appLogin) : null;
  if (target === null || commits.at(-1)?.sha !== pull.head.sha) {
    console.log(`#${number}: in conflict, and only Dependabot or a person can resolve it`);
    return;
  }
  await resetBranch(pull, pull.head.sha, target, token);
  console.log(`#${number}: dropped the commits after Dependabot commit ${target}`);
  const moved = await readPull(repo, number, token, { headSha: target });
  if (moved.head.sha !== target) {
    console.log(`#${number}: the reset is not visible yet; the next run decides again`);
    return;
  }
  const second = await updateBranch(repo, number, target, token);
  console.log(
    `#${number}: ${second === "conflict" ? "Dependabot's change is in conflict; Dependabot rebases it" : "merged the base branch"}`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
