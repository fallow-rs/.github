// Tells which commits on a Dependabot branch come from automation, for
// merge.mjs, triage.mjs and sync.mjs.
//
// Automation is Dependabot and the App. publish.mjs creates each repair commit
// through the API with the App token, and sync.mjs merges the base branch with
// it, so GitHub signs both and names the App as the author. A commit counts as
// automation only when its author is one of the two, GitHub verified its
// signature, and the committer is the author itself or GitHub (`web-flow`).
// Any other commit, such as an applied repair patch, counts as a person.
//
// Only GitHub logins count: a free-text git author name can claim to be a bot,
// and a commit without a login counts as a person.

export const DEPENDABOT = "dependabot[bot]";
/** The App from DEPENDABOT_APP_CLIENT_ID, unless the caller names another. */
export const DEFAULT_APP_LOGIN = "fallow-dependabot[bot]";
const GITHUB_COMMITTER = "web-flow";

/** Labels that give a pull request to a maintainer. */
export const HOLD_LABELS = ["needs-review", "needs-human"];

/**
 * @typedef {{ author: string | null, committer?: string | null, verified?: boolean, parents?: number }} Commit
 */

/**
 * @param {Commit} commit
 * @param {string} [appLogin]
 * @returns {boolean}
 */
export const isAutomationCommit = (commit, appLogin = DEFAULT_APP_LOGIN) => {
  if (commit.author !== DEPENDABOT && commit.author !== appLogin) return false;
  if (commit.verified !== true) return false;
  // Callers that do not read the committer pass `undefined`.
  if (commit.committer === undefined) return true;
  return commit.committer === commit.author || commit.committer === GITHUB_COMMITTER;
};

/**
 * Tells if a commit is a repair: an App commit with one parent. A merge of the
 * base branch by the App has two.
 * @param {Commit} commit
 * @param {string} [appLogin]
 * @returns {boolean}
 */
export const isRepairCommit = (commit, appLogin = DEFAULT_APP_LOGIN) =>
  commit.author === appLogin && (commit.parents ?? 1) === 1;

/**
 * Maps a commit from the GitHub REST API.
 * @param {any} commit
 * @returns {{ sha: string, author: string | null, committer: string | null, verified: boolean, message: string, parents: number }}
 */
export const toCommit = (commit) => ({
  sha: commit.sha,
  author: commit.author?.login ?? null,
  committer: commit.committer?.login ?? null,
  verified: commit.commit?.verification?.verified ?? false,
  message: commit.commit?.message ?? "",
  parents: commit.parents?.length ?? 1,
});
