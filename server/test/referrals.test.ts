import { describe, expect, it, vi } from 'vitest';
import type { AI, Application, Email, ReferralContact, Review, Store } from '../src/domain.js';
import { referralMime, ReferralService } from '../src/referrals.js';
import { Tracker } from '../src/service.js';
import { buildFlow } from '../../web/src/flow.js';

const now = '2026-11-25T21:00:00.000Z';
const posting = 'https://example.com/jobs/eng';
const pdf = Buffer.from('%PDF-1.7\nsample');
const contacts: ReferralContact[] = [
  {
    name: 'Alex Chen',
    title: 'Engineer',
    source: posting,
    email: 'alex@example.com',
    emailSource: posting,
  },
  {
    name: 'Sam Lee',
    title: 'Engineer',
    source: posting,
    email: 'sam@example.com',
    emailSource: posting,
  },
  { name: 'Casey Smith', title: 'Engineer', source: posting },
];
const reply: Email = {
  id: 'reply',
  subject: 'Re: referral',
  from: 'Alex <alex@example.com>',
  date: '2026-11-25T20:28:00.000Z',
  snippet: 'Go ahead and apply',
  gmailLink: 'https://mail.google.com/mail/u/0/#all/reply',
};

async function setup() {
  let app: Application;
  let queue = Promise.resolve<unknown>(undefined);
  const reviews: Review[] = [];
  const store = {
    async listApplications() {
      return app ? [structuredClone(app)] : [];
    },
    async saveApplication(next: Application) {
      app = structuredClone(next);
    },
    async listReview() {
      return reviews;
    },
    async saveReview(review: Review) {
      reviews.push(review);
    },
    exclusive<T>(work: () => Promise<T>) {
      const run = queue.then(work);
      queue = run.catch(() => undefined);
      return run;
    },
    getGmail: async () => ({ refreshToken: 'fake', canSend: true }),
    getReferralProfile: async () => ({ senderName: 'Owner', aboutMe: 'I study computer science.' }),
    saveReferralProfile: vi.fn(),
  };
  const ai = {
    extract: vi.fn(async () => ({
      company: 'Example',
      title: 'Engineer',
      url: posting,
      jobId: 'ENG-001',
      salaryIsEstimated: false,
      jobSummary: 'Build things',
      keyRequirements: [],
    })),
    findReferrers: vi.fn(async () => contacts),
  } as unknown as AI;
  const attachment = {
    info: vi.fn(async () => ({ filename: 'Resume.pdf', revision: '1' })),
    read: vi.fn(async () => pdf),
    save: vi.fn(),
  };
  const mailer = { sendReferral: vi.fn(async () => 'thread-123') };
  const tracker = new Tracker(store as unknown as Store, ai, () => now);
  const service = new ReferralService(
    store as unknown as ConstructorParameters<typeof ReferralService>[0],
    attachment,
    ai,
    mailer,
    () => now,
  );
  const { id } = await tracker.capture({
    url: posting,
    pageTitle: 'Engineer',
    text: '',
    intent: 'referral',
  });
  return { id, store, tracker, service, ai, attachment, mailer, reviews };
}

