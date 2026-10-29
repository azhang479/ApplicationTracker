import { useState } from 'react';
import { Review, Status, statuses, defaultStatus, categoryName, formatDate } from './types';
import { blankJob, JobFields } from './JobFields';

export function ReviewCard({
  item,
  resolve,
}: {
  item: Review;
  resolve: (id: string, action: object) => Promise<void>;
}) {
  const [choices, setChoices] = useState<Record<string, Status>>({});
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState({
    ...blankJob,
    company: item.classification.company,
    title: item.classification.title,
    jobId: item.classification.jobId,
    jobSummary: item.classification.summary,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(action: object) {
    setBusy(true);
    setError('');
    try {
      await resolve(item.id, action);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update this item.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="card overflow-hidden">
      <div className="p-6">
        <div className="flex justify-between items-start gap-4">
          <div className="flex gap-4">
            <div className="h-10 w-10 grid place-items-center rounded-lg border text-slate-500 bg-slate-50 shrink-0">
              ✉
            </div>
            <div>
              <h2 className="font-semibold">{item.email.subject || 'No subject'}</h2>
              <p className="text-sm text-slate-500 mt-1">
                {item.email.from} <span className="mx-2 text-slate-300">·</span>{' '}
                {formatDate(item.email.date)}
              </p>
            </div>
          </div>
          <a
            className="link text-sm shrink-0"
            href={item.email.gmailLink}
            target="_blank"
            rel="noreferrer"
          >
            Open in Gmail ↗
          </a>
        </div>
        <p className="text-sm leading-relaxed text-slate-600 mt-5">{item.email.snippet}</p>
        <div className="bg-slate-50 rounded-lg border border-slate-100 px-4 py-3 mt-5 text-sm flex flex-wrap gap-x-6 gap-y-2">
          <span className="text-slate-400 text-xs font-medium uppercase tracking-wide self-center">
            Detected update
          </span>
          <span className="font-medium">{categoryName(item.classification.category)}</span>
          <span className="text-slate-500">
            {item.classification.company || 'Company not identified'} ·{' '}
            {item.classification.title || 'Role not identified'}
          </span>
        </div>
      </div>
      <div className="border-t p-6 bg-slate-50/40">
        <h3 className="eyebrow mb-4">WHICH APPLICATION IS THIS FOR?</h3>
        {item.candidates.length === 0 && (
          <p className="text-sm text-slate-500 mb-5">
            No matching applications found. You can create a new one below.
          </p>
        )}
        <div className="space-y-3">
          {item.candidates.map((candidate) => (
            <div
              key={candidate.applicationId}
              className="flex flex-wrap items-center gap-3 bg-white border rounded-lg p-4"
            >
              <div className="flex-1 min-w-40">
                <p className="text-sm font-semibold">{candidate.company}</p>
                <p className="text-sm text-slate-500 mt-1">{candidate.title}</p>
                <p className="text-xs text-slate-400 mt-1">
                  Match score: {candidate.score.toFixed(2)}
                </p>
              </div>
              <select
                className="!w-auto !mt-0 text-sm"
                aria-label={'New status for ' + candidate.company + ' ' + candidate.title}
                value={
                  choices[candidate.applicationId] || defaultStatus(item.classification.category)
                }
                onChange={(e) =>
                  setChoices({ ...choices, [candidate.applicationId]: e.target.value as Status })
                }
              >
                {statuses.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void act({
                    type: 'apply',
                    applicationId: candidate.applicationId,
                    status:
                      choices[candidate.applicationId] ||
                      defaultStatus(item.classification.category),
                  })
                }
              >
                Apply to this
              </button>
            </div>
          ))}
        </div>
        <div className="flex justify-between items-center mt-5">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => setCreating(!creating)}
          >
            {creating ? 'Cancel new application' : '+ Create new application'}
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void act({ type: 'dismiss' })}
          >
            Dismiss
          </button>
        </div>
        {creating && (
          <form
            className="bg-white border rounded-lg p-5 mt-5 max-w-2xl"
            onSubmit={(e) => {
              e.preventDefault();
              void act({
                type: 'create',
                fields: { ...job, keyRequirements: job.keyRequirements.filter(Boolean) },
              });
            }}
          >
            <h3 className="font-semibold mb-5">Create an application from this email</h3>
            <JobFields value={job} onChange={setJob} />
            <button className="primary-button mt-5" disabled={busy}>
              {busy ? 'Creating…' : 'Create application'}
            </button>
          </form>
        )}
        {busy && (
          <p role="status" className="text-sm text-slate-500 mt-3">
            Updating application…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose-700 mt-3">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
