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
// A commit from a person stops the reset. The run on the new head starts CI,
// and the triage or merge job decides again.
//
// The token must be an App token: a push with GITHUB_TOKEN starts no workflow.
// APP_LOGIN is the login of that App.
//
// Run: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR=7 \
//   APP_LOGIN=fallow-dependabot[bot] node dependabot/sync.mjs

import process from "node:process";
import { fileURLToPath } from "node:url";

const DEPENDABOT = "dependabot[bot]";
const REPAIR_BOT = "claude[bot]";
// Actions sets GITHUB_API_URL. The tests point it at a local server.
const API = process.env.GITHUB_API_URL || "https://api.github.com";
const REQUIRED_ENV = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR"];
const UNPROCESSABLE = 422;

/**
 * Finds the commit to reset a branch to: the newest Dependabot commit, when
 * only repair and App commits follow it.
 * @param {{ sha: string, author: string | null }[]} commits Oldest first.
 * @param {string} appLogin
 * @returns {string | null} The commit, or null when no reset is possible or needed.
 */
export const resetTarget = (commits, appLogin) => {
  const automation = new Set([REPAIR_BOT, ...(appLogin ? [appLogin] : [])]);
  const index = commits.findLastIndex((commit) => commit.author === DEPENDABOT);
  if (index === -1 || index === commits.length - 1) return null;
  const later = commits.slice(index + 1);
  return later.every((commit) => automation.has(commit.author)) ? commits[index].sha : null;
};

const request = async (method, path, token, body) => {
  const response = await fetch(`${API}${path}`, {
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
  const pull = expectOk(await request("GET", `/repos/${repo}/pulls/${number}`, token), "read the pull request");
  if (pull.head.sha !== headSha) throw new Error("the branch moved; the next run decides again");
  const comparison = expectOk(
    await request("GET", `/repos/${repo}/compare/${encodeURIComponent(pull.base.ref)}...${headSha}`, token),
    "compare the branch",
  );
  if (comparison.behind_by === 0) return "current";
  if (pull.mergeable_state === "dirty") return "conflict";
  return expectOk(result, "update the branch");
};

const main = async () => {
  const env = process.env;
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment: ${missing.join(", ")}`);
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const number = Number(env.PR);
  const pull = expectOk(await request("GET", `/repos/${repo}/pulls/${number}`, token), "read the pull request");
  if (pull.state !== "open" || pull.user?.login !== DEPENDABOT) {
    console.log(`#${number}: not an open Dependabot pull request`);
    return;
  }

  const first = await updateBranch(repo, number, pull.head.sha, token);
  if (first !== "conflict") {
    console.log(`#${number}: ${first === "updated" ? "merged the base branch" : "already up to date"}`);
    return;
  }

  const listed = expectOk(
    await request("GET", `/repos/${repo}/pulls/${number}/commits?per_page=100`, token),
    "list the commits",
  );
  // Only the GitHub login counts: a free-text git author name can claim to be
  // a bot. A commit without a login counts as a person.
  const commits = listed.map((commit) => ({ sha: commit.sha, author: commit.author?.login ?? null }));
  const target = resetTarget(commits, env.APP_LOGIN ?? "");
  if (target === null || commits.length >= 100) {
    console.log(`#${number}: in conflict, and only Dependabot or a person can resolve it`);
    return;
  }
  // The head must still be the one this run read, so a new push is never lost.
  const current = expectOk(await request("GET", `/repos/${repo}/pulls/${number}`, token), "read the pull request");
  if (current.head.sha !== pull.head.sha) {
    console.log(`#${number}: the branch moved; the next run decides again`);
    return;
  }
  const branch = encodeURIComponent(pull.head.ref);
  expectOk(
    await request("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, token, { sha: target, force: true }),
    "reset the branch",
  );
  console.log(`#${number}: dropped the commits after Dependabot commit ${target}`);
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
