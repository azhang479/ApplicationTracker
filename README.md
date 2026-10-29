# ApplicationTracker

A personal job-application tracker for one Gmail owner, hosted on Google Cloud.
Save job postings with an unpacked Chrome extension; Gemini extracts the details.
Gmail updates application statuses, and uncertain matches go to a review list.

The dashboard and API run together on Cloud Run, with Firestore for storage and
Pub/Sub for Gmail notifications. You do not need to edit TypeScript to use it.

**Start here: [beginner setup walkthrough](docs/SETUP.md).** It covers deployment,
Google sign-in, connecting Gmail, installing the extension, costs, and troubleshooting.
