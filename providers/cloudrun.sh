#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT:?missing GCP_PROJECT}"
: "${GCP_REGION:?missing GCP_REGION}"
: "${GCP_ARTIFACT_REGISTRY:?missing GCP_ARTIFACT_REGISTRY}"
: "${GCP_SA_KEY:?missing GCP_SA_KEY}"
: "${MS_GITHUB_STORE_TOKEN:?missing MS_GITHUB_STORE_TOKEN}"
: "${MS_OFFLOAD_CRAWL_TOKENS:?missing MS_OFFLOAD_CRAWL_TOKENS}"
: "${MS_GITHUB_RELEASE_TAG:?missing MS_GITHUB_RELEASE_TAG}"
: "${MS_GITHUB_ASSET:?missing MS_GITHUB_ASSET}"
: "${GITHUB_SHA:?missing GITHUB_SHA}"
: "${RUNNER_TEMP:?missing RUNNER_TEMP}"
: "${MS_GITHUB_OWNER:?missing MS_GITHUB_OWNER}"
: "${MS_GITHUB_REPO:?missing MS_GITHUB_REPO}"

job="${CLOUD_RUN_JOB:-multiscrape}"
image="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_ARTIFACT_REGISTRY}/${job}"

# authenticate to GCP using the service account key from the environment
printf '%s' "$GCP_SA_KEY" > "$RUNNER_TEMP/gcp-key.json"
gcloud auth activate-service-account --key-file="$RUNNER_TEMP/gcp-key.json"
gcloud config set project "$GCP_PROJECT"
gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet

docker build -t "${image}:${GITHUB_SHA}" -t "${image}:latest" .
docker push "${image}:${GITHUB_SHA}"
docker push "${image}:latest"

if gcloud run jobs describe "$job" --region "$GCP_REGION" >/dev/null 2>&1; then
  action=update
else
  action=create
fi

# ^@^ declares @ as delimiter; single --set-env-vars with custom delimiter safely handles comma-separated tokens
gcloud run jobs "$action" "$job" \
  --region "$GCP_REGION" \
  --image "${image}:${GITHUB_SHA}" \
  --set-env-vars "^@^MS_GITHUB_OWNER=${MS_GITHUB_OWNER}@MS_GITHUB_REPO=${MS_GITHUB_REPO}@MS_GITHUB_RELEASE_TAG=${MS_GITHUB_RELEASE_TAG}@MS_GITHUB_ASSET=${MS_GITHUB_ASSET}@MS_MAX_MINUTES=${MS_MAX_MINUTES:-55}@MS_GITHUB_STORE_TOKEN=${MS_GITHUB_STORE_TOKEN}@MS_GITHUB_CRAWL_TOKENS=${MS_OFFLOAD_CRAWL_TOKENS}"

gcloud run jobs execute "$job" --region "$GCP_REGION" --wait=false
