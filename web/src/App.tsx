import { useCallback, useEffect, useState } from 'react';
import { SignIn } from './auth';
import { Drawer } from './Drawer';
import { ReviewCard } from './ReviewCard';
import {
  Application,
  Job,
  Review,
  Status,
  statuses,
  statusColors,
  salary,
  formatDate,
} from './types';

type GmailStatus = { connected: boolean; watchExpiration: string | null };
export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('idToken') || '');
  const [tab, setTab] = useState('Applications');
  const [apps, setApps] = useState<Application[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [gmail, setGmail] = useState<GmailStatus>({ connected: false, watchExpiration: null });
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Application | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const onToken = useCallback((next: string) => {
    sessionStorage.setItem('idToken', next);
    setToken(next);
  }, []);
  const signOut = useCallback(() => {
    sessionStorage.removeItem('idToken');
    setToken('');
    setApps([]);
    setReviews([]);
    setSelected(null);
    window.google?.accounts.id.disableAutoSelect();
  }, []);
  const api = useCallback(
    async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await fetch(path, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 401) {
        signOut();
        throw new Error('Your session expired. Please sign in again.');
      }
      if (response.status === 403)
        throw new Error(
          'This account does not have access. Please sign out and use the owner’s Google account.',
        );
      if (!response.ok) throw new Error('We couldn’t complete that request. Please try again.');
      if (response.status === 204) return undefined as T;
      return response.json() as Promise<T>;
    },
    [token, signOut],
  );
  const refresh = useCallback(async () => {
    const [applications, review, status] = await Promise.all([
      api<Application[]>('/api/applications'),
      api<Review[]>('/api/review'),
      api<GmailStatus>('/api/gmail/status'),
    ]);
    setApps(applications);
    setReviews(review);
    setGmail(status);
  }, [api]);
  useEffect(() => {
    if (!token) return;
    let active = true;
    setLoading(true);
    setError('');
    refresh()
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, refresh]);
  async function save(
    id: string,
    fields: Job & { status: Status; appliedAt: string; lastActivityAt: string },
  ) {
    await api('/api/applications/' + encodeURIComponent(id), 'PATCH', fields);
    await refresh();
  }
  async function remove(id: string) {
    await api('/api/applications/' + encodeURIComponent(id), 'DELETE');
    await refresh();
  }
  async function resolve(id: string, action: object) {
    await api('/api/review/' + encodeURIComponent(id) + '/resolve', 'POST', action);
    await refresh();
  }
  if (!token) return <SignIn onToken={onToken} />;
  const visible = apps.filter(
    (app) =>
      (filter === 'All' || app.status === filter) &&
      (app.company + ' ' + app.title).toLowerCase().includes(search.toLowerCase()),
  );
  const active = apps.filter(
    (a) => !['Rejected', 'Withdrawn', 'Ghosted'].includes(a.status),
  ).length;
  return (
    <div className="min-h-screen">
      <header className="bg-white border-b">
        <div className="max-w-[1440px] mx-auto px-6 md:px-10 h-20 flex items-center justify-between">
          <a href="/" className="flex items-center gap-3">
            <span className="brand-icon">
              a<span>↗</span>
            </span>
            <span className="font-semibold tracking-tight text-lg">
              application<span className="font-normal text-slate-400">tracker</span>
            </span>
          </a>
          <div className="flex items-center gap-5">
            <span className="hidden sm:block text-xs text-slate-400">
              A little progress, every day.
            </span>
            <button className="text-button" onClick={signOut}>
              Sign out
            </button>
            <span
              className="w-9 h-9 bg-slate-100 rounded-full grid place-items-center text-slate-500 text-sm border"
              aria-hidden="true"
            >
              You
            </span>
          </div>
        </div>
      </header>
      <main className="max-w-[1440px] mx-auto px-6 md:px-10 py-10">
        <div className="workspace-hero flex items-center justify-between mb-8">
          <div>
            <p className="eyebrow mb-3">YOUR CAREER, IN MOTION</p>
            <h1 className="text-3xl font-semibold tracking-tight">Keep your next move in view.</h1>
            <p className="text-slate-500 text-sm mt-3">
              A home for every application. A clear path to what comes next.
            </p>
          </div>
          <div className="hidden md:block text-right text-xs text-slate-400">
            YOUR WORKSPACE
            <div className="text-sm text-slate-600 mt-2">
              {new Date().toLocaleDateString(undefined, {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </div>
          </div>
        </div>
        <div className="workspace-stats grid sm:grid-cols-3 gap-4 mb-9">
          {[
            ['Applications tracked', apps.length, 'Every opportunity, organized.'],
            ['Active applications', active, 'Good things are in the works.'],
            ['Waiting for your review', reviews.length, 'A quick check keeps things on track.'],
          ].map(([label, count, note]) => (
            <div className="card p-5 flex justify-between" key={label}>
              <div>
                <p className="text-sm text-slate-500">{label}</p>
                <p className="stat-number text-3xl font-semibold tracking-tight mt-3">{count}</p>
                <p className="text-xs text-slate-400 mt-3">{note}</p>
              </div>
              <span className="text-slate-300 text-xl" aria-hidden="true">
                ↗
              </span>
            </div>
          ))}
        </div>
        <nav className="workspace-nav flex gap-7 border-b mb-7" aria-label="Workspace tabs">
          {['Applications', 'Needs review', 'Settings'].map((name) => (
            <button
              key={name}
              onClick={() => setTab(name)}
              className={'tab ' + (tab === name ? 'tab-active' : '')}
              aria-current={tab === name ? 'page' : undefined}
            >
              {name}
              {name === 'Needs review' && (
                <span className="ml-2 rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {reviews.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        {error && (
          <div
            role="alert"
            className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-4 mb-5 text-sm"
          >
            {error}
            <button
              className="ml-4 underline"
              onClick={() => {
                setError('');
                setLoading(true);
                void refresh()
                  .catch((e) => setError(e.message))
                  .finally(() => setLoading(false));
              }}
            >
              Try again
            </button>
          </div>
        )}
        {loading && (
          <p role="status" className="text-slate-500 py-8">
            Loading your workspace…
          </p>
        )}
        {!loading && tab === 'Applications' && (
          <section>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="font-semibold text-lg">Your applications</h2>
                <p className="text-sm text-slate-400 mt-1">From first click to final offer.</p>
              </div>
              <span className="text-xs text-slate-400">
                {visible.length} of {apps.length} applications
              </span>
            </div>
            <div className="flex gap-2 flex-wrap mb-5">
              {['All', ...statuses].map((s) => (
                <button
                  className={'chip ' + (filter === s ? 'chip-active' : '')}
                  key={s}
                  onClick={() => setFilter(s)}
                  aria-pressed={filter === s}
                >
                  {s}
                  <span className="ml-2 opacity-60">
                    {s === 'All' ? apps.length : apps.filter((a) => a.status === s).length}
                  </span>
                </button>
              ))}
            </div>
            <div className="card overflow-hidden">
              <div className="p-4 border-b flex items-center justify-between">
                <label className="relative w-full sm:w-80">
                  <span className="sr-only">Search company or job title</span>
                  <input
                    className="!mt-0 !pl-9 !bg-slate-50"
                    placeholder="Search company or job title…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <span className="absolute left-3 top-2.5 text-slate-400" aria-hidden="true">
                    ⌕
                  </span>
                </label>
                <span className="hidden sm:block text-xs text-slate-400">
                  Select an application to see the details
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead>
                    <tr>
                      {[
                        'Company / role',
                        'Status',
                        'Salary',
                        'Date applied',
                        'Last activity',
                        '',
                      ].map((h, i) => (
                        <th key={i} scope="col" className="table-head">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((app) => (
                      <tr
                        className="application-row group"
                        key={app.id}
                        onClick={() => setSelected(app)}
                      >
                        <td className="px-5 py-5">
                          <div className="flex items-center gap-3">
                            <span className="company-icon">
                              {app.company.slice(0, 1).toUpperCase()}
                            </span>
                            <div>
                              <button
                                className="font-semibold text-slate-800 hover:underline text-left"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelected(app);
                                }}
                              >
                                {app.company}
                                <span className="sr-only"> — edit application</span>
                              </button>
                              <p className="text-slate-500 mt-1">{app.title}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-5">
                          <span className={'status-badge ' + statusColors[app.status]}>
                            <span className="w-1.5 h-1.5 bg-current rounded-full" />
                            {app.status}
                          </span>
                        </td>
                        <td className="numeric-cell px-5 py-5 text-slate-600">
                          {salary(app)}
                          {app.salaryIsEstimated && (
                            <span className="ml-2 text-[10px] border rounded px-1 py-0.5 text-slate-400">
                              est.
                            </span>
                          )}
                        </td>
                        <td className="numeric-cell px-5 py-5 text-slate-500">
                          {formatDate(app.appliedAt)}
                        </td>
                        <td className="numeric-cell px-5 py-5 text-slate-500">
                          {formatDate(app.lastActivityAt)}
                        </td>
                        <td className="px-4 text-slate-300">↗</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {visible.length === 0 && (
                <div className="text-center p-14">
                  <h3 className="font-medium">
                    {apps.length
                      ? 'No applications match your search'
                      : 'Your next chapter starts here'}
                  </h3>
                  <p className="text-slate-500 text-sm mt-2">
                    {apps.length
                      ? 'Try another company, job title, or status.'
                      : 'Use the Chrome extension on a job posting to track your first application.'}
                  </p>
                </div>
              )}
              <div className="border-t px-5 py-3 text-xs text-slate-400">
                Your progress is more than a number. Keep going.
              </div>
            </div>
          </section>
        )}
        {!loading && tab === 'Needs review' && (
          <section>
            <h2 className="font-semibold text-lg">A second pair of eyes</h2>
            <p className="text-sm text-slate-500 mt-2 mb-6">
              These emails need a little help finding the right application. You’re in control.
            </p>
            <div className="space-y-5">
              {reviews.map((item) => (
                <ReviewCard key={item.id} item={item} applications={apps} resolve={resolve} />
              ))}
            </div>
            {reviews.length === 0 && (
              <div className="card text-center p-14">
                <p className="text-2xl mb-3">✓</p>
                <h3 className="font-semibold">You’re all caught up</h3>
                <p className="text-sm text-slate-500 mt-2">
                  Emails that need your attention will appear here.
                </p>
              </div>
            )}
          </section>
        )}
        {!loading && tab === 'Settings' && (
          <section className="card max-w-2xl p-7">
            <div className="flex gap-4">
              <span className="company-icon">✉</span>
              <div>
                <h2 className="font-semibold text-lg">Your Gmail connection</h2>
                <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                  Let application updates come to you. We look for job-related messages and keep
                  your applications up to date.
                </p>
              </div>
            </div>
            <dl className="mt-7 border-y divide-y">
              <div className="flex justify-between py-4 text-sm">
                <dt className="text-slate-500">Connection</dt>
                <dd className={gmail.connected ? 'text-emerald-700' : 'text-slate-500'}>
                  {gmail.connected ? '● Connected' : 'Not connected'}
                </dd>
              </div>
              <div className="flex justify-between py-4 text-sm">
                <dt className="text-slate-500">Email watch expires</dt>
                <dd>
                  {gmail.watchExpiration
                    ? formatDate(new Date(Number(gmail.watchExpiration)).toISOString())
                    : 'Not set'}
                </dd>
              </div>
            </dl>
            <button
              className="primary-button mt-6"
              disabled={connecting}
              onClick={async () => {
                setConnecting(true);
                setError('');
                try {
                  const data = await api<{ url: string }>('/api/gmail/connect', 'POST');
                  window.location.assign(data.url);
                } catch (e) {
                  setError((e as Error).message);
                  setConnecting(false);
                }
              }}
            >
              {connecting
                ? 'Opening Google…'
                : gmail.connected
                  ? 'Reconnect Gmail'
                  : 'Connect Gmail'}
            </button>
            <p className="text-xs text-slate-400 mt-5 leading-relaxed">
              Read-only access. We never send email or store full email bodies.
              <br />
              The connection is renewed automatically each day.
            </p>
          </section>
        )}
        <footer className="mt-12 pt-5 border-t text-xs text-slate-400 flex justify-between">
          <span>Made for your next opportunity.</span>
          <span>One step at a time ↗</span>
        </footer>
      </main>
      {selected && (
        <Drawer
          key={selected.id}
          app={selected}
          close={() => setSelected(null)}
          save={save}
          remove={remove}
        />
      )}
    </div>
  );
}
