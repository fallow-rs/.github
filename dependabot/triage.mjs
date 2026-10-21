// Decides what the reusable dependabot.yml workflow does after a failed run on
// a Dependabot pull request:
// - skip: nothing to do, or a person owns the branch now,
// - rerun: only cancelled jobs or one known flaky job failed,
// - sync: a job failed on a branch that is behind its base branch. sync.mjs
//   brings it up to date first, so a repair builds on the current base and
//   two repairs cannot raise the same version,
// - repair: a job failed for a reason a companion commit can fix,
// - give-up: the repair limit is reached, so a maintainer must look.
//
// The CLI writes `action`, `reason`, `pr`, `failed_jobs` and `update_size` to
// GITHUB_OUTPUT,
// and an excerpt of each failed job log to LOG_FILE for the repair step.
// IGNORE_JOBS and FLAKY_JOBS are optional regular expressions on job names:
// an aggregator job that only repeats other results, and a job that can fail
// without a code cause. APP_LOGIN is the login of the App that signs the
// repair commits and the merges of the base branch.
//
// Run: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo RUN_ID=1 RUN_ATTEMPT=1 \
//   HEAD_BRANCH=dependabot/... RUN_HEAD_SHA=... LOG_FILE=/tmp/failed.log \
//   node dependabot/triage.mjs

import { appendFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_APP_LOGIN,
  DEPENDABOT,
  HOLD_LABELS,
  isAutomationCommit,
  isRepairCommit,
  toCommit,
} from "./identity.mjs";

/** Repair commits allowed on one pull request before a maintainer takes over. */
export const MAX_REPAIRS = 2;

const NO_MATCH = /(?!)/u;
const VERSION_BUMP = /\bfrom v?(\d+)\.(\d+)\S* to v?(\d+)\.(\d+)/u;
const FAILED = new Set(["failure", "timed_out"]);
const MAX_RERUN_ATTEMPT = 2;
const ESCAPE = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "gu");
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /u;
const STEP_START = /^##\[group\]Run /u;
const STEP_ERROR = /^##\[error\]/u;
const FAILURE_LINE =
  /\bnot ok\b|##\[error\]|^error(?:\[E\d+\])?:|^Error:|^npm error|panicked at|\bFAILED\b|^\s*FAIL \[|--- STDERR:|AssertionError|ERR_[A-Z_]+|\u2716/u;
const SHORT_STEP_LINES = 400;
const CONTEXT_BEFORE = 5;
const CONTEXT_AFTER = 40;
const TAIL_LINES = 100;
const MAX_EXCERPT_LINES = 800;
const API = "https://api.github.com";

/**
 * Classifies a failed run on a Dependabot pull request.
 * @param {{
 *   pr: { number: number, headSha: string, labels: string[] } | null,
 *   runHeadSha: string,
 *   runAttempt: number,
 *   commits: { author: string }[],
 *   jobs: { name: string, conclusion: string | null }[],
 *   behindBy?: number,
 * }} input
 * @param {{ ignoreJob?: RegExp, flakyJob?: RegExp, appLogin?: string }} [options]
 * @returns {{ action: "skip" | "rerun" | "sync" | "repair" | "give-up", reason: string, failedJobs: string[] }}
 */
