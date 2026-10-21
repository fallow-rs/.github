# Dependabot automation

The reusable workflow `.github/workflows/dependabot.yml` takes Dependabot pull
requests in every fallow-rs repository to the default branch without a
maintainer in most cases.

## What it does

| Event | Job | Result |
| --- | --- | --- |
| A pull request workflow succeeds | Merge | Merges the pull request when every check on the head commit passed and no `needs-review` or `needs-human` label is set. Major and SHA-only updates merge too. |
| The caller's schedule | Sweep | Checks every open Dependabot pull request the same way. This catches a pull request whose last check came from an app. |
| A pull request workflow fails | Triage | Reruns cancelled or flaky jobs, asks for a repair, or labels the pull request `needs-human` after two failed repairs. |
| Triage asks for a repair | Repair, Publish | Claude makes one commit, and the guard checks it. A repair of lockfiles, package manifests, tests, snapshots or generated files is committed as a signed commit of the fallow-dependabot App and merges when the checks pass. A repair of application code is not pushed: the pull request gets the `needs-review` label and a comment with the patch and the command to apply it. |

The merge does not depend on branch protection, so it also works in a
repository without required checks. CI is the only gate for an update,
majors included.

A repair builds on the current default branch, and an edited pull request (one
with a repair or a merge of the base) merges only on top of it:

- When a failed pull request is behind, triage brings it up to date before a
  repair. A repository without the App repairs at once.
- When an edited pull request is behind or in conflict, the merge jobs bring it
  up to date first. On a conflict, `sync.mjs` drops the repair and merge
  commits after the newest Dependabot commit, and Dependabot rebases its own
  change if that is in conflict too. A person's commit or a hold label stops
  it.
- The merge and sweep jobs share one concurrency group, and the sweep merges an
  edited pull request only as the first merge of a run. So two repairs that
  raise the same version or build the same output never both merge. GitHub
  keeps one pending job per group, so a merge job can be dropped; the next
  sweep then merges that pull request.
- A pull request that only Dependabot changed keeps the behavior of Dependabot.

A conflict reset drops the repair commits, so their count starts again. Each
reset needs a conflicting change on the default branch, which limits how often
that happens.

## Add a repository

1. Add `.github/workflows/dependabot.yml`. List every workflow that runs on
   pull requests under `workflows`:

   ```yaml
   name: Dependabot

   on:
     workflow_run:
       workflows: [CI]
       types: [completed]
       branches: ['dependabot/**']
     schedule:
       - cron: '17 */3 * * *'
     workflow_dispatch:

   permissions: {}

   # Failed runs share one group per branch, so two repairs never race. A
   # successful run gets its own group, so it cannot replace a pending repair.
   concurrency:
     group: dependabot-${{ github.event.workflow_run.head_branch || github.event_name }}-${{ github.event.workflow_run.conclusion == 'failure' && 'repair' || github.run_id }}
     cancel-in-progress: false

   jobs:
     dependabot:
       uses: fallow-rs/.github/.github/workflows/dependabot.yml@<sha> # main
       permissions:
         actions: write
         checks: read
         contents: read
         issues: write
         pull-requests: write
         statuses: read
       secrets:
         ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
         DEPENDABOT_APP_PRIVATE_KEY: ${{ secrets.DEPENDABOT_APP_PRIVATE_KEY }}
   ```

   GitHub runs `schedule` only on the default branch. To use a Claude
   subscription instead of the API key, also pass
   `CLAUDE_CODE_OAUTH_TOKEN`.

2. Optional inputs: `ignore-jobs`, `flaky-jobs`, `ignore-checks`,
   `generated-paths`, `review-generated-paths` and `manifest-paths` (regular
   expressions), and `model`. Anchor each pattern with `^` and `$`: `bench`
   also matches `bench-security`. A wide `generated-paths` pattern removes the
   size limit and allows auto-merge for every file it matches, so keep it to
   real generator output. Files in `manifest-paths` follow the rule of
   `package.json`: a repair merges without review only when each added line
   sets a version.
3. Optional: add `.github/dependabot-repair.md` with the install commands,
   local checks and known causes of the repository. The repair reads it from
   the default branch.
4. Make sure `.github/dependabot.yml` exists, with a cooldown.

## Setup

| Setting | Scope | Use |
| --- | --- | --- |
| `DEPENDABOT_APP_CLIENT_ID` | Organization variable | The client ID of the fallow-dependabot GitHub App. |
| `DEPENDABOT_APP_PRIVATE_KEY` | Organization secret | The private key of that App. |
| `ANTHROPIC_API_KEY` | Organization secret | The Claude API key for the repair. |

On the free plan, organization secrets do not reach private repositories. Set
the two secrets and the variable on each private repository. The App must be
installed on every repository that calls the workflow.

## Security

- The workflow runs only for `dependabot/**` branches in the same repository.
- The scripts and the instructions come from this workflow's own commit
  (`job.workflow_sha`), and the repository notes from the default branch.
- The repair job installs and builds third-party code, so it holds only a
  read-only `GITHUB_TOKEN`. The action never exchanges OIDC for the Claude
  GitHub app token, because it gets `github_token`.
- The publish job runs on a new runner and runs no project code. The guard
  rejects changes under `.github/`, to the changelog and to git metadata
  files, binary files, symbolic links, submodules and more than 300
  hand-written lines. The push token can write contents only.
- `publish.mjs` does not push the checked commit. It sends the same file
  changes through the GraphQL `createCommitOnBranch` mutation, so GitHub
  creates the commit on top of the checked head only, signs it, and names the
  App as its author. It refuses a file mode change, because the API cannot keep
  one, and it moves the branch back when the signed tree differs from the
  checked tree.
- Only signed commits from Dependabot or the App count as automation, and
  their committer must be the author or GitHub (`identity.mjs`). Any other
  commit, such as a repair patch that a maintainer applied, counts as a person,
  and the automation leaves that pull request alone.
- A repair is pushed without review only when it touches lockfiles, package
  manifests, tests, snapshots or generated files, every added manifest line
  only sets a dependency version, and no added lockfile line names a source
  outside the registry. A push from the App starts the pull request CI with
  the repository secrets, so a repair of application code waits for a
  maintainer.

## Development

```bash
node --test dependabot/*.test.mjs
```
