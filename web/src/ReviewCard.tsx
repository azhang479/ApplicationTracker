import { useId, useState } from 'react';
import {
  Application,
  Review,
  Status,
  statuses,
  defaultStatus,
  categoryName,
  formatDate,
} from './types';
import { blankJob, JobFields } from './JobFields';
import { reviewApplications } from './review';

export function ReviewCard({
  item,
  applications,
  resolve,
}: {
  item: Review;
  applications: Application[];
  resolve: (id: string, action: object) => Promise<void>;
}) {
  const id = useId();
  const { bestMatches, others } = reviewApplications(applications, item.candidates);
  const [applicationId, setApplicationId] = useState(bestMatches[0]?.id || '');
  const [status, setStatus] = useState<Status>(defaultStatus(item.classification.category));
  const selectedApplicationId = applications.some((app) => app.id === applicationId)
    ? applicationId
    : '';
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
        {bestMatches.length === 0 && (
          <p className="text-sm text-slate-500 mb-5">
            {applications.length === 0
              ? 'No applications yet. Create a new one below.'
              : 'No suggested matches. Choose an application or create a new one below.'}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] items-end bg-white border rounded-lg p-4">
          <div className="min-w-0">
            <label htmlFor={id + '-application'}>Application</label>
            <select
              id={id + '-application'}
              value={selectedApplicationId}
              disabled={busy || applications.length === 0}
              onChange={(e) => setApplicationId(e.target.value)}
            >
              <option value="" disabled>
                Select an application…
              </option>
              {bestMatches.length > 0 && (
                <optgroup label="Best matches">
                  {bestMatches.map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.company} — {app.title} (score: {app.score.toFixed(2)})
                    </option>
                  ))}
                </optgroup>
              )}
              {others.length > 0 && (
                <optgroup label="All applications">
                  {others.map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.company} — {app.title}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div>
            <label htmlFor={id + '-status'}>Status</label>
            <select
              id={id + '-status'}
              value={status}
              disabled={busy}
              onChange={(e) => setStatus(e.target.value as Status)}
            >
              {statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <button
            className="primary-button"
            disabled={busy || !selectedApplicationId}
            onClick={() =>
              void act({ type: 'apply', applicationId: selectedApplicationId, status })
            }
          >
            Apply
          </button>
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
