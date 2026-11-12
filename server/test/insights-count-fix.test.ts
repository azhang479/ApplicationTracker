import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import type { Application, Classification, Event, Status } from '../src/domain.js';
import { Tracker } from '../src/service.js';
import { FirestoreStore } from '../src/store.js';
import { application, fakeAI, ResumeStore } from './resume-fixtures.js';
import {
  applicationPath,
  applicationsForStage,
  buildFlow,
  filterApplied,
} from '../../web/src/flow';

const email = (id = 'old', date = '2026-06-02') => ({
  id,
  date,
  from: 'hiring@example.com',
  subject: 'Application update',
  snippet: '',
  gmailLink: `https://mail.google.com/mail/u/0/#all/${id}`,
});
const classification = (
  category: Classification['category'],
  interviewRound = 0,
): Classification => ({
  isJobRelated: true,
  category,
  interviewRound,
  company: 'JPMorgan Chase & Co.',
  title: 'Software Engineer',
  jobId: '',
  summary: '',
});
const event = (status: Status, extra: Partial<Event> = {}): Event => ({
  at: '2026-06-02',
  status,
  type: 'other',
  ...extra,
});
function setup(status: Status = 'Applied', interviewRound?: number) {
  const store = new ResumeStore();
  store.apps = [
    { ...application(), status, ...(interviewRound !== undefined ? { interviewRound } : {}) },
  ];
  return { store, tracker: new Tracker(store, fakeAI(), () => '2026-06-05T00:00:00Z') };
}

describe('status-gated flow membership', () => {
  it.each(['Applied', 'Rejected', 'Offer', 'Online Assessment'] as const)(
    'ignores phantom round metadata on %s apps/events',
    (status) => {
      const app = {
        ...application(),
        status,
        interviewRound: 5,
        events: [event(status, { interviewRound: 4 })],
      };
      expect(applicationPath(app).some((stage) => stage.startsWith('Interview '))).toBe(false);
      expect(buildFlow([app]).interviews).toBe(0);
    },
  );
  it('uses only genuine Interview entries for skipped-round fill-in', () => {
    const app = {
      ...application(),
      status: 'Rejected' as const,
      interviewRound: 5,
      events: [event('Interview', { interviewRound: 3 }), event('Rejected', { interviewRound: 5 })],
    };
    expect(applicationPath(app)).toEqual([
      'Applications',
      'Interview 1',
      'Interview 2',
      'Interview 3',
      'Rejected',
    ]);
    expect(applicationPath({ ...app, events: [event('Interview')] })).toEqual([
      'Applications',
      'Interview 1',
      'Rejected',
    ]);
    expect(
      applicationPath({ ...app, status: 'Interview', interviewRound: undefined, events: [] }),
    ).toEqual(['Applications', 'Interview 1']);
  });
  it('counts completion history once after a new OA, without inventing completion for OA-only', () => {
    const completed = {
      ...application(),
      status: 'Online Assessment' as const,
      events: [event('OA Completed'), event('Online Assessment'), event('OA Completed')],
    };
    const onlyOA = {
      ...application(),
      events: [
        event('Online Assessment'),
        event('Online Assessment', { type: 'assessment_completed' }),
      ],
      status: 'Online Assessment' as const,
    };
    expect(applicationPath(onlyOA)).toEqual(['Applications', 'Online Assessment']);
    expect(
      buildFlow([completed, onlyOA]).nodes.find((node) => node.id === 'OA Completed')?.count,
    ).toBe(1);
  });
  it('matches every node count to its application membership, including inferred rounds and date filters', () => {
    const apps = [
      {
        ...application(),
        id: 'history',
        status: 'Rejected' as const,
        events: [event('Interview', { interviewRound: 3 })],
      },
      { ...application(), id: 'current', status: 'Interview' as const },
      { ...application(), id: 'phantom', interviewRound: 5 },
      {
        ...application(),
        id: 'oa',
        status: 'Online Assessment' as const,
        events: [event('OA Completed'), event('OA Completed')],
      },
    ];
    for (const node of buildFlow(apps).nodes)
      expect(applicationsForStage(apps, node.id)).toHaveLength(node.count);
    expect(applicationsForStage(apps, 'Interview 2').map((app) => app.id)).toEqual(['history']);
    expect(applicationsForStage(apps, 'Interview 1').map((app) => app.id)).toEqual([
      'history',
      'current',
    ]);
    expect(applicationsForStage(apps, 'OA Completed').map((app) => app.id)).toEqual(['oa']);
    expect(applicationsForStage([], 'Applications')).toEqual([]);
    expect(applicationsForStage(apps, 'Offer')).toEqual([]);
    const filtered = filterApplied(
      apps.map((app, i) => ({ ...app, appliedAt: i ? '2026-06-01' : '2025-01-01' })),
      30,
      Date.parse('2026-06-10'),
    );
    expect(applicationsForStage(filtered, 'Interview 1').map((app) => app.id)).toEqual(['current']);
  });
});

