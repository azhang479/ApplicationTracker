# Set up your personal application tracker

You will deploy one Cloud Run service, connect your own Gmail account, and load a
Chrome extension. No TypeScript editing, local Node installation, Docker installation,
or database schema setup is needed. Allow about 30–45 minutes for the first setup.

## 1. Get a project and terminal ready

You need:

- A personal `@gmail.com` account. Only this owner's account can use the dashboard.
- A Google Cloud project **with billing enabled**. A dedicated project is simplest.
  Run these commands as its Owner (usually the person who created it), or ask your
  administrator for permission to enable APIs, create accounts, grant IAM roles,
  manage secrets, build images, and deploy Cloud Run. Organization policies that
  forbid public Cloud Run services will block this app's deployment.
- `gcloud`, Bash, Python 3, and Git. The easiest option is **Cloud Shell**, the
  terminal button near the top-right of the Google Cloud console: all are installed.
  Alternatively, [install the Google Cloud CLI](https://cloud.google.com/sdk/docs/install)
  on Linux/macOS (or use WSL on Windows), then open Bash and run `gcloud init` and
  `gcloud auth login`. You do not need service-account key files or local ADC login.

Billing is required even when usage fits free tiers. Expect infrastructure costs
of about $0/month at light personal usage, but **not a guaranteed $0 bill**: Gemini
on Vertex AI is usage-billed. Read the [cost section](#costs-and-limits) before starting.

Clone the project in your terminal (if you already have a clone, use that folder):

```bash
git clone https://github.com/azhang479/ApplicationTracker.git
cd ApplicationTracker
git switch devin/1793298928-application-tracker
```

Replace the two values below with your **project ID** (not its display name or
number) and your Gmail address. Keep this terminal open for the later steps.

```bash
export PROJECT_ID='your-project-id'
export OWNER_EMAIL='your.name@gmail.com'
export REGION='us-central1'
gcloud config set project "$PROJECT_ID"
gcloud auth list
```

Confirm the active account is allowed to administer that project. Choose REGION
before the first run: a Firestore database's location cannot be changed later.
`us-central1` is the tested default; other regions must support Cloud Run, Firestore,
Cloud Scheduler, and the chosen Vertex AI model.

### What is Firestore?

Firestore is Google's managed document database: think of a collection as a group
of named records, each with fields, rather than a BigQuery table you query with SQL.
This app creates collections and documents automatically when you start using it;
there is no schema to create and no always-running database server to manage.

### What is Pub/Sub, and why use it here?

Pub/Sub is a message delivery service between systems. Gmail publishes a small
"your mailbox changed" notification to a topic; a push subscription delivers that
notification to Cloud Run, so the app can read new messages without polling Gmail.
The notification itself does not contain your full email.

## 2. Run setup once to get your URL

From the repository folder:

```bash
bash infra/setup.sh
```

The script enables the required APIs, creates the `(default)` Firestore **Native**
database if needed, creates service accounts, stores secrets, creates the Gmail
topic, and deploys the root Dockerfile using Cloud Build. The first build may take
several minutes. If an API or IAM permission has just been enabled and Google
reports a propagation delay, wait a minute and re-run the same command.

At the end you will see your dashboard URL, for example:
`https://application-tracker-....us-central1.run.app`. Copy the actual URL into:

```bash
export URL='https://paste-your-actual-service-url.run.app'
```

**This first deployment is a bootstrap:** it uses an unusable OAuth placeholder
until you create your client. It is expected that sign-in does not work yet.
The script stops after deployment with console instructions and does not create
the push subscription or daily job until both OAuth values are provided.

Re-running is safe: the script reuses the database, accounts, topic, and extension
key; updates an existing subscription/job rather than duplicating them; and adds
an OAuth secret version only when its supplied value changes. It does not delete
your applications or reset an existing Gmail connection. Keep PROJECT_ID and REGION
the same on later runs. Resources with these names are reserved for this app:

| Resource                     | Name                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Cloud Run service            | `application-tracker`                                                              |
| Runtime account              | `application-tracker-runtime`                                                      |
| OIDC invoker account         | `application-tracker-invoker`                                                      |
| Source-build account         | `application-tracker-build`                                                        |
| Pub/Sub topic / subscription | `gmail-notifications` / `gmail-notifications-push`                                 |
| Scheduler job                | `application-tracker-daily`                                                        |
| Secret Manager secrets       | `application-tracker-extension-api-key`, `application-tracker-oauth-client-secret` |

Use a dedicated project if those names already belong to something else. An
existing Native database is reused in its original location; a Datastore-mode
database causes setup to stop rather than replace it.

## 3. Configure Google's consent screen

Select the same project in the console and open
[Google Auth Platform](https://console.cloud.google.com/auth/overview). The console
may call this **APIs & Services → OAuth consent screen** in the older layout.

1. Click **Get started** if prompted. Under **Branding**, give the app a name such
   as "My Application Tracker" and use your email for support and developer contact.
2. Under **Audience**, choose **External** (a personal Gmail account is not an
   organization's Internal user). While the app is in Testing, add your own Gmail
   address under **Test users**.
3. Under **Data Access → Add or remove scopes**, add
   `https://www.googleapis.com/auth/gmail.readonly`. If you see basic identity
   scopes (`openid`, email, profile), keep them for Google sign-in too. The app only
   requests read access to Gmail: it cannot send, delete, or change emails.
4. Under **Audience**, choose **Publish app → In production** and confirm. Older
   layouts put this button on the consent-screen page.

**Why publish?** In External **Testing** mode, refresh tokens with Gmail scopes
expire after **7 days**, so the tracker would stop reading new mail every week.
Publishing removes that testing-only expiry; you should reconnect Gmail after
changing from Testing to In production. Tokens can still be revoked or expire for
other reasons.

Publishing is not the same as Google's verification. Gmail's readonly scope is a
restricted scope. For this personal-only, single-user app, Google can show
**"Google hasn't verified this app"** when you first connect Gmail. On your own
app's consent screen, choose **Advanced → Go to [your app name] (unsafe)** (or
**Continue**), then grant access. You may see it again when reconnecting. Do not
use this bypass for an app you do not control. Personal use normally does not
require submitting a public app for verification, but Google policies, account
restrictions, and unverified-user limits still apply; public/multi-user distribution
would require revisiting verification and Gmail data policies.

## 4. Create a Web OAuth client

In **Google Auth Platform → Clients → Create client** (older layout:
**APIs & Services → Credentials → Create credentials → OAuth client ID**):

1. Application type: **Web application**. Name it "Application Tracker web".
2. Under **Authorized JavaScript origins**, paste your dashboard URL **only**, with
   no path and no trailing slash: the value of `$URL` above.
3. Under **Authorized redirect URIs**, paste that exact URL followed by
   `/auth/gmail/callback`.
4. Click **Create**, then copy the **Client ID** and **Client secret**. Save the
   secret privately if you want to redeploy later. Do not commit it or share it.

To print the two exact values you should paste into the console:

```bash
printf 'JavaScript origin: %s\nRedirect URI: %s/auth/gmail/callback\n' "$URL" "$URL"
```

Back in the same Bash terminal, paste the client ID below. Read the secret using
a hidden prompt so it is not saved in shell history (the characters will not echo):

```bash
export OAUTH_CLIENT_ID='paste-client-id.apps.googleusercontent.com'
read -r -s -p 'Paste OAuth client secret, then press Enter: ' OAUTH_CLIENT_SECRET
printf '\n'
export OAUTH_CLIENT_SECRET
bash infra/setup.sh
unset OAUTH_CLIENT_SECRET
```

On this second run the script deploys real OAuth settings, grants the invoker role,
and creates/updates the authenticated push subscription and Scheduler job. Pub/Sub's
OIDC audience is the **full** `$URL/pubsub/gmail` endpoint; Scheduler's audience is
the **full** `$URL/tasks/daily` endpoint. The daily job runs at **09:00 America/New_York**,
including daylight-saving changes. It renews Gmail's watch and marks idle Applied
applications Ghosted after 45 days.

The runtime uses Firestore, Vertex AI, and Secret Manager permissions. A separate
build account has `roles/run.builder`; the separate invoker account identifies
trusted push and Scheduler calls. The script configures the Google-managed service
agents needed to mint their OIDC tokens. The public Cloud Run service is intentional:
the static dashboard and OAuth callback must be public, while the server verifies
your Google token, the extension key, or the push OIDC token on protected endpoints.

## 5. Sign in and connect Gmail

1. Open the printed dashboard URL in Chrome.
2. Sign in with exactly the Gmail address you set in OWNER_EMAIL. Other accounts
   are rejected. When your dashboard ID token expires, sign in again.
3. Go to **Settings → Connect Gmail**. Choose that same account, review the
   readonly scope, handle your own unverified-app warning as described above, and
   allow access. You will return to the dashboard.
4. Settings should show **Connected** and a future watch-expiry date. You can
   confirm the scheduled job in **Cloud Scheduler** in your selected region.

Only new mail is tracked; connecting Gmail does **not** import your inbox history.
When a history cursor expires, recovery only lists messages after the last
successful notification sync. If there is no previous sync timestamp, it resets
the cursor without processing old mail. Watch notifications are for INBOX changes.

## 6. Install the Chrome extension

If you deployed from Cloud Shell, download the repository folder to your own
computer first (or clone the same branch locally). The extension runs on your
computer's Chrome, **not inside Cloud Shell**.

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select the repository's **`extension/` folder**,
   not the repository root. No build step is needed.
3. Open the extension's **Details → Extension options**, or click **Settings** in
   its popup.
4. Paste your dashboard URL into **Dashboard address**.
5. Run the `gcloud secrets versions access ...` command printed by setup to reveal
   your extension API key in your private terminal. Paste that value into
   **API key** and click **Save settings**. The script itself never prints the key.
   Anyone with this key can submit job captures; do not share it or its terminal output.
6. Open a real job posting, click the extension, then **Track this job**. Keep the
   popup open while it says **Extracting… (can take ~10s)**. The result shows company,
   title, and salary, or **Already tracked**. **Open dashboard** opens your list.

Chrome closes the popup if you click away, which can interrupt extraction; retrying
is safe because captures deduplicate by URL or company/job ID. Only Cloud Run HTTPS
addresses (`*.run.app`) and `http://localhost:8080` are permitted. The key is saved
in your Chrome profile's `chrome.storage.sync`; protect that profile too.

In the dashboard, use status chips and company/title search to filter applications.
Click a row to edit its job fields, status, or dates and see its email timeline.
System IDs, creation/update timestamps, and timeline entries are read-only.
**Needs review** lets you apply uncertain mail to a suggested application, create
a new one, or dismiss it.

## 7. View your data in Firestore

In the same project, open **Firestore → Databases → (default) → Data**. Depending
on the console layout, click the database name first. Collections appear only
after the corresponding action has stored something:

- `applications`: saved jobs, statuses, and timeline entries.
- `reviewItems`: ambiguous mail matches (including resolved items).
- `processedEmails`: Gmail message IDs used to avoid duplicate processing.
- `config` → document `gmail`: watch expiry, cursor, last-sync timestamp, and the
  **sensitive Gmail refresh token**. Do not copy, screenshot, or share this document.

The server uses Firestore IAM, not public browser database access. Do not enable
public Firestore rules or grant `allUsers` database access. Use the dashboard for
edits instead of changing documents manually. Email bodies are sent to Vertex AI
for classification but are not persisted; stored email details are subject, sender,
date (on reviews), a snippet of about 300 characters, and a Gmail link.

## Troubleshooting

### Setup reports permissions or API errors

Check `gcloud auth list`, PROJECT_ID, billing, and that your account is project Owner
or has equivalent setup permissions. An initial IAM change can take a short time
to propagate; wait and re-run. The script stops on failed commands instead of
treating permission errors as "resource missing." It does not replace a non-Native
database or a subscription pointing at another topic. Do not delete an existing
database to fix this: use a new project if needed.

### Google sign-in or Gmail connection fails

- `redirect_uri_mismatch`: copy the exact `/auth/gmail/callback` URL from setup to
  the **Web** client; check project, HTTPS, path, and trailing slash.
- Origin error: add the exact dashboard origin under Authorized JavaScript origins.
  Changes can take several minutes to propagate.
- Access denied: check OWNER_EMAIL, External audience, your test user, and the
  requested Gmail scope. Use the same account for dashboard sign-in and Gmail.
- If you are still on the bootstrap deployment, complete steps 3–4 and re-run with
  **both** client variables. An OAuth secret is stored in Secret Manager, never in code.
- A 401 from the dashboard clears its session; sign in again. An expired dashboard
  session is separate from the stored Gmail refresh token.

### Pub/Sub push errors or missing email updates

First check Settings shows Gmail connected, then open **Pub/Sub → Subscriptions →
gmail-notifications-push → Metrics** for delivery errors. Read Cloud Run logs:

```bash
gcloud run services logs read application-tracker \
  --project="$PROJECT_ID" --region="$REGION" --limit=100
```

Or use **Cloud Run → application-tracker → Logs** / Logs Explorer. For HTTP errors:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="application-tracker" AND httpRequest.status>=400' \
  --project="$PROJECT_ID" --freshness=1d --limit=50
```

- 401/403 on `/pubsub/gmail`: verify the push account is
  `application-tracker-invoker@PROJECT_ID.iam.gserviceaccount.com`, and the audience
  is the full endpoint URL, not just the origin. Re-run setup with both OAuth
  variables to restore IAM and push settings. Do not remove application-level auth.
- 503: Pub/Sub retries with 10-second to 10-minute backoff. Check Vertex API/model
  availability, quota, Firestore permissions, and runtime logs. The subscription has
  a 60-second acknowledgment deadline and the normal 7-day message retention; no
  dead-letter queue is configured. Persistent failures need attention before
  retention expires.
- Permanent Gmail notification errors may be logged and acknowledged (2xx) to
  avoid endless retries. Look for `Gmail notification requires owner attention:` in logs;
  a successful HTTP push does not always mean Gmail access is healthy.
- Not every email changes a status: a keyword prefilter avoids irrelevant mail;
  ambiguous matches appear in **Needs review**, and Withdrawn jobs are excluded.

### Watch expired, or Gmail stopped updating

The Gmail watch lasts about seven days. **Cloud Scheduler → application-tracker-daily**
should show daily successes. Choose **Force run** (or **Run now**) to test renewal,
then refresh dashboard Settings to check the expiry moved forward. Make sure you
selected the configured region and that the job is not paused.

For Scheduler 401/403 errors, its OIDC audience must be the full `$URL/tasks/daily`
URL. Re-running setup restores the service agent and invoker settings. If logs show
`invalid_grant`, the refresh token was revoked/expired: publish the OAuth app to
In production if needed, then go to dashboard **Settings → Connect Gmail** again.
Reconnecting is also the recovery step after changing OAuth clients. There is no
historical inbox import to repair missed old messages; reconcile those manually.

### Redeploy after a code change

From the same checkout, get the latest code. Restore PROJECT_ID, OWNER_EMAIL, and
the same REGION if this is a new terminal, then run:

```bash
git pull --ff-only
bash infra/setup.sh
```

On an already configured service this preserves the existing client ID and secret,
deploys code, and updates PUBLIC_URL if necessary. Without both OAuth inputs it
prints the OAuth checklist and stops before touching existing push/Scheduler
resources; they remain in place. To reapply **all** infrastructure settings, also
set OAUTH_CLIENT_ID and use the hidden secret prompt from step 4 before running.
The script pins the enabled secret version used by each deployment. New OAuth
values create a new version; the extension key is never regenerated on re-runs.
If all versions of a secret were disabled/destroyed, setup stops for you to restore
one instead of silently replacing it.

If the service URL actually changed (for example, a different project/region),
update both OAuth URLs in the console and your extension options, then run full
setup again and reconnect Gmail. After extension code changes, click **Reload** on
its card in `chrome://extensions`.

## Costs and limits

- **Billing must stay enabled.** Set a small budget alert in **Billing → Budgets &
  alerts** (for example $5/month). Alerts are not a hard spending cap.
- At light single-owner usage, Cloud Run (minimum zero instances), Firestore,
  Pub/Sub, one Scheduler job, Secret Manager, and build usage can fit free tiers:
  **about $0/month for infrastructure** is a reasonable target, not a promise.
  Free quotas may be shared with other projects on your billing account.
- **Vertex Gemini Flash is metered** for input/output tokens on Vertex AI. Even
  personal use can create a small nonzero bill, and heavy capture/email traffic
  costs more. This is not the consumer Gemini or AI Studio free tier. Each capture
  can send up to about 40,000 characters; relevant new mail also uses Gemini.
- Source builds store images in **Artifact Registry → cloud-run-source-deploy**.
  Repeated deployments can accumulate billable storage. Remove old unused images
  or configure a cleanup policy there; do not delete the currently deployed image.
  Logs and additional active secret versions can also exceed free allocations.
- The script caps Cloud Run at two instances, but this is not a cost cap and does
  not cap Vertex tokens. It uses the default Flash model and 45-day ghosting period.
  If you change those settings manually, a later setup run restores those defaults.
- This is a personal tracker, not a high-volume service. Firestore transactions
  read the small application/review collections; matching prefers an exact job ID,
  otherwise company/title similarity. Multiple candidates need a title similarity
  of at least 0.6 and a 0.2 lead to be auto-matched.

Check current prices for [Cloud Run](https://cloud.google.com/run/pricing),
[Firestore](https://cloud.google.com/firestore/pricing),
[Pub/Sub](https://cloud.google.com/pubsub/pricing),
[Scheduler](https://cloud.google.com/scheduler/pricing),
[Secret Manager](https://cloud.google.com/secret-manager/pricing),
[Cloud Build](https://cloud.google.com/build/pricing),
[Artifact Registry](https://cloud.google.com/artifact-registry/pricing), and
[Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/pricing).

To stop permanently, disconnect this app in your Google Account's third-party
connections, then remove its Scheduler job, push subscription, and Cloud Run service.
For a **dedicated** project you no longer need, deleting the project removes its
remaining database, images, secrets, and accounts too. This is irreversible after
Google's recovery window: export anything you need first. No automatic teardown
script is included to avoid accidental loss of your applications or shared data.

## Optional: developer checks

The owner does not need these to deploy. Contributors can use Node 20 with `npm ci`,
then `npm run typecheck`, `npm test`, and `npm run build`. `npm run format` uses
Prettier with single quotes and 100-column output. Infrastructure checks are
`bash -n infra/setup.sh`, `shellcheck infra/setup.sh` (if installed), and
`python3 infra/test_setup.py` (fake gcloud; no Google Cloud calls).
