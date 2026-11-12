import { describe, expect, it } from 'vitest';
import {
  classificationSchema,
  emailProgress,
  interviewRoundSchema,
  type Classification,
  type Status,
} from '../src/domain.js';
import { patchSchema, resolveSchema, Tracker } from '../src/service.js';
import { application, fakeAI, ResumeStore } from './resume-fixtures.js';
import { applicationPath, buildFlow } from '../../web/src/flow';
import { sortApplications } from '../../web/src/sort';
import { statusLabel } from '../../web/src/types';

const classified: Classification = {
  isJobRelated: true,
  category: 'interview',
  company: 'JPMorgan Chase & Co.',
  title: 'Software Engineer',
  jobId: '',
  summary: 'Interview invitation',
};
const email = {
  id: 'round-email',
  from: 'hiring@example.com',
  subject: 'Second round interview',
  date: '2026-06-02',
  snippet: 'Please interview',
  gmailLink: 'https://mail.google.com/mail/u/0/#all/round-email',
};
function setup(status: Status = 'Applied', interviewRound?: number) {
  const store = new ResumeStore();
  store.apps = [
    { ...application(), status, ...(interviewRound !== undefined ? { interviewRound } : {}) },
  ];
  return { store, tracker: new Tracker(store, fakeAI(), () => '2026-06-03T00:00:00.000Z') };
}
describe('interview-round progression', () => {
  it.each([
    ['Applied', undefined, 3, 'Interview', 3],
    ['Applied', undefined, 0, 'Interview', 1],
    ['Interview', undefined, 0, 'Interview', 1],
    ['Interview', 2, 0, 'Interview', 2],
    ['Interview', 4, 2, 'Interview', 4],
    ['Interview', 2, 5, 'Interview', 5],
    ['Ghosted', undefined, 2, 'Interview', 2],
    ['Ghosted', 3, 0, 'Interview', 3],
    ['Offer', 3, 5, 'Offer', 3],
    ['Rejected', 2, 4, 'Rejected', 2],
  ] as const)('%s / R%s + stated %s → %s / R%s', (status, currentRound, stated, next, round) => {
    expect(
      emailProgress(
        { status, interviewRound: currentRound },
        { ...classified, interviewRound: stated },
      ),
    ).toEqual({ status: next, interviewRound: round });
  });
  it('gives rejection precedence, including explicit review overrides', () => {
    expect(
      emailProgress(
        { status: 'Interview', interviewRound: 4 },
        { ...classified, category: 'rejection' },
        'Interview',
      ),
    ).toEqual({ status: 'Rejected', interviewRound: 4 });
    expect(
      emailProgress(
        { status: 'Offer', interviewRound: 4 },
        { ...classified, category: 'rejection' },
      ),
    ).toEqual({ status: 'Rejected', interviewRound: 4 });
  });
  it('records rounds on received events and never decreases with later interview emails', async () => {
    const { store, tracker } = setup();
    for (const round of [2, 0, 1, 5])
      await store.exclusive(() =>
        tracker.receive(
          { ...email, id: `m-${round}`, gmailLink: email.gmailLink + round },
          { ...classified, interviewRound: round },
        ),
      );
    expect(store.apps[0]).toMatchObject({ status: 'Interview', interviewRound: 5 });
    expect(store.apps[0].events.map((event) => event.interviewRound)).toEqual([2, 2, 2, 5]);
  });
  it.each(['Applied', 'Interview', 'Offer', 'Rejected'] as const)(
    'uses shared round progression when applying review to %s',
    async (status) => {
      const { store, tracker } = setup(status, status === 'Applied' ? undefined : 4);
      store.reviews = [
        {
          id: email.id,
          email,
          classification: { ...classified, interviewRound: 2 },
          candidates: [],
          createdAt: email.date,
          resolved: false,
        },
      ];
      await tracker.resolve(email.id, { type: 'apply', applicationId: 'job', status: 'Interview' });
      expect(store.apps[0]).toMatchObject({
        status: status === 'Applied' ? 'Interview' : status,
        interviewRound: status === 'Applied' ? 2 : 4,
      });
      expect(store.apps[0].events).toHaveLength(1);
    },
  );
  it('records a round-only manual edit as a timeline event', async () => {
    const { store, tracker } = setup('Interview');
    await tracker.patch('job', patchSchema.parse({ interviewRound: 3 }));
    expect(store.apps[0]).toMatchObject({ status: 'Interview', interviewRound: 3 });
    expect(store.apps[0].events[0]).toMatchObject({
      type: 'status_change',
      status: 'Interview',
      interviewRound: 3,
    });
  });
  it.each([true, false])(
    'rechecks the same category without duplicates; latest=%s',
    async (latest) => {
      const { store, tracker } = setup('Interview', 1);
      store.apps[0].events = [
        { at: email.date, type: 'interview', status: 'Interview', gmailLink: email.gmailLink },
      ];
      if (!latest)
        store.apps[0].events.push({
          at: '2026-06-04',
          type: 'interview',
          status: 'Interview',
          interviewRound: 1,
          gmailLink: 'https://mail.google.com/mail/u/0/#all/newer',
        });
      const beforeActivity = store.apps[0].lastActivityAt;
      const result = await store.exclusive(() =>
        tracker.recheckEmail(email, { ...classified, interviewRound: 3 }),
      );
      expect(result).toBe('updated');
      expect(store.apps[0].events).toHaveLength(latest ? 1 : 2);
      expect(store.apps[0].events[0].interviewRound).toBe(3);
      expect(store.apps[0].interviewRound).toBe(latest ? 3 : 1);
      expect(store.apps[0].lastActivityAt).toBe(beforeActivity);
      expect(
        await store.exclusive(() =>
          tracker.recheckEmail(email, { ...classified, interviewRound: 3 }),
        ),
      ).toBe('skipped');
    },
  );
  it('corrects a misclassified latest email and retains rejection precedence', async () => {
    const { store, tracker } = setup('Rejected', 2);
    store.apps[0].events = [
      { at: email.date, type: 'other', status: 'Applied', gmailLink: email.gmailLink },
    ];
    await store.exclusive(() => tracker.recheckEmail(email, { ...classified, interviewRound: 4 }));
    expect(store.apps[0]).toMatchObject({ status: 'Rejected', interviewRound: 2 });
    expect(store.apps[0].events[0]).toMatchObject({
      type: 'interview',
      status: 'Rejected',
      interviewRound: 4,
    });
  });
  it('corrects a latest non-interview event into a numbered interview', async () => {
    const { store, tracker } = setup();
    store.apps[0].events = [
      { at: email.date, type: 'other', status: 'Applied', gmailLink: email.gmailLink },
    ];
    await store.exclusive(() => tracker.recheckEmail(email, { ...classified, interviewRound: 2 }));
    expect(store.apps[0]).toMatchObject({ status: 'Interview', interviewRound: 2 });
    expect(store.apps[0].events).toHaveLength(1);
    expect(store.apps[0].events[0]).toMatchObject({
      type: 'interview',
      status: 'Interview',
      interviewRound: 2,
    });
  });
  it('does not reduce a recorded round or increase the current round for an unknown recheck', async () => {
    const { store, tracker } = setup('Interview', 2);
    store.apps[0].events = [
      {
        at: email.date,
        type: 'interview',
        status: 'Interview',
        interviewRound: 4,
        gmailLink: email.gmailLink,
      },
    ];
    expect(
      await store.exclusive(() =>
        tracker.recheckEmail(email, { ...classified, interviewRound: 0 }),
      ),
    ).toBe('skipped');
    expect(store.apps[0].interviewRound).toBe(2);
    expect(store.apps[0].events[0].interviewRound).toBe(4);
  });
});
describe('round schemas', () => {
  it.each([0, 6, -1, 1.5, '2', null])('rejects application/review round %s', (round) => {
    expect(interviewRoundSchema.safeParse(round).success).toBe(false);
    expect(patchSchema.safeParse({ interviewRound: round }).success).toBe(false);
    expect(
      resolveSchema.safeParse({
        type: 'apply',
        applicationId: 'job',
        status: 'Interview',
        interviewRound: round,
      }).success,
    ).toBe(false);
  });
  it('accepts optional legacy fields, valid rounds and classification unknown zero', () => {
    expect(patchSchema.parse({ status: 'Interview' })).toMatchObject({ status: 'Interview' });
    for (let round = 1; round <= 5; round++)
      expect(patchSchema.parse({ interviewRound: round }).interviewRound).toBe(round);
    expect(classificationSchema.parse(classified).interviewRound).toBeUndefined();
    expect(classificationSchema.parse({ ...classified, interviewRound: 0 }).interviewRound).toBe(0);
    for (const value of [-1, 6, 2.5, '2'])
      expect(classificationSchema.safeParse({ ...classified, interviewRound: value }).success).toBe(
        false,
      );
  });
});
describe('round flow, labels and sorting', () => {
  it('fills all skipped rounds once, from both current and historical rounds', () => {
    const app = {
      ...application(),
      status: 'Interview' as const,
      interviewRound: 3,
      events: [
        { at: '2026-06-01', type: 'interview', status: 'Interview' as const, interviewRound: 1 },
      ],
    };
    expect(applicationPath(app)).toEqual([
      'Applications',
      'Interview 1',
      'Interview 2',
      'Interview 3',
    ]);
    const ended = {
      ...app,
      status: 'Rejected' as const,
      events: [
        ...app.events,
        { at: '2026-06-02', type: 'interview', status: 'Interview' as const, interviewRound: 5 },
      ],
    };
    expect(applicationPath(ended)).toEqual([
      'Applications',
      'Interview 1',
      'Interview 2',
      'Interview 3',
      'Interview 4',
      'Interview 5',
      'Rejected',
    ]);
    const flow = buildFlow([app, ended]);
    expect(flow.interviews).toBe(2);
    expect(flow.nodes.find((node) => node.id === 'Interview 3')?.count).toBe(2);
    expect(flow.nodes.find((node) => node.id === 'Interview 5')?.count).toBe(1);
    expect(flow.links).toContainEqual({ source: 'Interview 1', target: 'Interview 2', value: 2 });
  });
  it('keeps legacy interviews at round one and does not invent interviews for offers', () => {
    expect(applicationPath({ ...application(), status: 'Interview' })).toEqual([
      'Applications',
      'Interview 1',
    ]);
    expect(applicationPath({ ...application(), status: 'Offer' })).toEqual([
      'Applications',
      'Offer',
    ]);
    expect(buildFlow([]).interviews).toBe(0);
    expect(statusLabel({ status: 'Interview' })).toBe('Interview · R1');
    expect(statusLabel({ status: 'Interview', interviewRound: 4 })).toBe('Interview · R4');
  });
  it('sorts Interview rounds between OA Completed and Offer in both directions', () => {
    const apps = [5, undefined, 3].map((round, i) => ({
      ...application(),
      id: String(i),
      status: 'Interview' as const,
      interviewRound: round,
    }));
    const mixed = [
      ...apps,
      { ...application(), id: 'oa', status: 'OA Completed' as const },
      { ...application(), id: 'offer', status: 'Offer' as const },
    ];
    expect(sortApplications(mixed, 'status', 'asc').map((app) => app.id)).toEqual([
      'oa',
      '1',
      '2',
      '0',
      'offer',
    ]);
    expect(sortApplications(mixed, 'status', 'desc').map((app) => app.id)).toEqual([
      'offer',
      '0',
      '2',
      '1',
      'oa',
    ]);
  });
});