describe('round metadata writes', () => {
  it.each(['Offer', 'Rejected'] as const)('does not attach rounds to %s emails', async (status) => {
    const { store, tracker } = setup(status, 4);
    await store.exclusive(() => tracker.receive(email(), classification('interview', 3)));
    expect(store.apps[0].status).toBe(status);
    expect(store.apps[0]).not.toHaveProperty('interviewRound');
    expect(store.apps[0].events[0]).toMatchObject({ status, type: 'interview' });
    expect(store.apps[0].events[0]).not.toHaveProperty('interviewRound');
    expect(buildFlow(store.apps).interviews).toBe(0);
  });
  it('clears the application round on patch, retaining genuine history', async () => {
    const { store, tracker } = setup();
    await tracker.patch('job', { status: 'Interview', interviewRound: 3 });
    await tracker.patch('job', { status: 'Applied' });
    expect(store.apps[0]).not.toHaveProperty('interviewRound');
    expect(store.apps[0].events.at(-1)).not.toHaveProperty('interviewRound');
    expect(buildFlow(store.apps).interviews).toBe(1);
    await tracker.patch('job', { interviewRound: 5 });
    expect(store.apps[0]).not.toHaveProperty('interviewRound');
  });
  it('clears rounds when email rejection leaves Interview', async () => {
    const { store, tracker } = setup('Interview', 3);
    await store.exclusive(() => tracker.receive(email(), classification('rejection')));
    expect(store.apps[0].status).toBe('Rejected');
    expect(store.apps[0]).not.toHaveProperty('interviewRound');
    expect(store.apps[0].events[0]).not.toHaveProperty('interviewRound');
  });
  it.each(['Applied', 'Online Assessment'] as const)(
    'review override to %s cannot create a phantom round',
    async (status) => {
      const { store, tracker } = setup('Interview', 3);
      store.reviews = [
        {
          id: 'old',
          email: email(),
          classification: classification('interview', 4),
          candidates: [],
          resolved: false,
          createdAt: '2026-06-02',
        },
      ];
      await tracker.resolve('old', { type: 'apply', applicationId: 'job', status });
      expect(store.apps[0].status).toBe(status);
      expect(store.apps[0]).not.toHaveProperty('interviewRound');
      expect(store.apps[0].events[0]).not.toHaveProperty('interviewRound');
    },
  );
  it('persists removal through Firestore overwrite, not merge', async () => {
    let stored = { ...application(), status: 'Interview', interviewRound: 3 } as Application;
    const ref = { id: 'job' };
    const transaction = {
      get: async (collection: { name: string }) => ({
        docs: collection.name === 'applications' ? [{ id: 'job', data: () => stored }] : [],
      }),
      set: vi.fn((_ref: unknown, value: Application, options?: { merge: boolean }) => {
        stored = structuredClone(options?.merge ? { ...stored, ...value } : value);
      }),
    };
    const store = new FirestoreStore({
      collection: (name: string) => ({ name, doc: () => ref }),
      runTransaction: async (work: (tx: unknown) => unknown) => work(transaction),
    } as unknown as Firestore);
    await new Tracker(store, fakeAI()).patch('job', { status: 'Applied' });
    expect(stored).not.toHaveProperty('interviewRound');
    expect(transaction.set).toHaveBeenCalledWith(
      ref,
      expect.objectContaining({ status: 'Applied' }),
    );
  });
});

