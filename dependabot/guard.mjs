// Checks the repair commit before the reusable dependabot.yml workflow pushes
// it. The commit comes from a runner that installed and built third-party
// code, so it is untrusted.
//
// A commit is rejected when it is more than one commit, changes `.github/`,
// the changelog or git metadata files, adds a binary file, a symbolic link or
// a submodule, or changes more than MAX_CHANGED_LINES hand-written lines.
//
// An accepted commit is pushed and may merge without review (`merge=auto`)
// only when every path is a snapshot or a generated file of the repository.
// Any other change (`merge=review`) is not pushed: a push from the App starts
// the pull request CI with the repository secrets, so a maintainer reviews the
// patch first. A lockfile change is in that group, because a lockfile can name
// a different package that is still on the registry.
//
// The CLI compares HEAD with BEFORE in the current repository and prints each
// problem. It writes `merge=auto` or `merge=review` to GITHUB_OUTPUT when that
// is set, and exits with 1 when the commit must not be pushed.
//
// GENERATED_PATHS and REVIEW_GENERATED_PATHS are optional regular expressions
// for the generated files of the repository.
//
// Run: BEFORE=<sha> node dependabot/guard.mjs

import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The largest hand-written change, in added plus deleted lines. */
export const MAX_CHANGED_LINES = 300;

const BLOCKED_PATH = /^(?:\.github\/|CHANGELOG\.md$|changelog\.d\/|\.git(?:modules|attributes)$)/u;
// Built from code points, so the source holds no control character.
const CONTROL_CHARACTER = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  "u",
);
const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";
const NO_MATCH = /(?!)/u;
const SNAPSHOT_PATH = /\.snap$/u;
const LOCKFILE_PATH =
  /(?:^|\/)(?:Cargo\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/u;
/**
 * Checks a repair commit.
 * @param {{
 *   commits: number,
 *   files: { path: string, added: number | null, deleted: number | null, mode: string }[],
 * }} input
 * @param {{ generated?: RegExp, reviewGenerated?: RegExp }} [options] Paths that a
 *   generator writes. `generated` paths may auto-merge; `reviewGenerated`
 *   paths, such as public contracts, need review. Neither counts toward the
 *   size limit. Snapshots are always generated. Lockfiles do not count toward
 *   the size limit, but need review.
 * @returns {{ ok: boolean, problems: string[], merge: "auto" | "review" }}
 */
export const checkRepair = (
  { commits, files },
  { generated = NO_MATCH, reviewGenerated = NO_MATCH } = {},
) => {
  const isGenerated = (path) => SNAPSHOT_PATH.test(path) || generated.test(path);
  const isSizeExempt = (path) =>
    isGenerated(path) || LOCKFILE_PATH.test(path) || reviewGenerated.test(path);
  const problems = [];
  if (commits !== 1) problems.push(`the patch has ${commits} commits, not 1`);
  for (const { path, added, mode } of files) {
    if (CONTROL_CHARACTER.test(path)) {
      problems.push(`${JSON.stringify(path)} has a control character`);
    } else if (BLOCKED_PATH.test(path)) problems.push(`${path} may not change in a repair`);
    else if (mode === SYMLINK_MODE) problems.push(`${path} is a symbolic link`);
    else if (mode === GITLINK_MODE) problems.push(`${path} is a submodule`);
    else if (added === null) problems.push(`${path} is a binary file`);
  }
  const changed = files
    .filter(({ path, added }) => added !== null && !isSizeExempt(path))
    .reduce((sum, { added, deleted }) => sum + added + deleted, 0);
  if (changed > MAX_CHANGED_LINES) {
    problems.push(`${changed} hand-written lines changed, more than ${MAX_CHANGED_LINES}`);
  }
  const merge = files.every(({ path }) => isGenerated(path)) ? "auto" : "review";
  return { ok: problems.length === 0, problems, merge };
};

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

/**
 * Parses `git diff --numstat -z --no-renames`. Each record is
 * "added<TAB>deleted<TAB>path<NUL>", and a binary file has "-" for both
 * counts. The NUL form keeps a path with a tab, a newline or a non-ASCII byte
 * unquoted.
 * @param {string} output
 * @returns {{ path: string, added: number | null, deleted: number | null }[]}
 */
export const parseNumstat = (output) =>
  output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [added, deleted, ...path] = record.split("\t");
      const count = (value) => (value === "-" ? null : Number(value));
      return { path: path.join("\t"), added: count(added), deleted: count(deleted) };
    });

/**
 * Parses `git diff --raw -z --no-renames` into the new file mode per path.
 * Each record is ":<old mode> <new mode> <old sha> <new sha> <status><NUL><path><NUL>".
 * @param {string} output
 * @returns {Map<string, string>}
 */
export const parseRawModes = (output) => {
  const fields = output.split("\0");
  const modes = new Map();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const newMode = fields[index].split(" ")[1];
    modes.set(fields[index + 1], newMode);
  }
  return modes;
};

const main = () => {
  const before = process.env.BEFORE;
  if (!before) throw new Error("missing environment: BEFORE");
  const commits = Number(git("rev-list", "--count", `${before}..HEAD`).trim());
  const modes = parseRawModes(git("diff", "--raw", "-z", "--no-renames", before, "HEAD"));
  const files = parseNumstat(git("diff", "--numstat", "-z", "--no-renames", before, "HEAD")).map(
    (file) => ({ ...file, mode: modes.get(file.path) ?? "" }),
  );
  const optional = (source) => (source ? new RegExp(source, "u") : NO_MATCH);
  const result = checkRepair(
    { commits, files },
    {
      generated: optional(process.env.GENERATED_PATHS),
      reviewGenerated: optional(process.env.REVIEW_GENERATED_PATHS),
    },
  );
  for (const problem of result.problems) console.log(problem);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `merge=${result.merge}\n`);
  if (!result.ok) process.exitCode = 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
