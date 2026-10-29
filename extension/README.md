# Chrome extension

There is no build step. In Chrome, open chrome://extensions, enable Developer
mode, choose **Load unpacked**, and select the repo's **extension/** folder.
Open the extension's Settings page and save the Cloud Run address and API key.
For local testing the supported address is http://localhost:8080.

Open a job posting, click the extension, then **Track this job**. Keep the popup
open until extraction finishes (usually about 10 seconds). Chrome closes popups
when you click away, which can interrupt the request; retrying is safe because
capture deduplicates jobs. **Open dashboard** opens your workspace in a new tab.

The key is stored in chrome.storage.sync in your own Chrome profile. Do not share
your Chrome profile or API key. Only Cloud Run and localhost:8080 have host access.