describe('referral workflow', () => {
  it('starts before application and records the application date from confirmation', async () => {
    const { id, store, tracker } = await setup();
    expect(buildFlow(await store.listApplications()).total).toBe(0);
    expect(await tracker.receiveReferralReply(reply, id, 'review')).toBe('review');
    expect((await store.listApplications())[0].status).toBe('Looking for referral');
    expect(
      await tracker.receiveReferralReply(
        { ...reply, id: 'ready', gmailLink: 'https://mail.google.com/#all/ready' },
        id,
        'ready',
      ),
    ).toBe('updated');
    expect((await store.listApplications())[0]).toMatchObject({
      status: 'Apply now',
      appliedAt: '',
    });
    const classification = {
      isJobRelated: true,
      category: 'confirmation' as const,
      company: 'Example',
      title: 'Engineer',
      jobId: 'ENG-001',
      summary: 'Application received',
    };
    expect(
      await tracker.receive({ ...reply, id: 'mismatch' }, { ...classification, jobId: 'ENG-002' }),
    ).toBe('review');
    expect(await tracker.receive({ ...reply, id: 'confirmation' }, classification)).toBe('updated');
    const apps = await store.listApplications();
    expect(apps[0]).toMatchObject({ status: 'Applied', appliedAt: reply.date });
    expect(buildFlow(apps)).toMatchObject({ total: 1, responded: 0 });
  });
  it('allows marking the referral job applied manually', async () => {
    const { id, tracker } = await setup();
    expect(await tracker.patch(id, { status: 'Applied' })).toMatchObject({
      status: 'Applied',
      appliedAt: now,
    });
  });
  it('reuses research and sends individual reviewed emails with the PDF only once', async () => {
    const { id, service, mailer, ai } = await setup();
    const preview = await service.search(id, false);
    await service.search(id, false);
    expect(ai.findReferrers).toHaveBeenCalledOnce();
    const batch = { revision: preview.revision, recipients: ['alex@example.com'] };
    await Promise.all([service.send(id, batch), service.send(id, batch)]);
    expect(mailer.sendReferral).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'alex@example.com',
        filename: 'Resume.pdf',
        pdf,
        subject: 'Referral request for Engineer at Example',
        body: expect.stringContaining('Hi Alex,'),
      }),
    );
    const sent = await service.preview(id);
    expect(sent.app).toMatchObject({
      status: 'Sent referral emails',
      appliedAt: '',
      referralThreadIds: ['thread-123'],
    });
    expect(sent.contacts[0].state).toBe('sent');
  });
  it('rejects stale attachments and unsourced recipients before any send', async () => {
    const { id, service, attachment, mailer } = await setup();
    const { revision } = await service.search(id, false);
    await expect(
      service.send(id, { revision, recipients: ['alex@example.com', 'other@example.com'] }),
    ).rejects.toThrow('sourced');
    attachment.info.mockResolvedValue({ filename: 'New.pdf', revision: '2' });
    await expect(service.send(id, { revision, recipients: ['alex@example.com'] })).rejects.toThrow(
      'preview changed',
    );
    expect(mailer.sendReferral).not.toHaveBeenCalled();
  });
  it('retries definite failures without resending successful or uncertain messages', async () => {
    const { id, service, mailer } = await setup();
    const { revision } = await service.search(id, false);
    mailer.sendReferral.mockRejectedValueOnce({ code: 429 }).mockRejectedValueOnce({ code: 503 });
    const batch = { revision, recipients: ['alex@example.com', 'sam@example.com'] };
    const failed = await service.send(id, batch);
    expect(failed.contacts.slice(0, 2).map((contact) => contact.state)).toEqual([
      'failed',
      'unknown',
    ]);
    const retried = await service.send(id, batch);
    expect(retried.contacts.slice(0, 2).map((contact) => contact.state)).toEqual([
      'sent',
      'unknown',
    ]);
    expect(mailer.sendReferral).toHaveBeenCalledTimes(3);
  });
  it('checks uploads and sends a MIME PDF attachment', async () => {
    const { service, attachment } = await setup();
    await expect(service.upload('Resume.pdf', Buffer.from('not a PDF'))).rejects.toThrow('PDF');
    await service.upload('My résumés.pdf', pdf);
    expect(attachment.save.mock.calls[0][0]).toMatch(/^[A-Za-z0-9._ -]+\.pdf$/);
    const mime = Buffer.from(
      referralMime('owner@example.com', {
        to: 'alex@example.com',
        subject: 'Referral — ingénieur',
        body: 'My résumé',
        filename: 'Resume.pdf',
        pdf,
      }),
      'base64url',
    ).toString('utf8');
    expect(mime).toContain('To: alex@example.com\r\n');
    expect(mime).toContain('Content-Disposition: attachment; filename="Resume.pdf"');
    expect(mime).toContain(pdf.toString('base64'));
  });
});
