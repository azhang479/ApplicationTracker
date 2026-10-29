#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to your billing-enabled Google Cloud project ID}"
: "${OWNER_EMAIL:?Set OWNER_EMAIL to your personal Gmail address}"
REGION="${REGION:-us-central1}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash-lite}"
GEMINI_LOCATION="${GEMINI_LOCATION:-global}"
OAUTH_CLIENT_ID="${OAUTH_CLIENT_ID:-}"
OAUTH_CLIENT_SECRET="${OAUTH_CLIENT_SECRET:-}"
OAUTH_READY=false
if [[ -n "$OAUTH_CLIENT_ID" && -n "$OAUTH_CLIENT_SECRET" ]]; then
  OAUTH_READY=true
fi

for tool in gcloud python3; do
  command -v "$tool" >/dev/null || { printf 'Install %s before continuing.\n' "$tool" >&2; exit 1; }
done
for value in "$PROJECT_ID" "$OWNER_EMAIL" "$REGION" "$OAUTH_CLIENT_ID" "$GEMINI_MODEL" "$GEMINI_LOCATION"; do
  if [[ "$value" == *'|'* || "$value" == *$'\n'* ]]; then
    printf 'Inputs must not contain a pipe character or newline.\n' >&2
    exit 1
  fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
GCLOUD=(gcloud --project="$PROJECT_ID" --quiet)
SERVICE=application-tracker
RUNTIME="application-tracker-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
INVOKER="application-tracker-invoker@${PROJECT_ID}.iam.gserviceaccount.com"
BUILDER="application-tracker-build@${PROJECT_ID}.iam.gserviceaccount.com"
KEY_SECRET=application-tracker-extension-api-key
OAUTH_SECRET=application-tracker-oauth-client-secret
TOPIC="projects/$PROJECT_ID/topics/gmail-notifications"
SUBSCRIPTION=gmail-notifications-push
JOB=application-tracker-daily

printf 'Enabling APIs in %s...\n' "$PROJECT_ID"
"${GCLOUD[@]}" services enable run.googleapis.com firestore.googleapis.com \
  pubsub.googleapis.com cloudscheduler.googleapis.com gmail.googleapis.com \
  aiplatform.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com
PROJECT_NUMBER="$("${GCLOUD[@]}" projects describe "$PROJECT_ID" --format='value(projectNumber)')"

DATABASES="$("${GCLOUD[@]}" firestore databases list --format='value(name)')"
if [[ "$DATABASES" != *'/databases/(default)'* ]]; then
  "${GCLOUD[@]}" firestore databases create --database='(default)' --location="$REGION" --type=firestore-native
fi
DB_TYPE="$("${GCLOUD[@]}" firestore databases describe --database='(default)' --format='value(type)')"
if [[ "$DB_TYPE" != FIRESTORE_NATIVE ]]; then
  printf 'The existing (default) database is not Firestore Native. Use a new project; no database was replaced.\n' >&2
  exit 1
fi

create_account() {
  local email="$1" name="$2" found
  found="$("${GCLOUD[@]}" iam service-accounts list --filter="email=$email" --format='value(email)')"
  if [[ -z "$found" ]]; then
    "${GCLOUD[@]}" iam service-accounts create "$name" --display-name="$name"
  fi
}
grant_role() {
  "${GCLOUD[@]}" projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$1" --role="$2" --condition=None >/dev/null
}
create_account "$RUNTIME" application-tracker-runtime
create_account "$INVOKER" application-tracker-invoker
create_account "$BUILDER" application-tracker-build
grant_role "$RUNTIME" roles/datastore.user
grant_role "$RUNTIME" roles/aiplatform.user
grant_role "$RUNTIME" roles/secretmanager.secretAccessor
grant_role "$BUILDER" roles/run.builder

