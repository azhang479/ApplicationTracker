import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { Tracker } from '../src/service.js';
import type { Config } from '../src/config.js';
import type { GmailService } from '../src/gmail.js';
import { fakeAI, ResumeStore } from './resume-fixtures.js';

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