export const classify = (
  { pr, runHeadSha, runAttempt, commits, jobs, behindBy = 0 },
  { ignoreJob = NO_MATCH, flakyJob = NO_MATCH, appLogin = DEFAULT_APP_LOGIN } = {},
) => {
  const result = (action, reason, failedJobs = []) => ({ action, reason, failedJobs });
  if (pr === null) return result("skip", "no open Dependabot pull request for this branch");
  if (pr.headSha !== runHeadSha) return result("skip", "the run is for an older head commit");
  const label = HOLD_LABELS.find((name) => pr.labels.includes(name));
  if (label) return result("skip", `the ${label} label is set`);

  const person = commits.find((commit) => !isAutomationCommit(commit, appLogin));
  if (person) return result("skip", `${person.author ?? "an unknown author"} has pushed to this branch`);

  const counted = jobs.filter((job) => !ignoreJob.test(job.name));
  const failed = counted.filter((job) => FAILED.has(job.conclusion)).map((job) => job.name);
  const cancelled = counted.some((job) => job.conclusion === "cancelled");

  if (failed.length === 0) {
    if (cancelled && runAttempt <= MAX_RERUN_ATTEMPT) return result("rerun", "jobs were cancelled");
    return result("skip", "no job failed");
  }
  if (runAttempt === 1 && failed.every((name) => flakyJob.test(name))) {
    return result("rerun", "only a known flaky job failed", failed);
  }

  // A head that is already a merge of the base was just synced. Syncing again
  // on a busy base would never end, so the repair or the hand-off goes on.
  const head = commits.at(-1);
  const justSynced = head?.author === appLogin && head.parents === 2;
  if (behindBy > 0 && !justSynced) {
    return result("sync", `the branch is ${behindBy} commits behind its base branch`, failed);
  }
  const repairs = commits.filter((commit) => isRepairCommit(commit, appLogin)).length;
  if (repairs >= MAX_REPAIRS) {
    return result("give-up", `${repairs} repair commits did not make the run pass`, failed);
  }
  const noun = failed.length === 1 ? "job" : "jobs";
  return result("repair", `${failed.length} ${noun} failed`, failed);
};

/**
 * Reads the update size from a Dependabot title such as "bump x from 1.2.3 to
 * 1.3.0". Below 1.0.0 a minor bump counts as major, as in semver. A group
 * title names no versions, so its size is unknown.
 * @param {string} title
 * @returns {"major" | "minor-or-patch" | "unknown"}
 */
export const updateSize = (title) => {
  const match = VERSION_BUMP.exec(title);
  if (!match) return "unknown";
  const [fromMajor, fromMinor, toMajor, toMinor] = match.slice(1).map(Number);
  if (fromMajor !== toMajor) return "major";
  if (fromMajor === 0 && fromMinor !== toMinor) return "major";
  return "minor-or-patch";
};

const optionalPattern = (source) => (source ? new RegExp(source, "u") : NO_MATCH);

const github = async (path, token) => {
  const response = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response;
};

const githubJson = async (path, token) => (await github(path, token)).json();

const findPullRequest = async (repo, branch, token) => {
  const owner = repo.split("/")[0];
  const query = new URLSearchParams({ head: `${owner}:${branch}`, state: "open" });
  const pulls = await githubJson(`/repos/${repo}/pulls?${query}`, token);
  const pull = pulls.find((candidate) => candidate.user?.login === DEPENDABOT);
  if (!pull) return null;
  return {
    number: pull.number,
    headSha: pull.head.sha,
    title: pull.title,
    labels: pull.labels.map((label) => label.name),
    baseRef: pull.base.ref,
  };
};

const behindBase = async (repo, pr, token) => {
  const path = `/repos/${repo}/compare/${encodeURIComponent(pr.baseRef)}...${pr.headSha}`;
  return (await githubJson(path, token)).behind_by;
};

const listCommits = async (repo, number, token) => {
  const commits = await githubJson(`/repos/${repo}/pulls/${number}/commits?per_page=100`, token);
  return commits.map(toCommit);
};

const listJobs = async (repo, runId, attempt, token) => {
  const path = `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`;
  const { jobs } = await githubJson(path, token);
  return jobs;
};

const failedStep = (lines) => {
  const error = lines.findLastIndex((line) => STEP_ERROR.test(line));
  if (error === -1) return lines;
  const start = lines.slice(0, error).findLastIndex((line) => STEP_START.test(line));
  return lines.slice(Math.max(start, 0), error + 1);
};

/**
 * Cuts a job log down to the failed step. A long step keeps the lines around
 * each failure marker and its tail, because a test runner prints its summary
 * long after the assertion that failed.
 * @param {string} text
 * @returns {string}
 */