# Only initialize an empty secret; never replace an existing extension key.
ensure_secret() {
  local name="$1" initial="${2:-}" found versions
  found="$("${GCLOUD[@]}" secrets list --filter="name~'/secrets/$name$'" --format='value(name)')"
  if [[ -z "$found" ]]; then
    "${GCLOUD[@]}" secrets create "$name" --replication-policy=automatic >/dev/null
  fi
  versions="$("${GCLOUD[@]}" secrets versions list "$name" --format='value(name)')"
  if [[ -z "$versions" ]]; then
    if [[ -n "$initial" ]]; then
      printf '%s' "$initial" | "${GCLOUD[@]}" secrets versions add "$name" --data-file=- >/dev/null
    else
      python3 -c 'import secrets; print(secrets.token_urlsafe(48), end="")' |
        "${GCLOUD[@]}" secrets versions add "$name" --data-file=- >/dev/null
    fi
  fi
}
secret_version() {
  local version
  version="$("${GCLOUD[@]}" secrets versions list "$1" --filter='state=ENABLED' \
    --sort-by='~createTime' --limit=1 --format='value(name)')"
  if [[ -z "$version" ]]; then
    printf 'Secret %s has no enabled version. Restore it in Secret Manager before re-running.\n' "$1" >&2
    return 1
  fi
  printf '%s' "${version##*/}"
}
ensure_secret "$KEY_SECRET"
KEY_VERSION="$(secret_version "$KEY_SECRET")"
ensure_secret "$OAUTH_SECRET" "$OAUTH_CLIENT_SECRET"
OAUTH_VERSION="$(secret_version "$OAUTH_SECRET")"
if [[ -n "$OAUTH_CLIENT_SECRET" ]]; then
  CURRENT_SECRET="$("${GCLOUD[@]}" secrets versions access "$OAUTH_VERSION" --secret="$OAUTH_SECRET")"
  if [[ "$CURRENT_SECRET" != "$OAUTH_CLIENT_SECRET" ]]; then
    printf '%s' "$OAUTH_CLIENT_SECRET" |
      "${GCLOUD[@]}" secrets versions add "$OAUTH_SECRET" --data-file=- >/dev/null
    OAUTH_VERSION="$(secret_version "$OAUTH_SECRET")"
  fi
  unset CURRENT_SECRET
fi
unset OAUTH_CLIENT_SECRET

TOPICS="$("${GCLOUD[@]}" pubsub topics list --filter="name=$TOPIC" --format='value(name)')"
if [[ -z "$TOPICS" ]]; then
  "${GCLOUD[@]}" pubsub topics create gmail-notifications
fi
"${GCLOUD[@]}" pubsub topics add-iam-policy-binding "$TOPIC" \
  --member='serviceAccount:gmail-api-push@system.gserviceaccount.com' --role=roles/pubsub.publisher >/dev/null

# Reuse the URL and client ID on subsequent deployments, even without OAuth inputs.
SERVICES="$("${GCLOUD[@]}" run services list --region="$REGION" --filter="metadata.name=$SERVICE" --format='value(metadata.name)')"
PUBLIC_URL=https://setup.invalid
CLIENT_ID="${OAUTH_CLIENT_ID:-setup-required}"
if [[ -n "$SERVICES" ]]; then
  SERVICE_JSON="$("${GCLOUD[@]}" run services describe "$SERVICE" --region="$REGION" --format=json)"
  PUBLIC_URL="$(printf '%s' "$SERVICE_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"]["url"])')"
  if [[ -z "$OAUTH_CLIENT_ID" ]]; then
    CLIENT_ID="$(printf '%s' "$SERVICE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((e.get("value", "setup-required") for e in d["spec"]["template"]["spec"]["containers"][0].get("env", []) if e["name"] == "OAUTH_CLIENT_ID"), "setup-required"))')"
  fi
fi
"${GCLOUD[@]}" run deploy "$SERVICE" --source=. --region="$REGION" \
  --service-account="$RUNTIME" \
  --build-service-account="projects/$PROJECT_ID/serviceAccounts/$BUILDER" \
  --allow-unauthenticated --min-instances=0 --max-instances=2 --memory=512Mi --cpu=1 --timeout=300s \
  --update-env-vars="^|^GOOGLE_CLOUD_PROJECT=$PROJECT_ID|GCP_LOCATION=$REGION|GEMINI_LOCATION=$GEMINI_LOCATION|OWNER_EMAIL=$OWNER_EMAIL|OAUTH_CLIENT_ID=$CLIENT_ID|PUBLIC_URL=$PUBLIC_URL|PUBSUB_TOPIC=$TOPIC|PUSH_SERVICE_ACCOUNT=$INVOKER|GEMINI_MODEL=$GEMINI_MODEL|GHOSTED_AFTER_DAYS=45" \
  --update-secrets="EXTENSION_API_KEY=$KEY_SECRET:$KEY_VERSION,OAUTH_CLIENT_SECRET=$OAUTH_SECRET:$OAUTH_VERSION"
URL="$("${GCLOUD[@]}" run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
if [[ "$PUBLIC_URL" != "$URL" ]]; then
  "${GCLOUD[@]}" run services update "$SERVICE" --region="$REGION" --update-env-vars="PUBLIC_URL=$URL"
