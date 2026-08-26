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

## Generated READMEs

`readme.yml` renders `README.md` from two files a repository keeps on its development branch:
`.github/docs-config.yml` for the settings and `CONTENT.md` for its own prose. Nothing about a
README is hand-written, and the README only ever lands on the default branch.

`kind` picks the section set. Without it the generator reads the checkout: a
`src/main/resources/plugin.yml` means `addon`, a Gradle or Maven build means `java-library`, a
`package.json` means `npm-package`, anything else is `generic`.

| kind | sections |
| --- | --- |
| `addon` | logo, title, badges, description, requirements, content, developer-api, wiki, discord, license-prose |
| `gradle-plugin` | title, releases, about, plugin-usage, content, license-badge |
| `java-library` | title, releases, about, library-usage-private, library-usage-public, modules, content, license-badge |
| `npm-package` | title, badges, description, npm-install, content, license-badge |
| `generic` | logo, title, badges, description, content, license-badge |

A `sections:` list replaces the kind's order outright and a `badges:` list replaces its badge set
(`build`, `downloads`, `followers`, `stars`, `bstats`, `license`, `release`, `npm-version`,
`npm-downloads`). A section whose source is missing renders nothing, so a repository without a
LICENSE, a description, a release or a `CONTENT.md` never grows an empty heading.

Values the generator can read for itself are not settings: the title and description come from
`gradle.properties` or `package.json`, the Maven group from `artifact_group`, the licence from the
LICENSE file or the `package.json` SPDX id, the module list from the release's classifier assets,
and the offline version from `artifact_version` or the `package.json` version.

### Placeholders

`CONTENT.md` and every prose setting take `\{{ placeholder }}` substitutions, so a long
`CONTENT.md` still tracks the release it documents instead of freezing at whatever was true the
day it was written:

```groovy
githubImplementation "\{{ org }}:\{{ artifact }}:\{{ tag }}"
```

`${{ github.repository }}` is left alone, because a GitHub Actions expression is not a
placeholder, and a leading backslash escapes one. A placeholder the repository cannot resolve
stays visible in the rendered README and is reported on stderr, never silently emptied.

Every setting in `docs-config.yml` is a placeholder under its own name (`\{{ java }}`,
`\{{ paper }}`, `\{{ discord }}` and so on), alongside these derived values:

| placeholder | value |
| --- | --- |
| `org`, `repo`, `repository` | owner, name, and `owner/name` |
| `repo_url`, `releases_url`, `release_url` | the repository, its releases page, this release |
| `tag`, `version` | the release tag, and the tag without a leading `v` |
| `release_date` | the release's publication date, `YYYY-MM-DD` |
| `default_branch` | the branch the README is generated on |
| `kind` | the resolved kind |
| `title`, `description` | as rendered in the README |
| `license`, `license_slug` | the licence name and its shields.io slug |
| `artifact`, `group`, `plugin_id` | the published coordinates |
| `modules`, `module_count` | the release's module classifiers |
| `package_name`, `package_version`, `package_bin`, `dependencies` | from `package.json` |

`python3 .github/scripts/generate-readme.py --repository owner/name --offline --placeholders`
prints the whole table with the current repository's values in it.

The generator is TypeScript that Node runs directly, with no build step and no dependency.
Its own tests run offline, with no network: `npm test`.

## Deploying and monitoring a service

`deploy-cloudflare.yml` publishes a Cloudflare Worker. `checks` is a newline separated list of
commands run in order first, so a version that cannot pass its own checks never reaches
Cloudflare, and a failing check stops the list rather than continuing to the next one. Deploying
from a developer machine needs no credential at all, because `wrangler login` holds an OAuth
session there; CI has no browser, so it needs `CLOUDFLARE_API_TOKEN`, and an empty one is reported
by name instead of reaching wrangler as an opaque auth failure. `CLOUDFLARE_ACCOUNT_ID` is a secret
rather than a committed value so the account id stays out of a public repository.

`monitor.yml` turns a health endpoint into a notification: a service that reports its own status
cannot push that anywhere, so the run fails and GitHub emails the repository owner.
`unhealthy_jq` is a jq expression over the response body returning a string, where non-empty means
unhealthy; leave it empty to assert only that the request succeeded. Two behaviours matter more
than they look:

- An empty `url`, or a missing token while `require_token` is set, **skips and passes**. A fork
  that has deployed nothing is not permanently red.
- A `unhealthy_jq` that cannot be evaluated **fails**. Silently reporting healthy is the one
  outcome a monitor must never produce, so a malformed expression or an unexpected body is an
  error rather than a pass.

The caller owns the schedule, since how often a service is worth checking is its own business.
`cache_bust` (on by default) appends a unique query parameter so no intermediary can serve a stale
healthy response.

## Gradle wrapper validation

Every workflow here that runs `./gradlew` first checks each committed `gradle-wrapper.jar` against
Gradle's published checksums, using `.github/actions/validate-gradle-wrapper`. The wrapper is an
executable binary that a build runs before any of the repository's own code, so a tampered one gets
arbitrary code execution in a job that may hold publishing credentials, and a diff review does not
catch it.

The check runs before the wrapper is made executable or invoked, since validating one after running
it proves nothing. A repository with no wrapper jar is skipped quietly rather than failed, so a
build that uses a system gradle is unaffected.

A failure means the jar does not match any Gradle release. That is either a corrupt or hand-edited
wrapper, in which case regenerate it with `./gradlew wrapper --gradle-version <version>`, or a
wrapper built from source, in which case pass its checksum through `allow-checksums`. Set
`validate_wrapper: false` on the caller to opt out, and expect to justify it.

## Reusable workflows and this repository's own

Every file in `.github/workflows/` here is a reusable workflow that other repositories call,
**unless its name starts with `self-`**. A `self-` file is this repository's own CI: it declares no
`workflow_call`, nothing outside can reach it, and it exists only to test or document this
repository. Its display name is prefixed `Self:` so the two are also distinguishable in the Actions
run list, which shows names rather than filenames.

The convention exists because the alternative was tried. `tests.yml` sat next to `test.yml` with no
hint that one was callable and one was not, and `generate-readme.yml` carried the same display name
as the reusable `readme.yml`, making them impossible to tell apart in the UI.

The two cannot simply be folded into one file each. A reusable workflow cannot reliably trigger
itself: `workflow_call` inputs are unpopulated when the same workflow runs on `push`, so
`test.yml`'s `run: ${{ inputs.node_test }}` would execute nothing, and under `workflow_call`
`github.event_name` reports the caller's event, so the two paths cannot be told apart from inside.

A consumer repository's thin caller is a third thing again, named for what it does in that
repository (`ci.yml`, `readme.yml`), and lives there rather than here.

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
