// Tells which commits on a Dependabot branch come from automation, for
// merge.mjs, triage.mjs and sync.mjs.
//
// Only GitHub logins count: a free-text git author name can claim to be a bot,
// and a commit without a login counts as a person. The committer must be the
// author itself or GitHub (`web-flow`), so a person who pushes a commit with a
// bot as its author, such as an applied repair patch, counts as a person. A
// commit of the App must also carry a verified signature.

export const DEPENDABOT = "dependabot[bot]";
export const REPAIR_BOT = "claude[bot]";
const GITHUB_COMMITTER = "web-flow";

/** Labels that give a pull request to a maintainer. */
export const HOLD_LABELS = ["needs-review", "needs-human"];

/**
 * @param {{ author: string | null, committer?: string | null, verified?: boolean }} commit
 * @param {string} [appLogin] The login of the App that merges the base branch.
 * @returns {boolean}
 */
export const isAutomationCommit = (commit, appLogin = "") => {
  const bots = new Set([DEPENDABOT, REPAIR_BOT, ...(appLogin ? [appLogin] : [])]);
  if (!bots.has(commit.author)) return false;
  // Callers that do not read the committer pass `undefined`; they check less.
  if (commit.committer !== undefined && commit.committer !== commit.author) {
    if (commit.committer !== GITHUB_COMMITTER) return false;
  }
  if (appLogin && commit.author === appLogin && commit.verified !== true) return false;
  return true;
};

/**
 * Maps a commit from the GitHub REST API.
 * @param {any} commit
 * @returns {{ sha: string, author: string | null, committer: string | null, verified: boolean, message: string }}
 */
export const toCommit = (commit) => ({
  sha: commit.sha,
  author: commit.author?.login ?? null,
  committer: commit.committer?.login ?? null,
  verified: commit.commit?.verification?.verified ?? false,
  message: commit.commit?.message ?? "",
});