fi

print_access() {
  printf '\nDashboard: %s\n' "$URL"
  printf 'Print your extension API key privately (do not share its output):\n'
  printf 'gcloud secrets versions access %s --secret=%s --project=%s\n' "$KEY_VERSION" "$KEY_SECRET" "$PROJECT_ID"
}
if [[ "$OAUTH_READY" != true ]]; then
  printf '\nDeployment is ready for OAuth setup; sign-in is not ready on the first run.\n'
  printf 'Open https://console.cloud.google.com/auth/overview?project=%s\n' "$PROJECT_ID"
  printf '1. Google Auth Platform > Branding: create an app name and choose your support/contact email.\n'
  printf '2. Audience: choose External, add %s as a test user, then Publish app > In production.\n' "$OWNER_EMAIL"
  printf '3. Data Access: add https://www.googleapis.com/auth/gmail.readonly.\n'
  printf '4. Clients > Create client > Web application. Use these exact values:\n'
  printf '   Authorized JavaScript origin: %s\n' "$URL"
  printf '   Authorized redirect URI: %s/auth/gmail/callback\n' "$URL"
  printf '5. Re-run this script with BOTH OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET set.\n'
  printf 'See docs/SETUP.md for copy-paste commands. Push and Scheduler setup is deferred until then.\n'
  print_access
  exit 0
fi

"${GCLOUD[@]}" run services add-iam-policy-binding "$SERVICE" --region="$REGION" \
  --member="serviceAccount:$INVOKER" --role=roles/run.invoker >/dev/null
"${GCLOUD[@]}" beta services identity create --service=pubsub.googleapis.com >/dev/null
"${GCLOUD[@]}" beta services identity create --service=cloudscheduler.googleapis.com >/dev/null
PUBSUB_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"
SCHEDULER_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
grant_role "$PUBSUB_AGENT" roles/pubsub.serviceAgent
grant_role "$SCHEDULER_AGENT" roles/cloudscheduler.serviceAgent
"${GCLOUD[@]}" iam service-accounts add-iam-policy-binding "$INVOKER" \
  --member="serviceAccount:$PUBSUB_AGENT" --role=roles/iam.serviceAccountTokenCreator >/dev/null

SUBSCRIPTIONS="$("${GCLOUD[@]}" pubsub subscriptions list \
  --filter="name=projects/$PROJECT_ID/subscriptions/$SUBSCRIPTION" --format='value(name)')"
SUB_COMMAND=create
if [[ -n "$SUBSCRIPTIONS" ]]; then
  EXISTING_TOPIC="$("${GCLOUD[@]}" pubsub subscriptions describe "$SUBSCRIPTION" --format='value(topic)')"
  if [[ "$EXISTING_TOPIC" != "$TOPIC" ]]; then
    printf 'Subscription %s already uses another topic. Rename it or use a dedicated project.\n' "$SUBSCRIPTION" >&2
    exit 1
  fi
  SUB_COMMAND=update
fi
SUB_ARGS=()
if [[ "$SUB_COMMAND" == create ]]; then
  SUB_ARGS+=(--topic="$TOPIC")
fi
"${GCLOUD[@]}" pubsub subscriptions "$SUB_COMMAND" "$SUBSCRIPTION" "${SUB_ARGS[@]}" \
  --push-endpoint="$URL/pubsub/gmail" --push-auth-service-account="$INVOKER" \
  --push-auth-token-audience="$URL/pubsub/gmail" --ack-deadline=60 \
  --min-retry-delay=10s --max-retry-delay=600s --expiration-period=never

JOBS="$("${GCLOUD[@]}" scheduler jobs list --location="$REGION" --filter="name=projects/$PROJECT_ID/locations/$REGION/jobs/$JOB" --format='value(name)')"
JOB_COMMAND=create
if [[ -n "$JOBS" ]]; then
  JOB_COMMAND=update
fi
"${GCLOUD[@]}" scheduler jobs "$JOB_COMMAND" http "$JOB" --location="$REGION" \
  --schedule='0 9 * * *' --time-zone=America/New_York --http-method=POST \
  --uri="$URL/tasks/daily" --oidc-service-account-email="$INVOKER" \
  --oidc-token-audience="$URL/tasks/daily" --attempt-deadline=320s \
  --max-retry-attempts=3 --min-backoff=10s --max-backoff=600s

printf '\nSetup complete. Open the dashboard, sign in as %s, then Settings > Connect Gmail.\n' "$OWNER_EMAIL"
print_access
