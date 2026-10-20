# Dependabot automation

The reusable workflow `.github/workflows/dependabot.yml` takes Dependabot pull
requests in every fallow-rs repository to the default branch without a
maintainer in most cases.

## What it does

| Event | Job | Result |
| --- | --- | --- |
| A pull request workflow succeeds | Merge | Merges the pull request when every check on the head commit passed, the update is a minor or patch update, and no `needs-review` or `needs-human` label is set. |
| The caller's schedule | Sweep | Checks every open Dependabot pull request the same way. This catches a pull request whose last check came from an app. |
| A pull request workflow fails | Triage | Reruns cancelled or flaky jobs, asks for a repair, or labels the pull request `needs-human` after two failed repairs. |
| Triage asks for a repair | Repair, Publish | Claude makes one commit. The guard checks it, and the fallow-dependabot App pushes it. A repair of lockfiles, generated files or snapshots merges when the checks pass. Any other repair gets the `needs-review` label. |

The merge does not depend on branch protection, so it also works in a
repository without required checks. Major updates always wait for a
maintainer.

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
   `generated-paths` and `review-generated-paths` (regular expressions), and
   `model`. Anchor each pattern with `^` and `$`: `bench` also matches
   `bench-security`. A wide `generated-paths` pattern removes the size limit
   and allows auto-merge for every file it matches, so keep it to real
   generator output.
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
- Only a repair of lockfiles, generated files or snapshots merges without
  review, and a lockfile change must keep every new source on the official
  registry.

## Development

```bash
node --test dependabot/*.test.mjs
```