export const excerptLog = (text) => {
  const lines = failedStep(
    text
      .replace(ANSI, "")
      .split("\n")
      .map((line) => line.replace(TIMESTAMP, "")),
  );
  if (lines.length <= SHORT_STEP_LINES) return lines.join("\n");

  const keep = new Set();
  const addRange = (from, to) => {
    for (let index = Math.max(from, 0); index <= Math.min(to, lines.length - 1); index += 1) {
      keep.add(index);
    }
  };
  lines.forEach((line, index) => {
    if (FAILURE_LINE.test(line)) addRange(index - CONTEXT_BEFORE, index + CONTEXT_AFTER);
  });

  // The first errors explain the failure best, so they fill the budget first.
  const tailStart = Math.max(lines.length - TAIL_LINES, 0);
  const kept = [...keep]
    .filter((index) => index < tailStart)
    .toSorted((a, b) => a - b)
    .slice(0, MAX_EXCERPT_LINES - TAIL_LINES);
  for (let index = tailStart; index < lines.length; index += 1) kept.push(index);

  const excerpt = [];
  let previous = -1;
  for (const index of kept) {
    if (index !== previous + 1) excerpt.push("[...]");
    excerpt.push(lines[index]);
    previous = index;
  }
  return excerpt.join("\n");
};

const logExcerpt = async (repo, jobId, token) =>
  excerptLog(await (await github(`/repos/${repo}/actions/jobs/${jobId}/logs`, token)).text());

const writeLogs = async (repo, jobs, names, token, file) => {
  const sections = [];
  for (const job of jobs.filter((candidate) => names.includes(candidate.name))) {
    sections.push(`===== ${job.name} (${job.html_url})\n${await logExcerpt(repo, job.id, token)}`);
  }
  writeFileSync(file, `${sections.join("\n\n")}\n`);
};

const REQUIRED_ENV = [
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_OUTPUT",
  "RUN_ID",
  "RUN_ATTEMPT",
  "HEAD_BRANCH",
  "RUN_HEAD_SHA",
  "LOG_FILE",
];

const main = async () => {
  const env = process.env;
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment: ${missing.join(", ")}`);
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const attempt = Number(env.RUN_ATTEMPT);
  const pr = await findPullRequest(repo, env.HEAD_BRANCH, token);
  const jobs = await listJobs(repo, env.RUN_ID, attempt, token);
  const commits = pr ? await listCommits(repo, pr.number, token) : [];
  // The repair job sets CHECK_BEHIND=false: it builds untrusted code, so it has
  // no App token to update the branch, and its triage only collects the logs.
  const behindBy = pr && env.CHECK_BEHIND !== "false" ? await behindBase(repo, pr, token) : 0;
  const decision = classify(
    {
      pr,
      runHeadSha: env.RUN_HEAD_SHA,
      runAttempt: attempt,
      commits,
      jobs: jobs.map((job) => ({ name: job.name, conclusion: job.conclusion })),
      behindBy,
    },
    {
      ignoreJob: optionalPattern(env.IGNORE_JOBS),
      flakyJob: optionalPattern(env.FLAKY_JOBS),
      appLogin: env.APP_LOGIN || DEFAULT_APP_LOGIN,
    },
  );

  if (decision.action === "repair") {
    await writeLogs(repo, jobs, decision.failedJobs, token, env.LOG_FILE);
  }
  console.log(`${decision.action}: ${decision.reason}`);
  const outputs = {
    action: decision.action,
    reason: decision.reason,
    pr: pr?.number ?? "",
    failed_jobs: decision.failedJobs.join(", "),
    update_size: pr ? updateSize(pr.title) : "unknown",
  };
  // A newline in a value would start a new output, so values stay on one line.
  const oneLine = (value) => String(value).replace(/[\r\n]+/gu, " ");
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${oneLine(value)}\n`);
  appendFileSync(env.GITHUB_OUTPUT, lines.join(""));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
