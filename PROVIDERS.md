# Provider Adapters

The Pinaxis provider framework enables fail-over across compute platforms. A single `PINAXIS_PROVIDERS` variable drives provider selection and rotation; the workflow automatically tries the next provider if one fails.

## How It Works

The `PINAXIS_PROVIDERS` variable holds a comma-separated list of enabled provider names. The workflow:

1. Calls `select-order` with `PINAXIS_PROVIDERS` and `github.run_number` to produce an ordered list, starting at index `github.run_number % provider_count`.
2. Loops through the ordered list and attempts each provider's adapter script in turn.
3. If a provider's script exits zero, the crawl succeeds and exits immediately.
4. If a provider's script exits non-zero, logs the failure and tries the next provider.
5. If all providers fail, exits non-zero.

This rotation ensures load distribution: the same provider is not always first, and failures automatically trigger fail-over without workflow intervention.

## Environment Variables

Every provider script receives this environment:

**Crawler metadata (from the workflow caller):**
- `PINAXIS_GITHUB_OWNER`: Repository owner (from `github.repository_owner`)
- `PINAXIS_GITHUB_REPO`: Repository name (from `github.event.repository.name`)
- `PINAXIS_GITHUB_RELEASE_TAG`: Release tag to scan (workflow input)
- `PINAXIS_GITHUB_ASSET`: Asset filename to scan (workflow input)
- `PINAXIS_MAX_MINUTES`: Job timeout in minutes (workflow input, default: 55)

**Tokens and credentials:**
- `PINAXIS_GITHUB_STORE_TOKEN`: GitHub token for storing crawl results
- `PINAXIS_OFFLOAD_CRAWL_TOKENS`: Comma-separated list of GitHub tokens for crawling (mapped onto `PINAXIS_GITHUB_CRAWL_TOKENS` inside the adapter)

**Runner context (from Actions):**
- `GITHUB_SHA`: The commit SHA
- `RUNNER_TEMP`: Temporary directory path

**Provider-specific variables (gated by provider name):**
Each provider declares its own required variables as env guards at the top of its script.

## The CloudRun Adapter Example

The `cloudrun.sh` adapter demonstrates the contract. It requires these provider-specific variables:

- `GCP_PROJECT`: GCP project ID
- `GCP_REGION`: GCP region (e.g., `us-central1`)
- `GCP_ARTIFACT_REGISTRY`: Artifact Registry name
- `GCP_SA_KEY`: GCP service account key (JSON)
- `CLOUD_RUN_JOB`: Cloud Run job name (optional, default: `pinaxis`)

The adapter:
1. Authenticates to GCP using the service account key
2. Builds the container from the caller's `Dockerfile`, tagging it with `${GITHUB_SHA}` and `latest`
3. Pushes the image to Artifact Registry
4. Creates or updates a Cloud Run job with the image
5. Executes the job once using `gcloud run jobs execute --wait=false`
6. Exits zero on success, non-zero on any failure

**Important:** The adapter uses the `^@^` custom delimiter trick with gcloud's `--set-env-vars` to safely pass `PINAXIS_OFFLOAD_CRAWL_TOKENS` (a comma-separated list) without shell expansion:

```bash
gcloud run jobs "$action" "$job" \
  --region "$GCP_REGION" \
  --image "${image}:${GITHUB_SHA}" \
  --set-env-vars "^@^PINAXIS_GITHUB_OWNER=${PINAXIS_GITHUB_OWNER}@PINAXIS_GITHUB_REPO=${PINAXIS_GITHUB_REPO}@..."
```

This approach avoids issues with commas in token lists and should be adopted by all adapters handling multi-value environment variables.

## Adapter Contract

Every provider script must:

1. **Declare required variables** using bash's `: ${VAR:?missing VAR}` guards at the top, covering both framework-provided and provider-specific variables.
2. **Build from the caller's `Dockerfile`** to ensure the crawler code is current.
3. **Deploy and run the crawler once**, passing the framework env variables through.
4. **Exit zero on success**, non-zero on failure. The workflow treats any non-zero exit as a provider failure and tries the next one.

The adapter is responsible for all infrastructure plumbing: authentication, image registry access, job creation or update, and deployment.

## Adding a New Provider

To add a provider named `mycloud`:

1. **Write the adapter script** at `<workflows-repo>/providers/mycloud.sh`.
   - Declare all required variables with `: ${VAR:?message}` guards.
   - Build and deploy the crawler from the caller's `Dockerfile`.
   - Exit zero on success, non-zero on failure.

2. **Document the provider-specific variables and secrets** in the adapter script's comments or in a provider-specific section of this file.

3. **Add the provider name to `PINAXIS_PROVIDERS`** in your repository's GitHub variables:
   ```
   PINAXIS_PROVIDERS=cloudrun,mycloud
   ```

4. **Add any provider-specific setup to the workflow** in `.github/workflows/pinaxis-run.yml`, gated by provider name:
   ```yaml
   - name: Authenticate to mycloud
     if: contains(vars.PINAXIS_PROVIDERS, 'mycloud')
     # ... authentication step ...
   ```

5. **Add provider-specific variables and secrets** to your repository:
   - Variables: `MY_CLOUD_PROJECT`, etc. (visible in logs)
   - Secrets: `MY_CLOUD_API_KEY`, etc. (redacted in logs)

## Tokens and PINAXIS_OFFLOAD_CRAWL_TOKENS

The framework passes crawl tokens to the provider via `PINAXIS_OFFLOAD_CRAWL_TOKENS`, a comma-separated list. Each adapter is responsible for mapping this onto the crawler's expected environment variable name.

**Example (cloudrun.sh):**
```bash
--set-env-vars "^@^...@PINAXIS_GITHUB_CRAWL_TOKENS=${PINAXIS_OFFLOAD_CRAWL_TOKENS}"
```

This naming convention (`PINAXIS_OFFLOAD_*` for framework variables, mapped to `PINAXIS_*` for in-container variables) keeps provider responsibilities clear: the framework provides tokens generically, and each provider adapts them to the crawler's interface.
