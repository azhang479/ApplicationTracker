import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { Tracker } from '../src/service.js';
import type { Config } from '../src/config.js';
import type { GmailService } from '../src/gmail.js';
import { fakeAI, ResumeStore } from './resume-fixtures.js';
import { buildFlow } from '../../web/src/flow';
import { assessmentEmailLink } from '../../web/src/assessment';

let server: Server;
let base: string;
let store: ResumeStore;
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = new ResumeStore();
  Object.assign(store.apps[0], {
    status: 'Interview',
    salaryMin: 120000,
    salaryMax: 150000,
    salaryCurrency: 'CAD',
    location: 'Toronto',
    jobId: 'ENG-123',
    workMode: 'hybrid',
  });
  const config = {
    OWNER_EMAIL: 'owner@gmail.com',
    OAUTH_CLIENT_ID: 'test',
    OAUTH_CLIENT_SECRET: 'test-secret',
    EXTENSION_API_KEY: 'test-api-key-for-rounds',
    PUBLIC_URL: 'http://localhost',
  } as Config;
  const app = createApp(config, new Tracker(store, fakeAI()), {} as GmailService, {
    verify: async () => ({
      email: config.OWNER_EMAIL,
      email_verified: true,
      iss: 'accounts.google.com',
    }),
  });
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  vi.restoreAllMocks();
});
function patch(body: unknown, token = 'owner') {
  return fetch(base + '/api/applications/job', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
}
describe('application interview-round PATCH', () => {
  it('updates just the round, preserving omitted job metadata', async () => {
    const before = structuredClone(store.apps[0]);
    const response = await patch({ interviewRound: 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'Interview',
      interviewRound: 3,
      salaryMin: 120000,
      salaryMax: 150000,
      salaryCurrency: 'CAD',
      location: 'Toronto',
      jobId: 'ENG-123',
      workMode: 'hybrid',
    });
    expect(store.apps[0].events).toHaveLength(before.events.length + 1);
    expect(store.apps[0].events.at(-1)).toMatchObject({ status: 'Interview', interviewRound: 3 });
  });
  it.each([0, 6, -1, 1.5, '2', null])(
    'rejects invalid round %s without changing the record',
    async (round) => {
      const before = structuredClone(store.apps[0]);
      expect((await patch({ interviewRound: round })).status).toBe(400);
      expect(store.apps[0]).toEqual(before);
    },
  );
  it('requires dashboard authentication', async () => {
    expect((await patch({ interviewRound: 2 }, '')).status).toBe(401);
  });
});

function deleteEvent(
  index: number | string,
  at = '2026-06-02',
  type = 'interview',
  id = 'job',
  token = 'owner',
) {
  return fetch(
    base + '/api/applications/' + id + '/events/' + index + '?' + new URLSearchParams({ at, type }),
    {
      method: 'DELETE',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    },
  );
}
describe('guarded timeline deletion', () => {
  beforeEach(() => {
    Object.assign(store.apps[0], { status: 'Applied', interviewRound: 3 });
    store.apps[0].events = [
      { at: '2026-06-01', type: 'applied', status: 'Applied' },
      { at: '2026-06-02', type: 'interview', status: 'Interview', interviewRound: 3 },
      { at: '2026-06-03', type: 'status_change', status: 'Applied' },
    ];
  });
  it('deletes the matching entry without changing status and removes its flow membership', async () => {
    expect(buildFlow(store.apps).interviews).toBe(1);
    const response = await deleteEvent(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'Applied',
      lastActivityAt: '2026-06-03',
    });
    expect(store.apps[0].events).toHaveLength(2);
    expect(buildFlow(store.apps).interviews).toBe(0);
  });
  it('recomputes last activity by latest remaining timestamp, not array position', async () => {
    store.apps[0].events.reverse();
    expect((await deleteEvent(0, '2026-06-03', 'status_change')).status).toBe(200);
    expect(store.apps[0].lastActivityAt).toBe('2026-06-02');
  });
  it('falls back to appliedAt when deleting the last event, preserving current Interview status', async () => {
    store.apps[0].status = 'Interview';
    store.apps[0].events = [store.apps[0].events[1]];
    expect((await deleteEvent(0)).status).toBe(200);
    expect(store.apps[0].lastActivityAt).toBe(store.apps[0].appliedAt);
    expect(store.apps[0].status).toBe('Interview');
    expect(buildFlow(store.apps).interviews).toBe(1);
  });
  it.each([
    ['2026-06-04', 'interview'],
    ['2026-06-02', 'other'],
  ])('rejects a stale timestamp/type guard with 409', async (at, type) => {
    const before = structuredClone(store.apps[0]);
    const response = await deleteEvent(1, at, type);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Timeline changed. Reload the application and try again.',
    });
    expect(store.apps[0]).toEqual(before);
  });
  it('rejects a stale index after another deletion shifted the array', async () => {
    expect((await deleteEvent(0, '2026-06-01', 'applied')).status).toBe(200);
    expect((await deleteEvent(1)).status).toBe(409);
    expect(store.apps[0].events).toHaveLength(2);
  });
  it.each([
    ['missing', 0],
    ['job', 99],
  ])('returns 404 for missing application/event', async (id, index) => {
    expect((await deleteEvent(index, '2026-06-02', 'interview', String(id))).status).toBe(404);
  });
  it.each(['-1', '1.5', 'wrong'])('rejects invalid index %s', async (index) => {
    expect((await deleteEvent(index)).status).toBe(400);
  });
  it('requires both guard fields and dashboard owner authentication', async () => {
    expect(
      (
        await fetch(base + '/api/applications/job/events/1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer owner' },
        })
      ).status,
    ).toBe(400);
    expect((await deleteEvent(1, '2026-06-02', 'interview', 'job', '')).status).toBe(401);
  });
  it('removes the derived OA email link when its event is deleted', async () => {
    store.apps[0].events = [
      {
        at: '2026-06-02',
        type: 'online_assessment',
        status: 'Online Assessment',
        gmailLink: 'https://mail.google.com/mail/u/0/#all/oa',
      },
    ];
    expect(assessmentEmailLink(store.apps[0])).toBeTruthy();
    expect((await deleteEvent(0, '2026-06-02', 'online_assessment')).status).toBe(200);
    expect(assessmentEmailLink(store.apps[0])).toBeUndefined();
  });
});
