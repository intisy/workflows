## How a repository uses this

Every consumer repository's `.github/workflows/*.yml` is a thin caller. A file that carries
`runs-on` or `steps` holds logic that belongs here instead.

```yaml
name: Generate README
on:
  release:
    types: [published]
permissions:
  contents: write
jobs:
  readme:
    uses: intisy/workflows/.github/workflows/readme.yml@main
    with:
      repository: ${{ github.repository }}
    secrets:
      envPAT: ${{ secrets.PAT }}
```

More caller templates live in [`.examples`](.examples).

## Branch names

A caller's own `on: push: branches:` trigger is the only place a branch name may be written
literally, because a reusable workflow cannot parameterise its own trigger.

Everywhere else, a reusable workflow takes the branch as an input: `default_branch` for the branch
it works on, `source` and `target` for the two ends of a merge. So no reusable workflow here
contains `main`, `master`, `stable`, `development` or `experimental` as a literal, and
`npm-dual-publish`'s `workflow check` fails when one appears.

## Pinning a ref

A caller's `uses:` pins a ref in this repository, which the calling repository does not control.
Renaming or deleting a branch here invalidates every `uses:` pinned to it across every consumer,
and nothing reports it: each broken reference stays silent until that caller next runs, so one
rename can leave hundreds of references dead for as long as nobody triggers them. Pin the default
branch or a tag, and treat a branch rename here as a fleet-wide breaking change.
