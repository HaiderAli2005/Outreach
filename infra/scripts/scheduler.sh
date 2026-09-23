#!/usr/bin/env bash
# Creates or updates one Cloud Scheduler job per background job in apps/api/src/jobs/registry.ts.
set -euo pipefail
PROJECT="${PROJECT:?set PROJECT}"
REGION="${REGION:-europe-west1}"
API_URL="${API_URL:?set API_URL, e.g. https://aperture-api-xxxx.a.run.app}"
JOBS_SECRET="${JOBS_SECRET:?set JOBS_SECRET to the same value the API uses}"
TZ_NAME="${TZ_NAME:-Etc/UTC}"

JOBS=(
  "send|*/30 * * * *"
  "blocklist|17 2 * * *"
  "reply-sync|*/5 * * * *"
  "auto-reply-dispatch|* * * * *"
  "sourcing|0 */2 * * *"
  "reverify|0 3 * * *"
  "batch-notify|0 */3 * * *"
  "report-daily|0 18 * * 1-5"
  "report-weekly|0 8 * * 1"
  "report-monthly|0 8 1 * *"
  "billing-sync|0 * * * *"
)

for entry in "${JOBS[@]}"; do
  name="${entry%%|*}"
  schedule="${entry#*|}"
  args=(--project "$PROJECT" --location "$REGION" --schedule "$schedule" --time-zone "$TZ_NAME"
    --uri "$API_URL/api/v1/jobs/$name/run" --http-method POST
    --headers "X-Jobs-Secret=$JOBS_SECRET,Content-Type=application/json" --attempt-deadline 900s)
  if gcloud scheduler jobs describe "aperture-$name" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "aperture-$name" "${args[@]}"
  else
    gcloud scheduler jobs create http "aperture-$name" "${args[@]}"
  fi
done