describe('recheck uses previous event state', () => {
  it.each(['Interview', 'OA Completed'] as const)(
    'drops stale %s on a non-latest reclassification and remains duplicate-safe',
    async (stale) => {
      const { store, tracker } = setup('Online Assessment');
      store.apps[0].events = [
        event(stale, {
          type: stale === 'Interview' ? 'interview' : 'assessment_completed',
          interviewRound: 3,
          gmailLink: email().gmailLink,
        }),
        event('Online Assessment', { at: '2026-06-03', gmailLink: email('new').gmailLink }),
      ];
      const before = { status: store.apps[0].status, lastActivityAt: store.apps[0].lastActivityAt };
      expect(
        await store.exclusive(() => tracker.recheckEmail(email(), classification('other'))),
      ).toBe('updated');
      expect(store.apps[0].events[0]).toMatchObject({ type: 'other', status: 'Applied' });
      expect(store.apps[0].events[0]).not.toHaveProperty('interviewRound');
      expect(store.apps[0]).toMatchObject(before);
      expect(store.apps[0].events).toHaveLength(2);
      expect(
        await store.exclusive(() => tracker.recheckEmail(email(), classification('other'))),
      ).toBe('skipped');
      expect(applicationPath(store.apps[0])).toEqual(['Applications', 'Online Assessment']);
    },
  );
  it('sorts previous events chronologically rather than taking the previous array element', async () => {
    const { store, tracker } = setup('Offer');
    store.apps[0].events = [
      event('Interview', {
        at: '2026-06-03',
        interviewRound: 4,
        type: 'interview',
        gmailLink: email().gmailLink,
      }),
      event('Offer', { at: '2026-06-04', gmailLink: email('new').gmailLink }),
      event('Online Assessment', { at: '2026-06-02' }),
    ];
    await store.exclusive(() => tracker.recheckEmail(email(), classification('other')));
    expect(store.apps[0].events[0].status).toBe('Online Assessment');
    expect(store.apps[0].events[0]).not.toHaveProperty('interviewRound');
    expect(store.apps[0].status).toBe('Offer');
  });
  it('preserves legitimate earlier Interview and its round when relabeling a following email', async () => {
    const { store, tracker } = setup('Offer');
    store.apps[0].events = [
      event('Interview', { at: '2026-06-01', interviewRound: 2 }),
      event('Interview', { type: 'interview', interviewRound: 4, gmailLink: email().gmailLink }),
      event('Offer', { at: '2026-06-03', gmailLink: email('new').gmailLink }),
    ];
    await store.exclusive(() => tracker.recheckEmail(email(), classification('other')));
    expect(store.apps[0].events[1]).toMatchObject({ status: 'Interview', interviewRound: 2 });
  });
  it('repairs already-relabeled stale events and uses rejection precedence', async () => {
    const { store, tracker } = setup('Offer');
    store.apps[0].events = [
      event('Interview', { type: 'other', interviewRound: 3, gmailLink: email().gmailLink }),
      event('Offer', { at: '2026-06-03', gmailLink: email('new').gmailLink }),
    ];
    await store.exclusive(() => tracker.recheckEmail(email(), classification('other')));
    expect(store.apps[0].events[0].status).toBe('Applied');
    await store.exclusive(() => tracker.recheckEmail(email(), classification('rejection')));
    expect(store.apps[0].events[0].status).toBe('Rejected');
    expect(store.apps[0].status).toBe('Offer');
  });
  it('latest-event correction removes a leftover app/event round without regressing terminal status', async () => {
    const { store, tracker } = setup('Rejected', 4);
    store.apps[0].events = [
      event('Interview', { type: 'interview', interviewRound: 4, gmailLink: email().gmailLink }),
    ];
    await store.exclusive(() => tracker.recheckEmail(email(), classification('other')));
    expect(store.apps[0].status).toBe('Rejected');
    expect(store.apps[0]).not.toHaveProperty('interviewRound');
    expect(store.apps[0].events[0]).toMatchObject({ status: 'Rejected', type: 'other' });
    expect(store.apps[0].events[0]).not.toHaveProperty('interviewRound');
  });
});
