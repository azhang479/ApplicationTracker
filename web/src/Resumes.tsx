import { useEffect, useState } from 'react';
import { resumeSchema, MAX_RESUME_BYTES } from '../../server/src/resume-domain';
import type { Api, Resume } from './tailoring';
import { formatDate } from './types';

export function Resumes({ api }: { api: Api }) {
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [form, setForm] = useState<{ id?: string; label: string; tex: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Resume[]>('/api/resumes')
      .then((value) => {
        if (active) setResumes(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setResumes(await api<Resume[]>('/api/resumes'));
      setForm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card max-w-2xl p-7 mt-6" aria-labelledby="resumes-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="resumes-heading" className="font-semibold text-lg">
          Resumes
        </h2>
        <button
          className="secondary-button"
          disabled={busy || loading || resumes.length >= 5}
          onClick={() => {
            setError('');
            setForm({ label: '', tex: '' });
          }}
        >
          Add resume
        </button>
      </div>
      <p className="text-sm text-slate-500 mt-2">
        Upload up to five single-file LaTeX resumes. {resumes.length} / 5 stored.
      </p>
      {loading && (
        <p role="status" className="text-sm mt-4">
          Loading resumes…
        </p>
      )}
      <ul className="divide-y mt-4">
        {resumes.map((resume) => (
          <li key={resume.id} className="flex flex-wrap justify-between items-center gap-3 py-4">
            <div>
              <strong className="text-sm">{resume.label}</strong>
              <p className="text-xs text-slate-500 mt-1">
                {resume.tex.split('\n').length} lines · Updated {formatDate(resume.updatedAt)}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setForm(resume);
                }}
              >
                Edit<span className="sr-only"> {resume.label}</span>
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      `Delete ${resume.label}? Saved tailoring using it will lose its base resume.`,
                    )
                  )
                    void action(() =>
                      api('/api/resumes/' + encodeURIComponent(resume.id), 'DELETE'),
                    );
                }}
              >
                Delete<span className="sr-only"> {resume.label}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!loading && !resumes.length && (
        <p className="text-sm text-slate-500 py-4">Add your first resume to start tailoring.</p>
      )}
      {form && (
        <form
          className="space-y-4 border-t pt-5 mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = resumeSchema.safeParse({ label: form.label, tex: form.tex });
            if (!parsed.success) {
              setError(
                parsed.error.issues
                  .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                  .join(' · '),
              );
              return;
            }
            void action(() =>
              api(
                '/api/resumes' + (form.id ? '/' + encodeURIComponent(form.id) : ''),
                form.id ? 'PUT' : 'POST',
                parsed.data,
              ),
            );
          }}
        >
          <h3 className="font-semibold text-sm">{form.id ? 'Edit resume' : 'Add resume'}</h3>
          <label>
            Label
            <input
              value={form.label}
              maxLength={20}
              required
              disabled={busy}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="e.g. SWE, ML, LL"
            />
          </label>
          <label>
            LaTeX file (.tex)
            <input
              type="file"
              accept=".tex"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (!file.name.toLowerCase().endsWith('.tex') || file.size > MAX_RESUME_BYTES) {
                  setError('Choose a .tex file of at most 200 KB.');
                  return;
                }
                try {
                  const tex = await file.text();
                  setForm((current) => (current ? { ...current, tex } : current));
                  setError('');
                } catch {
                  setError('Could not read that file. Try pasting the LaTeX instead.');
                }
              }}
            />
          </label>
          <label>
            LaTeX source
            <textarea
              className="font-mono"
              rows={12}
              required
              disabled={busy}
              value={form.tex}
              onChange={(e) => setForm({ ...form, tex: e.target.value })}
              spellCheck={false}
            />
          </label>
          <div className="flex gap-3">
            <button className="primary-button" disabled={busy}>
              {busy ? 'Saving…' : 'Save resume'}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setForm(null);
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-700 mt-4">
          {error}
        </p>
      )}
    </section>
  );
}
