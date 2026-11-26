import { useEffect, useState } from 'react';
import type { ReferralContact, ReferralSend } from '../../server/src/domain';
import type { ReferralProfile, ReferralResume } from '../../server/src/referrals';
import type { Api } from './tailoring';
import { isPreApplication, statusColors, type Application } from './types';

type Settings = { profile?: ReferralProfile; resume?: ReferralResume; canSend: boolean };
type Contact = ReferralContact & {
  message?: { subject: string; body: string };
  state?: ReferralSend['state'];
};
type Preview = {
  app: Application;
  revision: string;
  hasProfile: boolean;
  resume?: ReferralResume;
  canSend: boolean;
  contacts: Contact[];
};

export function ReferralSettings({
  api,
  upload,
}: {
  api: Api;
  upload: (file: File) => Promise<ReferralResume>;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [profile, setProfile] = useState<ReferralProfile>({ senderName: '', aboutMe: '' });
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Settings>('/api/referrals/settings')
      .then((data) => {
        if (!active) return;
        setSettings(data);
        if (data.profile) setProfile(data.profile);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="job-referrals" className="card max-w-2xl p-7 mt-6">
      <h2 className="font-semibold text-lg">Job referrals</h2>
      {error && (
        <p role="alert" className="text-sm text-rose-700 mt-3">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-emerald-700 mt-3">
          {message}
        </p>
      )}
      {settings && (
        <>
          <form
            className="space-y-4 mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api('/api/referrals/settings', 'PUT', profile);
                const resume = file ? await upload(file) : settings.resume;
                setSettings({ ...settings, profile, resume });
                setFile(undefined);
                setMessage('Referral settings saved.');
              });
            }}
          >
            <label>
              Sender name
              <input
                required
                maxLength={100}
                value={profile.senderName}
                onChange={(e) => setProfile({ ...profile, senderName: e.target.value })}
              />
            </label>
            <label>
              One sentence about you
              <textarea
                required
                maxLength={500}
                value={profile.aboutMe}
                onChange={(e) => setProfile({ ...profile, aboutMe: e.target.value })}
              />
            </label>
            <label>
              Default résumé PDF
              <input
                type="file"
                accept="application/pdf,.pdf"
                key={settings.resume?.revision}
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </label>
            <p className="text-xs text-slate-500">
              {settings.resume ? settings.resume.filename : 'Choose a PDF up to 5 MB.'}
            </p>
            <button className="primary-button" disabled={busy}>
              Save referral settings
            </button>
          </form>
          {settings.canSend && (
            <p className="text-sm text-emerald-700 mt-5">Gmail sending enabled</p>
          )}
          <button
            className="secondary-button mt-5"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const { url } = await api<{ url: string }>('/api/gmail/connect', 'POST', {
                  referrals: true,
                });
                window.location.assign(url);
              })
            }
          >
            {settings.canSend ? 'Reconnect Gmail sending' : 'Enable Gmail sending'}
          </button>
        </>
      )}
    </section>
  );
}

const sendLabels: Record<ReferralSend['state'], string> = {
  sent: 'Sent',
  failed: 'Send failed. You can retry.',
  sending: 'Send pending. Check Gmail before contacting again.',
  unknown: 'Delivery could not be confirmed. Check Gmail before contacting again.',
};

