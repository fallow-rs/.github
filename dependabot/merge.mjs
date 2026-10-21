// Decides if the reusable dependabot.yml workflow merges a Dependabot pull
// request after one of its runs succeeded. It does not rely on branch
// protection, because several repositories have no required checks.
//
// A pull request merges only when all of these hold:
// - the run is for the current head commit,
// - it has no `needs-review` or `needs-human` label,
// - every commit is from Dependabot or the repair workflow,
// - a Dependabot commit carries the dependency metadata,
// - every workflow run and check on the head commit is complete and passed,
//   and at least one check ran. A workflow run exists as soon as the push
//   starts it, before its check runs do, so a slow workflow holds the merge,
// - it has no merge conflict,
// - when it has a repair commit, it is up to date with its base branch. Two
//   repairs can raise the same version or build the same output, so a
//   repaired pull request merges only on top of the current base.
//
// A repaired pull request that is behind or in conflict gets `sync`: sync.mjs
// brings it up to date, and the run on the new head decides again.
//
// APP_LOGIN is the login of the App that merges main into a branch, such as
// `fallow-dependabot[bot]`. Its merge commits count as automation.
//
// IGNORE_CHECKS is an optional regular expression on check names, for a check
// that fails without a code cause, such as a benchmark comparison.
//
// The CLI writes `merge` and `sync` (true or false), `pr` and `reason` to
// GITHUB_OUTPUT. With SWEEP=1 it checks every open Dependabot pull request
// instead, and writes `prs`: a JSON list of { number, sha } to merge, and
// `syncs`: a JSON list of pull request numbers to bring up to date. A merge
// moves the base, so the sweep merges a repaired pull request only as the first
// merge of the run. The sweep catches a pull
// request whose last check came from an app, not from a workflow run.
//
// Run: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo HEAD_BRANCH=dependabot/... \
//   RUN_HEAD_SHA=... node dependabot/merge.mjs
//      GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo SWEEP=1 node dependabot/merge.mjs

import { appendFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEPENDABOT = "dependabot[bot]";
const NO_MATCH = /(?!)/u;
// Runs that test the pull request. A pull_request_target run is automation
// such as a labeler or an older auto-merge workflow. A workflow_run, schedule
// or Dependabot ("dynamic") run is not a check of the head commit, and this
// workflow's own run must not wait on itself.
const CHECKED_EVENTS = new Set(["pull_request", "push"]);
const REPAIR_BOT = "claude[bot]";
const AUTOMATION_AUTHORS = new Set([DEPENDABOT, REPAIR_BOT]);
const HOLD_LABELS = ["needs-review", "needs-human"];
const PASSED = new Set(["success", "neutral", "skipped"]);
const DEPENDENCY_METADATA = /^updated-dependencies:\n- dependency-name: \S/mu;
const UPDATE_TYPE = /update-type: version-update:semver-(major|minor|patch)/gu;
const API = "https://api.github.com";
const REQUIRED_ENV = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_OUTPUT"];
const RUN_ENV = ["HEAD_BRANCH", "RUN_HEAD_SHA"];

/**
 * Reads the update types from the metadata that Dependabot writes into its
 * commit message.
 * @param {string} message
 * @returns {("major" | "minor" | "patch")[]}
 */
export const updateTypes = (message) =>
  Array.from(message.matchAll(UPDATE_TYPE), (match) => match[1]);

/**
 * @param {{
 *   pr: { number: number, headSha: string, labels: string[], mergeableState: string } | null,
 *   runHeadSha: string,
 *   commits: { author: string, message: string }[],
 *   checkRuns: { name: string, status: string, conclusion: string | null }[],
 *   workflowRuns?: { name: string, status: string, conclusion: string | null }[],
 *   combinedStatus: { state: string, total: number },
 *   complete?: boolean,
 * }} input
 * @param {{ ignoreCheck?: RegExp, appLogin?: string }} [options]
 * @returns {{ merge: boolean, reason: string, sync: boolean, repaired?: boolean }}
 */
export const decideMerge = (
  {
    pr,
    runHeadSha,
    commits,
    checkRuns,
    workflowRuns = [],
    combinedStatus,
    complete = true,
    behindBy = 0,
  },
  { ignoreCheck = NO_MATCH, appLogin = "" } = {},
) => {
  const hold = (reason) => ({ merge: false, reason, sync: false });
  const automation = new Set([...AUTOMATION_AUTHORS, ...(appLogin ? [appLogin] : [])]);
  if (pr === null) return hold("no open Dependabot pull request for this branch");
  if (pr.headSha !== runHeadSha) return hold("the run is for an older head commit");

  const label = HOLD_LABELS.find((name) => pr.labels.includes(name));
  if (label) return hold(`the ${label} label is set`);

  if (!complete) return hold("the pull request has more commits or checks than one page holds");
  const person = commits.find((commit) => !automation.has(commit.author));
  if (person) return hold(`${person.author ?? "an unknown author"} has pushed to this branch`);
  const unsigned = commits.find(
    (commit) => commit.author === DEPENDABOT && commit.verified === false,
  );
  if (unsigned) return hold("a Dependabot commit has no verified signature");

  // Every update merges when CI passes, majors included. A SHA-only update has
  // no update type, so the metadata block itself is the requirement.
  const described = commits.some(
    (commit) => commit.author === DEPENDABOT && DEPENDENCY_METADATA.test(commit.message),
  );
  if (!described) return hold("the commit has no Dependabot metadata");

  const repaired = commits.some((commit) => commit.author === REPAIR_BOT);
  if (repaired && (pr.mergeableState === "dirty" || behindBy > 0)) {
    const state = pr.mergeableState === "dirty" ? "in conflict" : `${behindBy} commits behind`;
    return { merge: false, reason: `the repaired branch is ${state}`, sync: true };
  }

  const runs = workflowRuns.filter((run) => !ignoreCheck.test(run.name));
  const openRun = runs.find((run) => run.status !== "completed");
  if (openRun) return hold(`the ${openRun.name} workflow is still running`);
  const failedRun = runs.find((run) => !PASSED.has(run.conclusion));
  if (failedRun) return hold(`the ${failedRun.name} workflow ended with ${failedRun.conclusion}`);
  const counted = checkRuns.filter((run) => !ignoreCheck.test(run.name));
  if (counted.length === 0) return hold("no check ran on the head commit");
  const open = counted.find((run) => run.status !== "completed");
  if (open) return hold(`${open.name} is still running`);
  const failed = counted.find((run) => !PASSED.has(run.conclusion));
  if (failed) return hold(`${failed.name} ended with ${failed.conclusion}`);
  if (combinedStatus.total > 0 && combinedStatus.state !== "success") {
    return hold(`the commit status is ${combinedStatus.state}`);
  }

  if (pr.mergeableState === "dirty") return hold("the pull request has a merge conflict");
  return { merge: true, reason: "every check passed", sync: false, repaired };
};

const githubJson = async (path, token) => {
  const response = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
};

const toPullRequest = (pull) => ({
  number: pull.number,
  headSha: pull.head.sha,
  headBranch: pull.head.ref,
  baseRef: pull.base.ref,
  labels: pull.labels.map((item) => item.name),
  mergeableState: pull.mergeable_state,
});

// The list endpoint leaves out the mergeable state, so each match is read again.
const readPullRequest = async (repo, number, token) =>
  toPullRequest(await githubJson(`/repos/${repo}/pulls/${number}`, token));

const openDependabotPulls = async (repo, query, token) => {
  const pulls = await githubJson(`/repos/${repo}/pulls?${query}`, token);
  return pulls.filter((candidate) => candidate.user?.login === DEPENDABOT);
};

const decideFor = async (repo, pr, sha, token, options) => {
  const [commits, checks, status, actionRuns, comparison] = pr
    ? await Promise.all([
        githubJson(`/repos/${repo}/pulls/${pr.number}/commits?per_page=100`, token),
        githubJson(`/repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`, token),
        githubJson(`/repos/${repo}/commits/${sha}/status`, token),
        githubJson(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, token),
        githubJson(`/repos/${repo}/compare/${encodeURIComponent(pr.baseRef)}...${sha}`, token),
      ])
    : [
        [],
        { check_runs: [], total_count: 0 },
        { state: "pending", total_count: 0 },
        { workflow_runs: [], total_count: 0 },
        { behind_by: 0 },
      ];
  // A rerun leaves the older attempt in the list, so only the newest run of
  // each workflow counts.
  const latestRuns = new Map();
  for (const run of actionRuns.workflow_runs.filter((item) => CHECKED_EVENTS.has(item.event))) {
    const seen = latestRuns.get(run.workflow_id);
    if (!seen || run.run_number > seen.run_number || run.run_attempt > seen.run_attempt) {
      latestRuns.set(run.workflow_id, run);
    }
  }
  return decideMerge(
    {
      pr,
      runHeadSha: sha,
      // Only the GitHub login counts: a free-text git author name can claim to
      // be a bot. A commit without a login counts as a person.
      commits: commits.map((commit) => ({
        author: commit.author?.login ?? null,
        message: commit.commit.message,
        verified: commit.commit.verification?.verified ?? false,
      })),
      workflowRuns: [...latestRuns.values()].map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
      })),
      complete:
        commits.length < 100 &&
        checks.check_runs.length === checks.total_count &&
        actionRuns.workflow_runs.length === actionRuns.total_count,
      checkRuns: checks.check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
      })),
      combinedStatus: { state: status.state, total: status.total_count },
      behindBy: comparison.behind_by,
    },
    options,
  );
};

