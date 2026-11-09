import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gmail } from 'googleapis/build/src/apis/gmail/index.js';
import { GmailService } from '../src/gmail.js';
import { Tracker } from '../src/service.js';
import type { AI, Application, Classification, GmailConfig, Review, Store } from '../src/domain.js';
import type { Config } from '../src/config.js';
import type { Resume } from '../src/resume-domain.js';

vi.mock('googleapis/build/src/apis/gmail/index.js', () => ({ gmail: vi.fn() }));
const now = '2026-06-01T00:00:00.000Z';
const link = (id: string) => 'https://mail.google.com/mail/u/0/#all/' + id;
const classification: Classification = {
  isJobRelated: true,
  category: 'assessment_completed',
  company: 'Acme',
  title: 'Software Engineer',
  jobId: '',
  summary: 'Assessment complete',
};
function application(): Application {
  return {
    id: 'acme',
    company: 'Acme Inc',
    title: 'Software Engineer',
    jobId: '',
    url: 'https://example.com/job',
    location: '',
    workMode: 'unknown',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: 'USD',
    salaryPeriod: 'year',
    salaryIsEstimated: false,
    jobSummary: '',
    keyRequirements: [],
    status: 'Online Assessment',
    appliedAt: '2026-05-01',
    createdAt: '2026-05-01',
    updatedAt: '2026-05-30',
    lastActivityAt: '2026-05-30',
    events: [{ at: '2026-05-01', type: 'applied', status: 'Applied' }],
  };
}
function event(id = 'm1', date = '2026-05-30') {
  return {
    at: date,
    emailDate: date,
    gmailLink: link(id),
    type: 'online_assessment',
    status: 'Online Assessment' as const,
  };
}
class MemoryStore implements Store {
  resumes: Resume[] = [];
  async listResumes() {
    return structuredClone(this.resumes);
  }
  async saveResume(resume: Resume) {
    this.resumes = [
      ...this.resumes.filter((item) => item.id !== resume.id),
      structuredClone(resume),
    ];
  }
  async deleteResume(id: string) {
    this.resumes = this.resumes.filter((item) => item.id !== id);
  }
  apps = [application()];
  reviews: Review[] = [];
  processed = new Set(['m1']);
  inside = false;
  private queue = Promise.resolve();
  async listApplications() {
    return structuredClone(this.apps);
  }
  async listReview() {
    return structuredClone(this.reviews);
  }
  async saveApplication(app: Application) {
    if (!this.inside) throw new Error('Mutation outside exclusive');
    this.apps = [...this.apps.filter((item) => item.id !== app.id), structuredClone(app)];
  }
  async saveReview(review: Review) {
    if (!this.inside) throw new Error('Mutation outside exclusive');
    this.reviews = [
      ...this.reviews.filter((item) => item.id !== review.id),
      structuredClone(review),
    ];
  }
  async deleteApplication() {}
  async isProcessed(id: string) {
    return this.processed.has(id);
  }
  async markProcessed(id: string) {
    this.processed.add(id);
  }
  async getGmail(): Promise<GmailConfig> {
    return { refreshToken: 'fake', historyId: '100' };
  }
  async saveGmail() {}
  exclusive<T>(work: () => Promise<T>) {
    const result = this.queue.then(async () => {
      this.inside = true;
      try {
        return await work();
      } finally {
        this.inside = false;
      }
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
function message(
  subject = 'Thank you for completing your assessment',
  body = 'Assessment complete',
) {
  return {
    data: {
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: subject },
          { name: 'From', value: 'Acme <jobs@acme.com>' },
          { name: 'Date', value: '2026-05-30' },
        ],
        body: { data: Buffer.from(body).toString('base64url') },
      },
    },
  };
}
function setup() {
  const store = new MemoryStore();
  const classify = vi.fn(async () => ({ ...classification }));
  const ai = { classify } as unknown as AI;
  const tracker = new Tracker(store, ai, () => now);
  const receive = vi.spyOn(tracker, 'receive');
  const processed = vi.spyOn(store, 'isProcessed');
  const list = vi.fn().mockResolvedValue({ data: { messages: [{ id: 'm1' }] } });
  const get = vi.fn().mockResolvedValue(message());
  const history = vi.fn().mockResolvedValue({
    data: { historyId: '200', history: [{ messagesAdded: [{ message: { id: 'm1' } }] }] },
  });
  vi.mocked(gmail).mockReturnValue({
    users: { messages: { list, get }, history: { list: history } },
  } as never);
  const service = new GmailService(
    {
      OWNER_EMAIL: 'owner@gmail.com',
      OAUTH_CLIENT_ID: 'client',
      OAUTH_CLIENT_SECRET: 'secret',
      PUBLIC_URL: 'https://example.test',
    } as Config,
    store,
    ai,
    tracker,
  );
  return { store, classify, tracker, receive, processed, list, get, service };
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Gmail recheck', () => {
  it('ignores processed markers and sends a timeline-less message through receive', async () => {
    const ctx = setup();
    expect(await ctx.service.recheck(7)).toEqual({
      scanned: 1,
      classified: 1,
      updated: 1,
      review: 0,
      skipped: 0,
    });
    expect(ctx.receive).toHaveBeenCalledOnce();
    expect(ctx.processed).not.toHaveBeenCalled();
    expect(ctx.store.apps[0].events).toHaveLength(2);
    expect(ctx.store.apps[0].status).toBe('OA Completed');
    expect(ctx.store.processed.has('m1')).toBe(true);
  });
  it('corrects an existing latest event in place, including alternate Gmail folder links, and is idempotent', async () => {
    const ctx = setup();
    ctx.store.apps[0].events.push({
      ...event(),
      gmailLink: 'https://mail.google.com/mail/u/0/#inbox/m1',
    });
    const result = await ctx.service.recheck(7);
    expect(result.updated).toBe(1);
    expect(ctx.receive).not.toHaveBeenCalled();
    expect(ctx.store.apps[0].events).toHaveLength(2);
    expect(ctx.store.apps[0].events[1].type).toBe('assessment_completed');
    expect(ctx.store.apps[0].status).toBe('OA Completed');
    expect(ctx.store.apps[0].lastActivityAt).toBe('2026-05-30');
    expect(await ctx.service.recheck(7)).toEqual({
      scanned: 1,
      classified: 1,
      updated: 0,
      review: 0,
      skipped: 1,
    });
  });
  it('does not change status for an older email, even when it was appended last', async () => {
    const ctx = setup();
    ctx.store.apps[0].events.push(event('newer', '2026-05-31'), event());
    await ctx.service.recheck(7);
    expect(ctx.store.apps[0].status).toBe('Online Assessment');
    expect(ctx.store.apps[0].events[2].type).toBe('assessment_completed');
    expect(ctx.store.apps[0].events).toHaveLength(3);
  });
  it('falls back to event time for legacy dates and ignores newer non-email events', async () => {
    const ctx = setup();
    ctx.store.apps[0].events.push({ ...event(), emailDate: 'invalid' }, { at: now, type: 'note' });
    await ctx.service.recheck(7);
    expect(ctx.store.apps[0].status).toBe('OA Completed');
  });
  it.each([
    ['Interview', 'assessment_completed', 'Interview'],
    ['Offer', 'assessment_completed', 'Offer'],
    ['Rejected', 'assessment_completed', 'Rejected'],
    ['Withdrawn', 'assessment_completed', 'Withdrawn'],
    ['Ghosted', 'assessment_completed', 'OA Completed'],
    ['Offer', 'rejection', 'Rejected'],
    ['OA Completed', 'online_assessment', 'Online Assessment'],
  ] as const)('uses receive progression for %s and %s', async (status, category, expected) => {
    const ctx = setup();
    ctx.store.apps[0].status = status;
    ctx.store.apps[0].events.push({ ...event(), type: 'other' });
    ctx.classify.mockResolvedValue({ ...classification, category });
    await ctx.service.recheck(7);
    expect(ctx.store.apps[0].status).toBe(expected);
    expect(ctx.store.apps[0].events).toHaveLength(2);
  });
  it.each([false, true])(
    'skips an existing review before fetching or classifying (resolved=%s)',
    async (resolved) => {
      const ctx = setup();
      ctx.store.reviews.push({ id: 'm1', resolved } as Review);
      expect(await ctx.service.recheck(7)).toEqual({
        scanned: 1,
        classified: 0,
        updated: 0,
        review: 0,
        skipped: 1,
      });
      expect(ctx.get).not.toHaveBeenCalled();
      expect(ctx.classify).not.toHaveBeenCalled();
      expect(ctx.receive).not.toHaveBeenCalled();
      expect(ctx.store.processed.has('m1')).toBe(true);
    },
  );
  it('creates a review for an unmatched new message', async () => {
    const ctx = setup();
    ctx.store.apps = [];
    expect((await ctx.service.recheck(7)).review).toBe(1);
    expect(ctx.store.reviews).toHaveLength(1);
    expect(ctx.store.reviews[0].id).toBe('m1');
  });
  it('reclassifies known timeline messages even without a prefilter keyword', async () => {
    const ctx = setup();
    ctx.store.apps[0].events.push(event());
    ctx.get.mockResolvedValue(message('Done', 'Done'));
    expect((await ctx.service.recheck(7)).updated).toBe(1);
    expect(ctx.classify).toHaveBeenCalledOnce();
  });
  it('skips non-job messages and marks them processed', async () => {
    const ctx = setup();
    ctx.get.mockResolvedValue(message('Weekly news', 'Sunny weather'));
    expect((await ctx.service.recheck(7)).skipped).toBe(1);
    expect(ctx.classify).not.toHaveBeenCalled();
    ctx.get.mockResolvedValue(message());
    ctx.classify.mockResolvedValue({ ...classification, isJobRelated: false });
    expect(await ctx.service.recheck(7)).toEqual({
      scanned: 1,
      classified: 1,
      updated: 0,
      review: 0,
      skipped: 1,
    });
    expect(ctx.store.processed.has('m1')).toBe(true);
  });
  it('returns zero counts for an empty inbox', async () => {
    const ctx = setup();
    ctx.list.mockResolvedValue({ data: {} });
    expect(await ctx.service.recheck(7)).toEqual({
      scanned: 0,
      classified: 0,
      updated: 0,
      review: 0,
      skipped: 0,
    });
    expect(ctx.get).not.toHaveBeenCalled();
  });
  it('paginates the INBOX query, deduplicates IDs and processes at most four messages concurrently', async () => {
    const ctx = setup();
    ctx.list
      .mockResolvedValueOnce({ data: { messages: [{ id: 'm1' }], nextPageToken: 'next' } })
      .mockResolvedValueOnce({
        data: { messages: Array.from({ length: 9 }, (_, i) => ({ id: 'm' + (i + 1) })) },
      });
    let active = 0;
    let peak = 0;
    ctx.classify.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { ...classification };
    });
    expect(await ctx.service.recheck(7)).toEqual({
      scanned: 9,
      classified: 9,
      updated: 9,
      review: 0,
      skipped: 0,
    });
    const query = {
      userId: 'me',
      q: 'in:inbox after:' + (Date.parse(now) / 1000 - 7 * 86400),
      maxResults: 500,
    };
    expect(ctx.list).toHaveBeenNthCalledWith(1, { ...query, pageToken: undefined });
    expect(ctx.list).toHaveBeenNthCalledWith(2, { ...query, pageToken: 'next' });
    expect(ctx.get).toHaveBeenCalledTimes(9);
    expect(peak).toBe(4);
    expect(ctx.store.apps[0].events).toHaveLength(10);
  });
  it('does not duplicate an event when rechecks overlap', async () => {
    const ctx = setup();
    await Promise.all([ctx.service.recheck(7), ctx.service.recheck(7)]);
    expect(ctx.store.apps[0].events).toHaveLength(2);
    expect(ctx.receive).toHaveBeenCalledOnce();
  });
  it('skips deleted messages but propagates transient Gmail failures without marking them', async () => {
    const ctx = setup();
    ctx.get.mockRejectedValue({ code: 404 });
    expect((await ctx.service.recheck(7)).skipped).toBe(1);
    ctx.store.processed.clear();
    ctx.get.mockRejectedValue({ code: 503 });
    await expect(ctx.service.recheck(7)).rejects.toEqual({ code: 503 });
    expect(ctx.store.processed.size).toBe(0);
  });
  it('propagates classification failure and leaves the message retryable', async () => {
    const ctx = setup();
    ctx.store.processed.clear();
    ctx.classify.mockRejectedValue(new Error('Gemini unavailable'));
    await expect(ctx.service.recheck(7)).rejects.toThrow('Gemini unavailable');
    expect(ctx.store.processed.size).toBe(0);
    expect(ctx.store.apps[0].events).toHaveLength(1);
  });
  it('preserves normal notification duplicate handling', async () => {
    const ctx = setup();
    ctx.store.processed.clear();
    ctx.store.apps[0].events.push(event());
    await ctx.service.processNotification({ emailAddress: 'owner@gmail.com', historyId: '200' });
    expect(ctx.receive).not.toHaveBeenCalled();
    expect(ctx.store.apps[0].events[1].type).toBe('online_assessment');
    expect(ctx.store.processed.has('m1')).toBe(true);
  });
});