export function Referrals({ id, api }: { id: string; api: Api }) {
  const endpoint = '/api/applications/' + encodeURIComponent(id) + '/referrals';
  const [view, setView] = useState<Preview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const find = new URLSearchParams(location.search).get('find') === '1';
    api<Preview>(endpoint)
      .then(async (data) => {
        if (active) setView(data);
        if (find && isPreApplication(data.app.status) && !data.app.referralContacts) {
          const result = await api<Preview>(endpoint + '/search', 'POST', {});
          if (active) setView(result);
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, endpoint]);
  async function update(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      setView(await api<Preview>(endpoint + path, 'POST', body));
      setSelected([]);
    } catch (e) {
      setError((e as Error).message);
      if (path === '/send') {
        const refreshed = await api<Preview>(endpoint).catch(() => undefined);
        if (refreshed) {
          setView(refreshed);
          setSelected([]);
        }
      }
    } finally {
      setBusy(false);
    }
  }
  const inReferral = !!view && isPreApplication(view.app.status);
  const ready = !!view?.resume && view.hasProfile && view.canSend && inReferral;
  const searchTitle = view?.app.title.replace(
    /^(?:associate|junior|senior|staff|principal)[,\s]+/i,
    '',
  );
  const profileSearch =
    view &&
    'https://www.google.com/search?' +
      new URLSearchParams({ q: `site:linkedin.com/in/ ${view.app.company} ${searchTitle}` });
  return (
    <main className="max-w-4xl mx-auto px-5 md:px-8 py-8">
      <a className="link text-sm" href="/">
        ← Back to applications
      </a>
      <h1 className="text-2xl font-semibold mt-5">Email referrers</h1>
      {view && (
        <p className="text-sm text-slate-500 mt-2">
          {view.app.title} · {view.app.company}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-700 mt-4">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-slate-500 mt-4">
          Working…
        </p>
      )}
      {view && (
        <>
          <div className="flex flex-wrap items-center gap-4 mt-5">
            <span className={'status-badge ' + statusColors[view.app.status]}>
              {view.app.status}
            </span>
            {inReferral && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void update('/search', { refresh: true })}
              >
                {view.app.referralContacts ? 'Search again' : 'Find referrers'}
              </button>
            )}
            {view.app.status === 'Apply now' && (
              <a className="link" href={view.app.url} target="_blank" rel="noreferrer">
                Open posting ↗
              </a>
            )}
          </div>
          {inReferral && !ready && (
            <p className="card p-4 mt-4 text-sm">
              Set your sender details, upload a résumé, and enable sending in{' '}
              <a className="link" href="/?tab=settings#job-referrals">
                Job referrals settings
              </a>
              .
            </p>
          )}
          {view.resume && (
            <p className="text-sm text-slate-500 mt-4">Attachment · {view.resume.filename}</p>
          )}
          {!busy && !error && view.app.referralContacts && !view.contacts.length && (
            <p className="text-sm text-slate-500 mt-4">
              Gemini couldn’t find contacts it could cite.
            </p>
          )}
          {inReferral && !busy && !view.contacts.length && (view.app.referralContacts || error) && (
            <a
              className="link text-sm inline-block mt-2"
              href={profileSearch}
              target="_blank"
              rel="noreferrer"
            >
              Search public profiles ↗
            </a>
          )}
          <div className="space-y-4 mt-5">
            {view.contacts.map((contact) => {
              const address = contact.email;
              const canSelect =
                ready &&
                !!address &&
                !!contact.emailSource &&
                (!contact.state || contact.state === 'failed');
              const checked = !!address && selected.includes(address);
              return (
                <article className="card p-5" key={contact.source + contact.name}>
                  <h2 className="font-semibold">{contact.name}</h2>
                  <p className="text-sm text-slate-500 mt-1">{contact.title}</p>
                  <div className="flex flex-wrap gap-4 mt-3 text-sm">
                    <a className="link" href={contact.source} target="_blank" rel="noreferrer">
                      Role source ↗
                    </a>
                    {contact.emailSource && (
                      <a
                        className="link"
                        href={contact.emailSource}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Email source ↗
                      </a>
                    )}
                  </div>
                  <p className="text-sm mt-3">
                    {address || 'Open the role source to contact this person manually.'}
                  </p>
                  {contact.state && (
                    <p className="text-sm mt-3" role="status">
                      {sendLabels[contact.state]}
                    </p>
                  )}
                  {address && contact.message && (
                    <details className="text-sm mt-3">
                      <summary className="cursor-pointer">Preview email</summary>
                      <p className="font-medium mt-2">{contact.message.subject}</p>
                      <p className="whitespace-pre-wrap mt-2">{contact.message.body}</p>
                    </details>
                  )}
                  {canSelect && (
                    <label className="flex items-center gap-2 mt-4">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, address]
                              : current.filter((email) => email !== address),
                          )
                        }
                      />
                      Select {contact.name}
                    </label>
                  )}
                </article>
              );
            })}
          </div>
          {ready && (
            <button
              className="primary-button mt-5"
              disabled={busy || !selected.length}
              onClick={() =>
                void update('/send', { recipients: selected, revision: view.revision })
              }
            >
              Send selected{selected.length ? ' (' + selected.length + ')' : ''}
            </button>
          )}
        </>
      )}
    </main>
  );
}
