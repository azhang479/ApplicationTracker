# Resume tailoring backend

All routes below require the dashboard owner's Google bearer token. Manage the
library in Settings, then use “Tailor resume” in an application's drawer or
“Track & tailor resume” in the Chrome popup. The `/tailor/:applicationId` page
keeps its URL through sign-in, saves edit decisions, and downloads the PDF.
Resumes and edit decisions live in Firestore; PDFs do not.

## Resume library

- `GET /api/resumes` returns an array of `{ id, label, tex, updatedAt }`, ordered by
  label then ID.
- `POST /api/resumes` accepts `{ "label": "SWE", "tex": "..." }`, returns the saved
  resume with status **201**.
- `PUT /api/resumes/:id` accepts the same complete body and returns the saved resume.
- `DELETE /api/resumes/:id` returns **204**.

Labels use 1–20 ASCII letters, digits or hyphens. Single-file LaTeX is limited to
200 KiB of UTF-8 and must contain `\begin{document}`. At most five resumes may be
stored; the limit is checked transactionally. These routes accept up to 2 MiB of
JSON so escaped LaTeX fits. Missing IDs return **404**; invalid input or a full
library returns **400**; oversized JSON returns **413**.

## Generate, review and save edits

`POST /api/applications/:id/tailor` accepts `{}` (or no body). Existing tailoring
is reused without calling Gemini. Use `{ "regenerate": true }` to replace it with
fresh pending decisions. No resumes returns **400**. If the job or chosen resume
changes while Gemini is working, **409** asks the caller to retry.

The response is a tailoring view:

```json
{
  "resumeId": "resume-id",
  "resumeLabel": "SWE",
  "reason": "Best fit for this role",
  "generatedAt": "2026-06-01T00:00:00.000Z",
  "baseMissing": false,
  "staleEditIds": [],
  "edits": [
    {
      "id": "edit-id",
      "find": "Built reliable services",
      "replace": "Developed reliable services",
      "reason": "Emphasize development",
      "state": "pending",
      "stale": false
    }
  ]
}
```

`GET /api/applications/:id/tailoring` returns this view without generating edits.
`Application.tailoring` stores the same base metadata and edits, without derived
`baseMissing`, `staleEditIds` or `stale` flags. Existing applications need no migration.

`PATCH /api/applications/:id/tailoring` accepts:

```json
{
  "edits": [{ "id": "edit-id", "state": "accepted", "replace": "Developed reliable services" }]
}
```

Either `state` or `replace` may be omitted. States are `pending`, `accepted` and
`rejected`. Replacements remain plain text in storage, including `& % $ # _`.
They are escaped only when applied. Backslashes, braces, carets and tildes are
rejected. Empty replacements are allowed. Duplicate/unknown edit IDs, invalid
states or replacements, and attempts to change `find` return **400**. Adding new
user-created edits is not implemented.

Generation uses temperature zero, a stable resume order, and conservative
instructions to reword existing facts, not invent qualifications. Unknown selected
resume IDs fall back to the first resume. Invalid and overlapping proposals are
dropped in their original order. Unique matches are checked only inside the
document body, excluding full-line and inline comments. Only accepted edits are
applied, from the last offset to the first; all other LaTeX is preserved.

Changing a base resume does not discard saved decisions. Missing/nonunique or
newly overlapping spans are skipped and flagged `stale` in views and downloads.
Deleting the base sets `baseMissing`; downloads return **400** until tailoring is
regenerated against an available resume.

## Download

`GET /api/applications/:id/resume.pdf` returns PDF bytes, with:

```text
Content-Type: application/pdf
Content-Disposition: attachment; filename="Austin_Zhang_Resume_SWE_JPMorganChaseCo.pdf"
X-Page-Count: 1
X-Stale-Edit-Ids: []
Cache-Control: no-store
```

Set `RESUME_FILENAME_PREFIX` to change `Austin_Zhang_Resume` (ASCII letters,
digits, underscores and hyphens). Company names are reduced to ASCII letters and
digits. Filenames are bounded and header-safe.

The compiler uses a fresh temporary directory, Tectonic `--untrusted` (shell
escape disabled), a 60-second timeout, a minimal subprocess environment, and
cleanup on success or failure. A compile failure returns **422** with
`{ "error": "Resume compilation failed", "log": "last twenty lines..." }`.
Log lines are bounded to 500 characters. Compilation requires Tectonic-compatible,
self-contained LaTeX; the service does not rewrite templates or supply attachments.

Docker pins the Linux x86-64 Tectonic **0.15.0** binary and verifies its archive
SHA-256. The common Jake-style packages in `server/fixtures/sample-resume.tex` are
compiled at build time into the `node` user's cache. Other packages may still be
downloaded if a template needs them. No compiler or package downloads occur for
the warmed sample. Local backend development also needs Tectonic 0.15.0 on PATH
and a populated cache; `TectonicCompiler` accepts an explicit binary path for tests.
