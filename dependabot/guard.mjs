// Checks the repair commit before the reusable dependabot.yml workflow pushes
// it. The commit comes from a runner that installed and built third-party
// code, so it is untrusted.
//
// A commit is rejected when it is more than one commit, changes `.github/`,
// the changelog or git metadata files, adds a binary file, a symbolic link or
// a submodule, or changes more than MAX_CHANGED_LINES hand-written lines.
//
// An accepted commit is pushed and may merge without review (`merge=auto`)
// when every path is a lockfile, a package manifest, a test, a snapshot or a
// generated file, every added manifest line only sets a dependency version,
// and no added lockfile line names a package source outside the registry. Any other change (`merge=review`) is not
// pushed: a push from the App starts the pull request CI with the repository
// secrets, so a maintainer reviews application code first.
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
const MANIFEST_PATH = /(?:^|\/)(?:package\.json|Cargo\.toml)$/u;
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:rs|go)$/u;
// A manifest or lockfile line that names where a package comes from. The match
// is wide on purpose: any scheme, any case, and the specifiers that npm, pnpm,
// bun and Cargo accept for a source outside the registry.
const SOURCE_HINT =
  /:\/\/|\b(?:resolved|tarball|repo)\b|\b(?:git|file|link|github|directory|path|workspace|npm)[+:]|\b(?:git|path|registry|branch|rev)\s*=/iu;
// A manifest line that only sets a dependency version: "name": "^1.2.3",
// "name": "npm:pkg@1.2.3", name = "1.2", name = { version = "1.2", ... }, or
// a closing bracket. Any other manifest line, such as a script, needs review.
const DEPENDENCY_LINE = [
  /^\s*"[@\w./-]+": "(?:npm:(?:@[\w.-]+\/)?[\w.-]+@)?[\^~>=<]*\s*\d[\w.+-]*(?: \|\| [\^~>=<]*\d[\w.+-]*)*",?$/u,
  /^[\w-]+ = "[\^~>=<]*\d[\w.+-]*"$/u,
  /^[\w-]+ = \{ version = "[\^~>=<]*\d[\w.+-]*"(?:, (?:features = \[[^\]]*\]|default-features = (?:true|false)|optional = (?:true|false)|package = "[\w-]+"))*\s*\}$/u,
  /^\s*[}\]],?$/u,
];
// The only source lines that keep auto-merge.
const REGISTRY_SOURCE_LINE = [
  /^\s*"resolved": "https:\/\/registry\.npmjs\.org\/[^"\s]+\.tgz",?$/u,
  /^\s*resolved "https:\/\/registry\.(?:yarnpkg\.com|npmjs\.org)\/[^"\s]+"$/u,
  /^source = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"$/u,
  // An npm alias to a registry package, such as "vite": "npm:pkg@1.2.3".
  /^\s*"[^"]+": "npm:(?:@[\w.-]+\/)?[\w.-]+@[\w.^~<>=| -]+",?$/u,
  // npm copies the `funding` metadata of a package. npm never fetches it.
  /^\s*"(?:url|funding)": "https:\/\/[^"\s]+",?$/u,
];
const LOCKFILE_PATH =
  /(?:^|\/)(?:Cargo\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/u;
/**
 * Checks a repair commit.
 * @param {{
 *   commits: number,
 *   files: { path: string, added: number | null, deleted: number | null, mode: string }[],
 *   sourceLines?: string[],
 *   manifestLines?: string[],
 * }} input
 * @param {{ generated?: RegExp, reviewGenerated?: RegExp }} [options] Paths that a
 *   generator writes. `generated` paths may auto-merge; `reviewGenerated`
 *   paths, such as public contracts, need review. Neither counts toward the
 *   size limit. Snapshots are always generated. Lockfiles do not count toward
 *   the size limit, but need review.
 * @returns {{ ok: boolean, problems: string[], merge: "auto" | "review" }}
 */
export const checkRepair = (
  { commits, files, sourceLines = [], manifestLines = [] },
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
  // Lockfiles, manifests and tests are what a dependency repair needs. They
  // merge without review when no added line names a source outside the
  // registry. Application code always needs review.
  const isAutoPath = (path) =>
    isGenerated(path) ||
    LOCKFILE_PATH.test(path) ||
    MANIFEST_PATH.test(path) ||
    TEST_PATH.test(path);
  const auto =
    files.every(({ path }) => isAutoPath(path)) &&
    sourceLines.every(isRegistryLine) &&
    manifestLines.every(isDependencyLine);
  const merge = auto ? "auto" : "review";
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

/**
 * Tells if an added manifest line only sets a dependency version.
 * @param {string} line
 * @returns {boolean}
 */
export const isDependencyLine = (line) =>
  line.trim() === "" || DEPENDENCY_LINE.some((pattern) => pattern.test(line));

/**
 * Tells if an added manifest or lockfile line keeps auto-merge: it names no
 * source, or it names the registry in its exact form.
 * @param {string} line
 * @returns {boolean}
 */
export const isRegistryLine = (line) =>
  !SOURCE_HINT.test(line) || REGISTRY_SOURCE_LINE.some((pattern) => pattern.test(line));

/**
 * Lists the lines that a unified diff adds. A `+++` line counts as a file
 * header only before the first hunk of its file.
 * @param {string} diff
 * @returns {string[]}
 */
export const addedLines = (diff) => {
  const added = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) added.push(line.slice(1));
  }
  return added;
};

const main = () => {
  const before = process.env.BEFORE;
  if (!before) throw new Error("missing environment: BEFORE");
  const commits = Number(git("rev-list", "--count", `${before}..HEAD`).trim());
  const modes = parseRawModes(git("diff", "--raw", "-z", "--no-renames", before, "HEAD"));
  const files = parseNumstat(git("diff", "--numstat", "-z", "--no-renames", before, "HEAD")).map(
    (file) => ({ ...file, mode: modes.get(file.path) ?? "" }),
  );
  const diffLines = (pattern) => {
    const paths = files.map(({ path }) => path).filter((path) => pattern.test(path));
    // Literal pathspecs, so a path with `*`, `:` or `[` names only itself.
    return paths.length === 0
      ? []
      : addedLines(
          git(
            "--literal-pathspecs",
            "diff",
            "--unified=0",
            "--no-renames",
            before,
            "HEAD",
            "--",
            ...paths,
          ),
        );
  };
  const sourceLines = diffLines(LOCKFILE_PATH);
  const manifestLines = diffLines(MANIFEST_PATH);
  const optional = (source) => (source ? new RegExp(source, "u") : NO_MATCH);
  const result = checkRepair(
    { commits, files, sourceLines, manifestLines },
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
