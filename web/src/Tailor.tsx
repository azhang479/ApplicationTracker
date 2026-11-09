import { useEffect, useState } from 'react';
import { replacementSchema } from '../../server/src/resume-domain';
import {
  editContext,
  keywordCoverage,
  type Api,
  type Resume,
  type TailoringView,
} from './tailoring';
import type { Application } from './types';

type Change = { id: string; state?: 'pending' | 'accepted' | 'rejected'; replace?: string };
function EditCard({
  edit,
  tex,
  busy,
  save,
}: {
  edit: TailoringView['edits'][number];
  tex: string;
  busy: boolean;
  save: (changes: Change[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(edit.replace);
  const [error, setError] = useState('');
  useEffect(() => {
    setValue(edit.replace);
  }, [edit.replace]);
  const context = editContext(tex, edit.find);
  async function persist() {
    if (!replacementSchema.safeParse(value).success) {
      setError('Use at most 300 plain-text characters, without \\, {, }, ^ or ~.');
      return;
    }
    setError('');
    if (value === edit.replace || (await save([{ id: edit.id, replace: value }])))
      setEditing(false);
  }
  return (
    <article className={'card p-5 ' + (edit.stale ? 'stale-edit' : '')}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="eyebrow">{edit.stale ? 'Stale edit' : edit.state}</span>
        <button
          className="text-button"
          disabled={busy || edit.stale}
          onClick={() => setEditing(!editing)}
        >
          Edit<span className="sr-only"> replacement</span>
        </button>
      </div>
      <p className="resume-diff text-sm leading-7">
        <span className="text-slate-500">…{context.before} </span>
        <del className="bg-rose-50 text-rose-800">{edit.find}</del>{' '}
        <ins className="bg-emerald-50 text-emerald-800 no-underline">
          {edit.replace || '(delete)'}
        </ins>
        <span className="text-slate-500"> {context.after}…</span>
      </p>
      <p className="text-xs text-slate-500 mt-3">{edit.reason}</p>
      {edit.stale ? (
        <p className="text-xs mt-3">No longer matches the resume</p>
      ) : (
        <div className="flex gap-2 mt-4">
          <button
            className={'chip ' + (edit.state === 'accepted' ? 'chip-active' : '')}
            aria-pressed={edit.state === 'accepted'}
            disabled={busy}
            onClick={() =>
              void save([
                { id: edit.id, state: edit.state === 'accepted' ? 'pending' : 'accepted' },
              ])
            }
          >
            Accept
          </button>
          <button
            className={'chip ' + (edit.state === 'rejected' ? 'chip-active' : '')}
            aria-pressed={edit.state === 'rejected'}
            disabled={busy}
            onClick={() =>
              void save([
                { id: edit.id, state: edit.state === 'rejected' ? 'pending' : 'rejected' },
              ])
            }
          >
            Reject
          </button>
        </div>
      )}
      {editing && (
        <div className="mt-4">
          <label>
            Replacement text
            <textarea
              rows={3}
              value={value}
              disabled={busy}
              maxLength={300}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => void persist()}
            />
          </label>
          <p className="text-xs text-slate-500 mt-2">
            Saved when you leave the field. Plain text only.
          </p>
          <button className="text-button" disabled={busy} onClick={() => void persist()}>
            Save replacement
          </button>
          {error && (
            <p role="alert" className="text-sm text-rose-700">
              {error}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
export function Tailor({
  id,
  api,
  token,
  signOut,
}: {
  id: string;
  api: Api;
  token: string;
  signOut: () => void;
}) {
  const [app, setApp] = useState<Application>();
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [tailoring, setTailoring] = useState<TailoringView>();
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState('');
  const [log, setLog] = useState('');
  const [pages, setPages] = useState(0);
  const path = '/api/applications/' + encodeURIComponent(id);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [apps, library] = await Promise.all([
          api<Application[]>('/api/applications'),
          api<Resume[]>('/api/resumes'),
        ]);
        const found = apps.find((app) => app.id === id);
        if (!found)
          throw new Error('Application not found. Return to the dashboard to choose another.');
        if (!active) return;
        setApp(found);
        setResumes(library);
        if (found.tailoring || library.length) {
          const view = found.tailoring
            ? await api<TailoringView>(path + '/tailoring')
            : await api<TailoringView>(path + '/tailor', 'POST', {});
          if (active) setTailoring(view);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setBusy(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [api, id, path]);
  const base = resumes.find((resume) => resume.id === tailoring?.resumeId);
  const coverage = keywordCoverage(base?.tex || '', app?.keyRequirements || [], tailoring);
  async function save(edits: Change[]) {
    setSaving(true);
    setError('');
    setPages(0);
    try {
      const view = await api<TailoringView>(path + '/tailoring', 'PATCH', { edits });
      setTailoring(view);
      setResumes(await api<Resume[]>('/api/resumes'));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function regenerate() {
    if (!confirm('Regenerate tailoring? This replaces all current edits and decisions.')) return;
    setBusy(true);
    setError('');
    setLog('');
    setPages(0);
    try {
      const library = await api<Resume[]>('/api/resumes');
      setResumes(library);
      setTailoring(await api<TailoringView>(path + '/tailor', 'POST', { regenerate: true }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBuilding(true);
    setError('');
    setLog('');
    setPages(0);
    try {
      const response = await fetch(path + '/resume.pdf', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (response.status === 401) {
        signOut();
        throw new Error('Your session expired. Please sign in again.');
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        if (response.status === 422) setLog(failure.log || 'No compiler log available.');
        throw new Error(failure.error || 'Could not download the resume. Please try again.');
      }
      setPages(Number(response.headers.get('X-Page-Count')) || 0);
      const stale = JSON.parse(response.headers.get('X-Stale-Edit-Ids') || '[]') as string[];
      if (stale.some((id) => !tailoring?.staleEditIds.includes(id)))
        setError(
          'Some edits no longer match the base resume and were skipped. Refresh to see their stale flags.',
        );
      const filename =
        response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ||
        'Resume.pdf';
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuilding(false);
    }
  }
  return (
    <main className="max-w-4xl mx-auto px-5 md:px-8 py-8 tailor-page">
      <a className="link text-sm" href="/">
        ← Back to dashboard
      </a>
      <header className="mt-6 mb-6">
        <p className="eyebrow mb-2">RESUME STUDIO</p>
        <h1 className="text-2xl font-semibold">{app?.company || 'Tailor your resume'}</h1>
        <p className="text-sm text-slate-500 mt-2">{app?.title}</p>
      </header>
      {busy && (
        <p role="status" className="card p-5 text-sm flex gap-3 items-center">
          <span className="animate-spin inline-block w-4 h-4 border-2 border-slate-300 border-t-slate-700 rounded-full" />
          Tailoring your resume… ~10s
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="text-sm bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-4 my-4"
        >
          {error}
        </p>
      )}
      {error && !busy && !tailoring && resumes.length > 0 && (
        <button className="secondary-button" onClick={() => location.reload()}>
          Try again
        </button>
      )}
      {log && (
        <details className="card p-4 my-4">
          <summary className="text-sm cursor-pointer">Compilation log</summary>
          <pre className="text-xs mt-3 whitespace-pre-wrap break-words">{log}</pre>
        </details>
      )}
      {!busy && !resumes.length && (
        <section className="card p-6">
          <h2 className="font-semibold">Upload a resume first</h2>
          <p className="text-sm text-slate-500 my-3">
            Add your LaTeX resumes in Settings, then return here to tailor.
          </p>
          <a href="/?tab=settings" className="secondary-button inline-block">
            Open Settings
          </a>
        </section>
      )}
      {tailoring && (
        <>
          <section className="card p-5 mt-5">
            <div className="flex flex-wrap justify-between gap-4 items-center">
              <h2 className="text-sm">
                Using <strong>{tailoring.resumeLabel}</strong> resume
              </h2>
              <button
                className="secondary-button"
                disabled={busy || saving || building}
                onClick={() => void regenerate()}
              >
                Regenerate
              </button>
            </div>
            <p className="text-sm text-slate-500 mt-3">{tailoring.reason}</p>
            {tailoring.baseMissing && (
              <p className="text-sm text-rose-700 mt-3">
                The base resume was deleted.{' '}
                <a className="link" href="/?tab=settings">
                  Upload one in Settings
                </a>
                , then regenerate.
              </p>
            )}
          </section>
          <section className="card p-5 mt-5">
            <h2 className="font-semibold text-sm">
              Keyword coverage{' '}
              <span className="font-normal text-slate-500">
                · {coverage.filter((term) => term.before).length} →{' '}
                {coverage.filter((term) => term.after).length} covered
              </span>
            </h2>
            <p className="text-xs text-slate-500 mt-2">
              Before → after accepted edits · Matches the listed requirement terms, not an ATS
              score.
            </p>
            <div className="flex flex-wrap gap-2 mt-4">
              {coverage.map((term) => (
                <span
                  key={term.term}
                  className={'chip keyword-chip ' + (term.after ? 'keyword-covered' : '')}
                  title={
                    (term.before ? 'Covered before' : 'Not covered before') +
                    ' → ' +
                    (term.after ? 'covered now' : 'not covered now')
                  }
                >
                  {term.after ? '✓' : '○'} {term.term}{' '}
                  <span className="text-[10px]">
                    {term.before ? '✓' : '○'} → {term.after ? '✓' : '○'}
                  </span>
                </span>
              ))}
            </div>
            {!coverage.length && (
              <p className="text-xs text-slate-500 mt-3">
                No key requirements were saved for this job.
              </p>
            )}
          </section>
          <section className="mt-6" aria-label="Resume edits">
            <div className="flex flex-wrap gap-3 justify-between items-center mb-4">
              <h2 className="font-semibold text-sm">
                {tailoring.edits.filter((edit) => edit.state === 'accepted' && !edit.stale).length}{' '}
                of {tailoring.edits.length} accepted
              </h2>
              <div className="flex gap-2">
                {(['accepted', 'rejected'] as const).map((state) => (
                  <button
                    key={state}
                    className="secondary-button"
                    disabled={
                      busy || saving || building || !tailoring.edits.some((edit) => !edit.stale)
                    }
                    onClick={() =>
                      void save(
                        tailoring.edits
                          .filter((edit) => !edit.stale)
                          .map((edit) => ({ id: edit.id, state })),
                      )
                    }
                  >
                    {state === 'accepted' ? 'Accept all' : 'Reject all'}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-4">
              {tailoring.edits.map((edit) => (
                <EditCard
                  key={edit.id}
                  edit={edit}
                  tex={base?.tex || ''}
                  busy={busy || saving || building}
                  save={save}
                />
              ))}
            </div>
            {!tailoring.edits.length && (
              <p className="card p-5 text-sm">
                No safe wording changes were suggested. You can download the original resume or
                regenerate.
              </p>
            )}
          </section>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button
              className="primary-button"
              disabled={busy || saving || building || tailoring.baseMissing}
              onClick={() => void download()}
            >
              {building ? 'Building PDF…' : 'Download PDF'}
            </button>
            <p role="status" className="text-xs text-slate-500">
              {saving ? 'Saving decisions…' : 'Only accepted, matching edits are included.'}
            </p>
          </div>
          {pages > 1 && (
            <p role="status" className="text-sm text-amber-800 mt-4">
              Resume is now {pages} pages
            </p>
          )}
        </>
      )}
    </main>
  );
}
