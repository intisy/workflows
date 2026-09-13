# Provider Adapters

The offload framework lets any repository hand off a job to a cloud compute provider, with
automatic fail-over across whichever providers the caller has enabled. A single reusable
workflow, `offload-run.yml`, drives selection, rotation, and the environment handed to each
provider's adapter script.

## The `env_prefix` contract

The caller of `offload-run.yml` passes one required input, `env_prefix`. Every repository
variable and secret whose name starts with that prefix is selected and placed in the
container's environment; nothing else is. This is what lets the same reusable workflow serve
any consumer: the consumer's own naming convention is the prefix, not something baked into this
repo.

For example, a caller using `PINAXIS_` as its prefix exposes `PINAXIS_GITHUB_REPO`,
`PINAXIS_MAX_MINUTES`, and any other `PINAXIS_*` variable or secret it defines, but nothing
with a different prefix.

### The `OFFLOAD_` override

A variable or secret named `<PREFIX>OFFLOAD_<REST>` overrides `<PREFIX><REST>` in the
container, and is never forwarded under its own name. This exists so a cloud job can be given a
larger credential pool than the one used inside GitHub Actions itself.

For example, with `env_prefix: PINAXIS_`:
- `PINAXIS_GITHUB_CRAWL_TOKENS` might hold the token GitHub Actions itself uses.
- `PINAXIS_OFFLOAD_GITHUB_CRAWL_TOKENS` holds a larger, comma-separated pool of tokens meant
  only for the cloud job.
- The container receives `PINAXIS_GITHUB_CRAWL_TOKENS` set to the pool's value; the plain
  variable is not forwarded at all when the override is present.

### Failure modes

- If `env_prefix` matches no variable or secret at all, the run aborts with an error naming
  the prefix that matched nothing. A typo in the prefix fails loudly instead of silently
  running with an empty environment.
- If any selected value contains a newline, the run aborts. The environment is written to a
  line-based file (`OFFLOAD_ENV_FILE`), which cannot represent a value containing one.

Both checks happen in `select-env.mjs`, which the reusable workflow invokes before any provider
runs.

### The providers list

The set of enabled providers is not a separate input. It is read from
`<PREFIX>PROVIDERS`, a repository variable holding a comma-separated list of provider names,
for example `PINAXIS_PROVIDERS=cloudrun,mycloud`.

## How the run works

1. `offload-run.yml` computes `<PREFIX>PROVIDERS`, then calls `select-order` with that list and
   `github.run_number` to produce a rotated order, starting at
   `run_number % provider_count`. This spreads load across providers instead of always trying
   the same one first.
2. It loops through the ordered list and runs each provider's adapter script at
   `providers/<name>.sh` in turn.
3. The first adapter that exits zero ends the run successfully.
4. An adapter that exits non-zero is logged as failed, and the next provider is tried.
5. If every enabled provider fails, the run exits non-zero.

## What an adapter receives

Every adapter script is invoked with:

- `OFFLOAD_ENV_FILE`: path to a line-based file of `NAME=value` pairs, the selected and
  override-applied environment for the container. This is what the adapter must hand to the
  job it runs; it is not exported into the adapter's own shell environment.
- `OFFLOAD_JOB_NAME`: the job name to deploy under, defaulting to the calling repository's
  name.
- `GITHUB_SHA`: the commit SHA, useful for image tags.
- `RUNNER_TEMP`: a scratch directory on the runner.
- Its own provider-specific variables, described below.

## The adapter contract

An adapter at `providers/<name>.sh` must:

1. Declare every variable it requires, both the framework variables above and its own
   provider-specific ones, as guards at the top of the script (bash's
   `: "${VAR:?missing VAR}"` idiom). This makes missing configuration fail immediately with a
   clear message instead of misbehaving deeper in the script.
2. Build the caller's `Dockerfile` into an image.
3. Run that image once with the environment from `OFFLOAD_ENV_FILE`.
4. Exit zero on success, non-zero on any failure. The reusable workflow treats a non-zero exit
   as this provider failing over to the next one.

Provider-specific variables (such as `GCP_*` for the `cloudrun` adapter) are always
provider-scoped and never carry the caller's `env_prefix`. They belong to the provider, not to
any one consumer, so every adapter declares its own required variables as guards regardless of
which repository is calling it.

## Worked example: `cloudrun.sh`

`providers/cloudrun.sh` is the reference adapter. It requires:

- `GCP_PROJECT`: GCP project ID
- `GCP_REGION`: GCP region, for example `us-central1`
- `GCP_ARTIFACT_REGISTRY`: Artifact Registry name
- `GCP_SA_KEY`: GCP service account key (JSON)

It authenticates to GCP with the service account key, builds and pushes the caller's
`Dockerfile` tagged with `${GITHUB_SHA}` and `latest`, creates or updates a Cloud Run job with
that image, and executes the job once with `gcloud run jobs execute --wait=false`.

To pass `OFFLOAD_ENV_FILE` into `gcloud run jobs create/update --set-env-vars`, the adapter uses
gcloud's `^@^` custom-delimiter syntax:

```bash
env_arg="^@^$(paste -sd '@' "$OFFLOAD_ENV_FILE")"
gcloud run jobs "$action" "$job" \
  --region "$GCP_REGION" \
  --image "${image}:${GITHUB_SHA}" \
  --set-env-vars "$env_arg"
```

This is not cosmetic: `--set-env-vars` normally splits its argument on commas to separate
`NAME=value` pairs, which would silently truncate any value that itself contains a comma, such
as a comma-separated token pool from an `OFFLOAD_` override. The `^@^` prefix tells gcloud to
use `@` as the pair delimiter instead, so commas inside values pass through untouched. Any
adapter that forwards a multi-value environment variable to a CLI with comma-based argument
parsing should use the same trick.

## Adding a new provider

To add a provider named `mycloud`:

1. Write `providers/mycloud.sh` following the adapter contract above: declare required
   variables as guards, build and run the caller's `Dockerfile`, exit zero or non-zero.
2. Document `mycloud`'s provider-specific variables and secrets, either in the adapter script's
   comments or in a new section of this file.
3. Add `mycloud` to the caller repository's `<PREFIX>PROVIDERS` variable, for example
   `PINAXIS_PROVIDERS=cloudrun,mycloud`.
4. Add any provider-specific setup steps (such as an authentication action) to
   `.github/workflows/offload-run.yml`, gated on the provider name appearing in
   `vars[format('{0}PROVIDERS', inputs.env_prefix)]`.
5. Add `mycloud`'s required variables and secrets to the caller repository: variables for
   anything that can appear in logs, secrets for anything that must be redacted.
