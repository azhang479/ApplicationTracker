import { describe, it, expect, vi } from 'vitest';
import { Application, Review, GmailConfig, Store, Job, Classification, AI, matchApplications, titleSimilarity, categoryStatus, passesPrefilter } from '../src/domain.js';
import { Tracker, NotFound, patchSchema, resolveSchema } from '../src/service.js';
import { parseMime } from '../src/gmail.js';
import { auth, signState, validState } from '../src/auth.js';
import { Config } from '../src/config.js';
import type { Request, Response } from 'express';

class FakeStore implements Store {
  apps: Application[] = []; reviews: Review[] = []; processed = new Set<string>(); gmail?: GmailConfig;
  async listApplications() { return this.apps; }
  async saveApplication(app: Application) { this.apps = [...this.apps.filter(a => a.id !== app.id), app]; }
  async deleteApplication(id: string) { this.apps = this.apps.filter(a => a.id !== id); }
  async listReview() { return this.reviews.filter(r => !r.resolved); }
  async saveReview(review: Review) { this.reviews = [...this.reviews.filter(r => r.id !== review.id), review]; }
  async isProcessed(id: string) { return this.processed.has(id); }
  async markProcessed(id: string) { this.processed.add(id); }
  async getGmail() { return this.gmail; }
  async saveGmail(config: GmailConfig) { this.gmail = config; }
  async exclusive<T>(work: () => Promise<T>) { return work(); }
}
const job: Job = { company: 'Acme Inc', title: 'Software Engineer', jobId: '123', url: 'https://example.com/job', location: 'NY', workMode: 'hybrid', salaryMin: 100000, salaryMax: 150000, salaryCurrency: 'USD', salaryPeriod: 'year', salaryIsEstimated: true, jobSummary: 'Build software', keyRequirements: ['JavaScript'] };
const result: Classification = { isJobRelated: true, category: 'interview', company: 'Acme', title: job.title, jobId: '', summary: 'Interview invitation' };
const email = { id: 'm1', subject: 'Interview', from: 'Hiring <jobs@acme.com>', date: '2026-01-01', snippet: 'Invitation', gmailLink: 'https://mail.google.com/mail/u/0/#all/m1' };
function setup() {
  const store = new FakeStore();
  const ai: AI = { extract: vi.fn(async () => ({ ...job })), classify: vi.fn(async () => result) };
  const tracker = new Tracker(store, ai, () => '2026-06-01T00:00:00.000Z');
  return { store, ai, tracker, capture: () => tracker.capture({ url: job.url, pageTitle: job.title, text: 'Posting' }) };
}
describe('capture', () => {
  it('creates applied record and truncates input', async () => {
    const { tracker, ai } = setup();
    const app = await tracker.capture({ url: job.url, pageTitle: '', text: 'a'.repeat(50000) });
    expect(app.status).toBe('Applied'); expect(app.events[0].type).toBe('applied');
    expect(vi.mocked(ai.extract).mock.calls[0][0].text.length).toBe(40000);
  });
  it('deduplicates URL and normalized company/jobId', async () => {
    const { tracker, capture, store } = setup();
    await capture(); expect((await capture()).duplicate).toBe(true);
    expect((await tracker.capture({ url: 'https://example.com/other', pageTitle: '', text: '' })).duplicate).toBe(true);
    expect(store.apps).toHaveLength(1);
  });
  it('does not dedupe missing job IDs and propagates extraction errors', async () => {
    const { tracker, ai, store } = setup();
    vi.mocked(ai.extract).mockResolvedValue({ ...job, jobId: '' });
    await tracker.capture({ url: job.url, pageTitle: '', text: '' });
    await tracker.capture({ url: 'https://example.com/other', pageTitle: '', text: '' });
    expect(store.apps).toHaveLength(2);
    vi.mocked(ai.extract).mockRejectedValue(new Error('offline'));
    await expect(tracker.capture({ url: 'https://example.com/error', pageTitle: '', text: '' })).rejects.toThrow('offline');
  });
});
describe('matching', () => {
  it('scores Jaccard including empty titles', () => {
    expect(titleSimilarity('Senior Software Engineer', 'Software Engineer')).toBeCloseTo(2 / 3);
    expect(titleSimilarity('', '')).toBe(0);
  });
  it('matches job ID, company, and sender; ignores withdrawn', async () => {
    const { capture } = setup(); const app = await capture();
    expect(matchApplications([app], { ...result, company: 'Unknown', jobId: '123' }, '').confident?.id).toBe(app.id);
    expect(matchApplications([app], result, '').confident?.id).toBe(app.id);
    expect(matchApplications([app], { ...result, company: '' }, email.from).confident?.id).toBe(app.id);
    expect(matchApplications([{ ...app, status: 'Withdrawn' }], result, email.from).confident).toBeUndefined();
    expect(matchApplications([], result, '').candidates).toEqual([]);
  });
  it('requires clear title winner and rejects ambiguous exact IDs', async () => {
    const app = await setup().capture(); const other = { ...app, id: 'other', jobId: '456', title: 'Product Designer' };
    expect(matchApplications([app, other], result, '').confident?.id).toBe(app.id);
    expect(matchApplications([app, { ...other, title: app.title }], result, '').confident).toBeUndefined();
    expect(matchApplications([app, { ...other, jobId: app.jobId }], { ...result, jobId: app.jobId }, '').confident).toBeUndefined();
  });
});
describe('status and ghosting', () => {
  it.each([['rejection', 'Rejected'], ['online_assessment', 'Online Assessment'], ['interview', 'Interview'], ['offer', 'Offer'], ['confirmation', undefined], ['other', undefined]] as const)('maps %s', (category, status) => {
    expect(categoryStatus(category)).toBe(status);
  });
  it('ghosts only stale Applied and revives on later reply', async () => {
    const { store, tracker, capture } = setup(); await capture(); const app = store.apps[0];
    app.lastActivityAt = '2026-01-01T00:00:00.000Z';
    store.apps.push({ ...app, id: 'interview', jobId: '456', status: 'Interview' }, { ...app, id: 'recent', jobId: '789', lastActivityAt: '2026-05-31T00:00:00.000Z' });
    expect(await tracker.ghost(45)).toBe(1); expect(await tracker.ghost(45)).toBe(0);
    expect(app.status).toBe('Ghosted');
    await tracker.receive(email, { ...result, jobId: app.jobId });
    expect(app.status).toBe('Interview'); expect(app.events.at(-1)?.gmailLink).toBe(email.gmailLink);
  });
  it('handles empty sweep, confirmation and patch status events', async () => {
    const { tracker, capture, store } = setup(); expect(await tracker.ghost(45)).toBe(0);
    await capture(); const app = store.apps[0]; app.jobId = '';
    await tracker.receive(email, { ...result, category: 'confirmation', jobId: 'new' });
    expect(app.status).toBe('Applied'); expect(app.jobId).toBe('new');
    await tracker.patch(app.id, patchSchema.parse({ status: 'Withdrawn', location: 'Remote' }));
    expect(store.apps[0].events.at(-1)?.type).toBe('status_change');
    await expect(tracker.patch('missing', {})).rejects.toBeInstanceOf(NotFound);
    expect(() => patchSchema.parse({ id: 'evil' })).toThrow();
  });
});
describe('review resolve', () => {
  async function pending() {
    const ctx = setup(); await ctx.tracker.receive(email, result);
    return ctx;
  }
  it('creates unmatched confirmations and dismisses', async () => {
    const { tracker, store } = setup();
    await tracker.receive(email, { ...result, category: 'confirmation' });
    expect(store.reviews[0].candidates).toEqual([]);
    await tracker.resolve(email.id, { type: 'dismiss' }); expect(store.reviews[0].resolved).toBe(true);
    await expect(tracker.resolve(email.id, { type: 'dismiss' })).rejects.toBeInstanceOf(NotFound);
  });
  it('applies selected status and records email event', async () => {
    const { tracker, capture, store } = await pending(); await capture(); const app = store.apps[0];
    await tracker.resolve(email.id, { type: 'apply', applicationId: app.id, status: 'Offer' });
    expect(app.status).toBe('Offer'); expect(app.events.at(-1)?.emailSubject).toBe(email.subject);
    expect(store.reviews[0].resolved).toBe(true);
  });
  it('creates a new application with classification status', async () => {
    const { tracker, store } = await pending();
    await tracker.resolve(email.id, { type: 'create', fields: job });
    expect(store.apps[0].status).toBe('Interview'); expect(store.reviews[0].resolved).toBe(true);
  });
  it('rejects missing targets without resolving and validates actions', async () => {
    const { tracker, store } = await pending();
    await expect(tracker.resolve(email.id, { type: 'apply', applicationId: 'missing', status: 'Offer' })).rejects.toBeInstanceOf(NotFound);
    expect(store.reviews[0].resolved).toBe(false);
    expect(() => resolveSchema.parse({ type: 'unknown' })).toThrow();
  });
});
describe('MIME and prefilter', () => {
  const part = (mimeType: string, value: string) => ({ mimeType, body: { data: Buffer.from(value).toString('base64url') } });
  it('prefers nested plain text and ignores attachments', () => {
    expect(parseMime({ parts: [part('text/html', '<b>html</b>'), { parts: [part('text/plain', 'plain')] }, { ...part('text/plain', 'secret'), filename: 'file.txt' }] })).toBe('plain');
  });
  it('strips HTML and handles empty and malformed payloads', () => {
    expect(parseMime(part('text/html', '<script>bad()</script><p>Hi &amp; welcome</p>'))).toBe('Hi & welcome');
    expect(parseMime({})).toBe(''); expect(parseMime(part('text/plain', ''))).toBe('');
    expect(parseMime({ mimeType: 'image/png', body: { data: '???' } })).toBe('');
  });
  it.each(['application', 'APPLIED', 'candidacy', 'interview', 'online assessment', 'unfortunately', 'move forward', 'next steps', 'hiring'])('accepts %s', text => expect(passesPrefilter(text)).toBe(true));
  it('rejects unrelated or empty messages', () => { expect(passesPrefilter('')).toBe(false); expect(passesPrefilter('Dinner tomorrow?')).toBe(false); expect(passesPrefilter('roleplay')).toBe(false); });
});
describe('authentication', () => {
  const config = { EXTENSION_API_KEY: 'secret', OWNER_EMAIL: 'owner@gmail.com', PUSH_SERVICE_ACCOUNT: 'push@example.iam.gserviceaccount.com', OAUTH_CLIENT_ID: 'client', PUBLIC_URL: 'https://tracker.test' } as Config;
  async function run(kind: 'owner' | 'extension' | 'push', headers: Record<string, string>, payload: object = {}, fail = false) {
    const verifier = { verify: vi.fn(async () => { if (fail) throw new Error('bad token'); return payload; }) };
    const next = vi.fn(), res = { sendStatus: vi.fn() };
    await auth(config, verifier, kind)({ get: (key: string) => headers[key], path: '/tasks/daily' } as Request, res as unknown as Response, next);
    return { verifier, next, res };
  }
  it('accepts correct extension key, rejects missing and wrong', async () => {
    expect((await run('extension', { 'X-API-Key': 'secret' })).next).toHaveBeenCalledOnce();
    expect((await run('extension', {})).res.sendStatus).toHaveBeenCalledWith(401);
    expect((await run('extension', { 'X-API-Key': 'wrong' })).res.sendStatus).toHaveBeenCalledWith(401);
  });
  it('verifies owner and audience, rejects unverified or other owners', async () => {
    const payload = { email: config.OWNER_EMAIL, email_verified: true, iss: 'https://accounts.google.com' };
    const good = await run('owner', { Authorization: 'Bearer token' }, payload);
    expect(good.next).toHaveBeenCalledOnce(); expect(good.verifier.verify).toHaveBeenCalledWith('token', 'client');
    expect((await run('owner', {}, payload)).res.sendStatus).toHaveBeenCalledWith(401);
    expect((await run('owner', { Authorization: 'Bearer token' }, { ...payload, email: 'other@gmail.com' })).res.sendStatus).toHaveBeenCalledWith(403);
    expect((await run('owner', { Authorization: 'Bearer token' }, { ...payload, email_verified: false })).res.sendStatus).toHaveBeenCalledWith(403);
    expect((await run('owner', { Authorization: 'Bearer token' }, payload, true)).res.sendStatus).toHaveBeenCalledWith(401);
  });
  it('requires push identity and path-specific audience', async () => {
    const good = await run('push', { Authorization: 'Bearer token' }, { email: config.PUSH_SERVICE_ACCOUNT, email_verified: true, iss: 'accounts.google.com' });
    expect(good.next).toHaveBeenCalledOnce(); expect(good.verifier.verify).toHaveBeenCalledWith('token', 'https://tracker.test/tasks/daily');
    expect((await run('push', { Authorization: 'Bearer token' }, { email: config.OWNER_EMAIL, email_verified: true, iss: 'accounts.google.com' })).res.sendStatus).toHaveBeenCalledWith(403);
  });
  it('validates signed state and rejects tampering', () => {
    const state = signState('secret');
    expect(validState(state, 'secret')).toBe(true); expect(validState(state + 'x', 'secret')).toBe(false);
    expect(validState('', 'secret')).toBe(false); expect(validState(state, 'wrong')).toBe(false);
  });
});
