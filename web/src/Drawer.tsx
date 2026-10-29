import { useEffect, useRef, useState } from 'react';
import { JobFields } from './JobFields';
import { Application, Job, Status, statuses, formatDate } from './types';

export function Drawer({
  app,
  close,
  save,
  remove,
}: {
  app: Application;
  close: () => void;
  save: (
    id: string,
    fields: Job & { status: Status; appliedAt: string; lastActivityAt: string },
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [job, setJob] = useState<Job>({
    company: app.company,
    title: app.title,
    jobId: app.jobId,
    url: app.url,
    location: app.location,
    workMode: app.workMode,
    salaryMin: app.salaryMin,
    salaryMax: app.salaryMax,
    salaryCurrency: app.salaryCurrency,
    salaryPeriod: app.salaryPeriod,
    salaryIsEstimated: app.salaryIsEstimated,
    jobSummary: app.jobSummary,
    keyRequirements: app.keyRequirements,
  });
  const [status, setStatus] = useState(app.status);
  const localDate = (value: string) => {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const [applied, setApplied] = useState(localDate(app.appliedAt));
  const [activity, setActivity] = useState(localDate(app.lastActivityAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your changes.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog ref={dialog} className="drawer" onCancel={close} aria-labelledby="drawer-title">
      <form
        className="flex h-full flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void action(() =>
            save(app.id, {
              ...job,
              keyRequirements: job.keyRequirements.filter(Boolean),
              status,
              appliedAt: new Date(applied).toISOString(),
              lastActivityAt: new Date(activity).toISOString(),
            }),
          );
        }}
      >
        <header className="px-7 py-6 border-b flex items-start justify-between">
          <div>
            <p className="eyebrow mb-2">APPLICATION DETAILS</p>
            <h2 id="drawer-title" className="text-xl font-semibold">
              {app.company}
            </h2>
            <p className="text-sm text-slate-500 mt-1">{app.title}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close application details"
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className="overflow-y-auto p-7 space-y-6 flex-1">
          <label>
            Application status
            <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              {statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <JobFields value={job} onChange={setJob} />
          <div className="grid grid-cols-2 gap-4">
            <label>
              Date applied
              <input
                required
                type="datetime-local"
                value={applied}
                onChange={(e) => setApplied(e.target.value)}
              />
            </label>
            <label>
              Last activity
              <input
                required
                type="datetime-local"
                value={activity}
                onChange={(e) => setActivity(e.target.value)}
              />
            </label>
          </div>
          <section className="border-t pt-6">
            <h3 className="font-semibold mb-5">Activity timeline</h3>
            <ol className="space-y-5 border-l ml-2 pl-5">
              {[...app.events].reverse().map((event, i) => (
                <li key={i} className="relative text-sm">
                  <span className="absolute -left-[25px] top-1 w-2 h-2 rounded-full bg-slate-400 ring-4 ring-white" />
                  <p className="font-medium capitalize">
                    {event.type.replaceAll('_', ' ')}
                    {event.status && ' · ' + event.status}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">{formatDate(event.at)}</p>
                  {event.emailSubject && <p className="mt-2">{event.emailSubject}</p>}
                  {event.emailFrom && <p className="text-xs text-slate-500">{event.emailFrom}</p>}
                  {event.snippet && <p className="text-slate-500 mt-1">{event.snippet}</p>}
                  {event.gmailLink && (
                    <a
                      className="link text-xs inline-block mt-2"
                      href={event.gmailLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Read email ↗
                    </a>
                  )}
                </li>
              ))}
            </ol>
          </section>
          <p className="text-xs text-slate-400">
            Created {formatDate(app.createdAt)} · Updated {formatDate(app.updatedAt)}
            <br />
            Record ID: {app.id}
          </p>
        </div>
        <footer className="border-t bg-white p-5 px-7">
          {error && (
            <p role="alert" className="text-sm text-rose-700 mb-3">
              {error}
            </p>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => {
                if (confirm('Delete this application? This cannot be undone.'))
                  void action(() => remove(app.id));
              }}
            >
              Delete application
            </button>
            <button className="primary-button" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