const oneLine = (value) => String(value).replace(/[\r\n]+/gu, " ");

const writeOutputs = (file, outputs) => {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${oneLine(value)}\n`);
  appendFileSync(file, lines.join(""));
};

const runOne = async (env, options) => {
  const missing = RUN_ENV.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment: ${missing.join(", ")}`);
  const repo = env.GITHUB_REPOSITORY;
  const owner = repo.split("/")[0];
  const query = new URLSearchParams({ head: `${owner}:${env.HEAD_BRANCH}`, state: "open" });
  const [match] = await openDependabotPulls(repo, query, env.GITHUB_TOKEN);
  const pr = match ? await readPullRequest(repo, match.number, env.GITHUB_TOKEN) : null;
  const decision = await decideFor(repo, pr, env.RUN_HEAD_SHA, env.GITHUB_TOKEN, options);
  console.log(`${decision.merge ? "merge" : decision.sync ? "sync" : "hold"}: ${decision.reason}`);
  writeOutputs(env.GITHUB_OUTPUT, {
    merge: decision.merge,
    sync: decision.sync,
    repaired: decision.repaired ?? false,
    pr: pr?.number ?? "",
    reason: decision.reason,
  });
};

const sweep = async (env, options) => {
  const repo = env.GITHUB_REPOSITORY;
  const query = new URLSearchParams({ state: "open", per_page: "100" });
  const ready = [];
  const syncs = [];
  for (const match of await openDependabotPulls(repo, query, env.GITHUB_TOKEN)) {
    const pr = await readPullRequest(repo, match.number, env.GITHUB_TOKEN);
    const decision = await decideFor(repo, pr, pr.headSha, env.GITHUB_TOKEN, options);
    const verb = decision.merge ? "merge" : decision.sync ? "sync" : "hold";
    console.log(`#${pr.number} ${verb}: ${decision.reason}`);
    if (decision.merge) {
      ready.push({ number: pr.number, sha: pr.headSha, repaired: decision.repaired });
    }
    if (decision.sync) syncs.push(pr.number);
  }
  // A repaired pull request must be on top of the current base. Every merge
  // moves the base, so a repaired one goes first, and only as the first merge.
  ready.sort((a, b) => Number(b.repaired) - Number(a.repaired));
  writeOutputs(env.GITHUB_OUTPUT, { prs: JSON.stringify(ready), syncs: JSON.stringify(syncs) });
};

const main = async () => {
  const env = process.env;
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment: ${missing.join(", ")}`);
  const options = {
    ignoreCheck: env.IGNORE_CHECKS ? new RegExp(env.IGNORE_CHECKS, "u") : NO_MATCH,
    appLogin: env.APP_LOGIN ?? "",
  };
  await (env.SWEEP === "1" ? sweep(env, options) : runOne(env, options));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
