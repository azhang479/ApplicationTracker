import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { Tracker } from '../src/service.js';
import type { Config } from '../src/config.js';
import type { GmailService } from '../src/gmail.js';
import { CompilationError } from '../src/resume-compiler.js';
import { MAX_RESUME_BYTES } from '../src/resume-domain.js';
import { draft, fakeAI, resume, ResumeStore, sampleTex } from './resume-fixtures.js';

let server: Server;
let base: string;
let store: ResumeStore;
let ai: ReturnType<typeof fakeAI>;
let compile: ReturnType<typeof vi.fn>;
const config = {
  OWNER_EMAIL: 'owner@gmail.com',
  OAUTH_CLIENT_ID: 'client',
  OAUTH_CLIENT_SECRET: 'private-secret',
  EXTENSION_API_KEY: 'private-key-long-enough',
  PUBLIC_URL: 'https://tracker.test',
  RESUME_FILENAME_PREFIX: 'Austin_Zhang_Resume',
} as Config;
beforeEach(async () => {
  store = new ResumeStore();
  ai = fakeAI();
  compile = vi.fn().mockResolvedValue({ pdf: Buffer.from('%PDF-1.5\nStub'), pageCount: 1 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const app = createApp(
    config,
    new Tracker(store, ai),
    {} as GmailService,
    {
      verify: async (token) => {
        if (token === 'bad') throw new Error('Invalid token');
        return {
          email: token === 'owner' ? config.OWNER_EMAIL : 'other@gmail.com',
          email_verified: true,
          iss: 'accounts.google.com',
        };
      },
    },
    { compile },
  );
  server = await new Promise<Server>((resolve) => {
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
async function request(path: string, method = 'GET', body?: unknown, token = 'owner') {
  return fetch(base + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function generate(body: unknown = {}) {
  store.resumes = [resume()];
  const response = await request('/applications/job/tailor', 'POST', body);
  expect(response.status).toBe(200);
  return response.json();
}
describe('resume CRUD and limits', () => {
  it('lists, creates, replaces and deletes resumes', async () => {
    expect(await (await request('/resumes')).json()).toEqual([]);
    const created = await request('/resumes', 'POST', { label: 'SWE', tex: sampleTex });
    expect(created.status).toBe(201);
    const data = await created.json();
    expect(data).toMatchObject({
      label: 'SWE',
      tex: sampleTex,
      id: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(await (await request('/resumes')).json()).toEqual([data]);
    expect(
      (await request('/resumes/' + data.id, 'PUT', { label: 'ML', tex: sampleTex })).status,
    ).toBe(200);
    expect((await request('/resumes/' + data.id, 'DELETE')).status).toBe(204);
    expect(await (await request('/resumes')).json()).toEqual([]);
    expect(
      (await request('/resumes/missing', 'PUT', { label: 'SWE', tex: sampleTex })).status,
    ).toBe(404);
    expect((await request('/resumes/missing', 'DELETE')).status).toBe(404);
  });
  it.each([
    { label: '', tex: sampleTex },
    { label: 'SWE_ML', tex: sampleTex },
    { label: 'a'.repeat(21), tex: sampleTex },
    { label: 'SWE', tex: 'Not a document' },
    { label: 'SWE', tex: sampleTex + 'x'.repeat(MAX_RESUME_BYTES) },
  ])('rejects invalid resume %#', async (body) => {
    expect((await request('/resumes', 'POST', body)).status).toBe(400);
    expect(store.resumes).toEqual([]);
  });
  it('accepts a 200 KB tex even when JSON escaping takes more than 1 MB', async () => {
    const prefix = '\\begin{document}';
    const tex = prefix + '\u0001'.repeat(MAX_RESUME_BYTES - prefix.length);
    expect((await request('/resumes', 'POST', { label: 'SWE', tex })).status).toBe(201);
  });
  it('bounds oversized JSON bodies', async () => {
    expect(
      (await request('/resumes', 'POST', { label: 'SWE', tex: 'x'.repeat(2 * 1024 * 1024) }))
        .status,
    ).toBe(413);
  });
  it('enforces five resumes atomically, allowing updates at the limit and slots after deletion', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request('/resumes', 'POST', { label: 'R' + i, tex: sampleTex }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 201, 201, 201, 201, 400,
    ]);
    const id = store.resumes[0].id;
    expect((await request('/resumes/' + id, 'PUT', { label: 'New', tex: sampleTex })).status).toBe(
      200,
    );
    await request('/resumes/' + id, 'DELETE');
    expect((await request('/resumes', 'POST', { label: 'Six', tex: sampleTex })).status).toBe(201);
  });
  it.each([
    ['/resumes', 'GET'],
    ['/resumes', 'POST'],
    ['/resumes/x', 'PUT'],
    ['/resumes/x', 'DELETE'],
    ['/applications/job/tailor', 'POST'],
    ['/applications/job/tailoring', 'GET'],
    ['/applications/job/tailoring', 'PATCH'],
    ['/applications/job/resume.pdf', 'GET'],
  ])('requires owner authentication for %s %s', async (path, method) => {
    const body = ['GET', 'DELETE'].includes(method) ? undefined : {};
    expect((await request(path, method, body, '')).status).toBe(401);
    expect((await request(path, method, body, 'other')).status).toBe(403);
    expect((await request(path, method, body, 'bad')).status).toBe(401);
  });
});
describe('tailoring generation and decisions', () => {
  it('returns 400 without resumes and 404 for a missing application', async () => {
    expect((await request('/applications/job/tailor', 'POST', {})).status).toBe(400);
    expect((await request('/applications/missing/tailor', 'POST', {})).status).toBe(404);
  });
  it('generates pending edits using the job and all resumes and reuses saved tailoring', async () => {
    store.resumes = [resume(), resume('ml', 'ML')];
    const response = await request('/applications/job/tailor', 'POST', {});
    const data = await response.json();
    expect(data).toMatchObject({
      resumeId: 'swe',
      resumeLabel: 'SWE',
      generatedAt: expect.any(String),
      staleEditIds: [],
      baseMissing: false,
      edits: [{ ...draft, id: expect.any(String), state: 'pending', stale: false }],
    });
    expect(ai.tailor.mock.calls[0][0]).toEqual({
      job: {
        company: store.apps[0].company,
        title: store.apps[0].title,
        jobSummary: store.apps[0].jobSummary,
        keyRequirements: store.apps[0].keyRequirements,
      },
      resumes: [resume('ml', 'ML'), resume()],
    });
    expect(await (await request('/applications/job/tailor', 'POST', {})).json()).toEqual(data);
    expect(ai.tailor).toHaveBeenCalledOnce();
    expect(store.apps[0].lastActivityAt).toBe('2026-06-01');
    expect(store.apps[0].tailoring!.edits[0]).not.toHaveProperty('stale');
  });
  it('regenerates only with an explicit true flag and resets decisions', async () => {
    const first = await generate();
    await request('/applications/job/tailoring', 'PATCH', {
      edits: [{ id: first.edits[0].id, state: 'accepted' }],
    });
    const second = await (
      await request('/applications/job/tailor', 'POST', { regenerate: true })
    ).json();
    expect(ai.tailor).toHaveBeenCalledTimes(2);
    expect(second.edits[0].id).not.toBe(first.edits[0].id);
    expect(second.edits[0].state).toBe('pending');
    expect((await request('/applications/job/tailor', 'POST', { regenerate: 'true' })).status).toBe(
      400,
    );
  });
  it('falls back to the first resume and drops unsafe, missing and overlapping AI edits', async () => {
    store.resumes = [resume()];
    ai.tailor.mockResolvedValue({
      resumeId: 'unknown',
      reason: 'Fit',
      edits: [
        draft,
        { ...draft, find: 'reliable services' },
        { ...draft, find: 'Missing' },
        { ...draft, replace: '\\input{secret}' },
        {},
        null,
      ],
    });
    const data = await (await request('/applications/job/tailor', 'POST', {})).json();
    expect(data.resumeId).toBe('swe');
    expect(data.edits).toHaveLength(1);
    expect(data.edits[0].find).toBe(draft.find);
  });
  it('accepts an empty edit proposal', async () => {
    ai.tailor.mockResolvedValue({ resumeId: 'swe', reason: 'Already suitable', edits: [] });
    expect((await generate()).edits).toEqual([]);
  });
  it('does not save an obsolete proposal when the base changes during generation', async () => {
    store.resumes = [resume()];
    ai.tailor.mockImplementation(async () => {
      store.resumes[0].tex += '\nChanged';
      return { resumeId: 'swe', reason: 'Fit', edits: [draft] };
    });
    expect((await request('/applications/job/tailor', 'POST', {})).status).toBe(409);
    expect(store.apps[0].tailoring).toBeUndefined();
  });
  it('propagates AI failures without saving partial tailoring', async () => {
    store.resumes = [resume()];
    ai.tailor.mockRejectedValue(new Error('AI unavailable'));
    expect((await request('/applications/job/tailor', 'POST', {})).status).toBe(503);
    expect(store.apps[0].tailoring).toBeUndefined();
  });
  it('updates states and plain-text replacements without pre-escaping', async () => {
    const data = await generate();
    const response = await request('/applications/job/tailoring', 'PATCH', {
      edits: [{ id: data.edits[0].id, state: 'accepted', replace: 'R&D 20%' }],
    });
    expect(response.status).toBe(200);
    expect((await response.json()).edits[0]).toMatchObject({
      state: 'accepted',
      replace: 'R&D 20%',
    });
    const rejected = await request('/applications/job/tailoring', 'PATCH', {
      edits: [{ id: data.edits[0].id, state: 'rejected', replace: '' }],
    });
    expect(rejected.status).toBe(200);
  });
  it.each([
    { state: 'unknown' },
    { replace: '\\bad' },
    { replace: '{bad}' },
    { replace: '~' },
    { replace: '^' },
    { replace: 'x'.repeat(301) },
    {},
    { find: 'Changed' },
  ])('rejects invalid PATCH %# without mutations', async (changes) => {
    const data = await generate();
    expect(
      (
        await request('/applications/job/tailoring', 'PATCH', {
          edits: [{ id: data.edits[0].id, ...changes }],
        })
      ).status,
    ).toBe(400);
    expect(store.apps[0].tailoring!.edits[0].state).toBe('pending');
    expect(store.apps[0].tailoring!.edits[0].replace).toBe(draft.replace);
  });
  it('rejects missing, duplicate and unknown edit IDs', async () => {
    const data = await generate();
    expect((await request('/applications/job/tailoring', 'PATCH', { edits: [] })).status).toBe(400);
    expect(
      (
        await request('/applications/job/tailoring', 'PATCH', {
          edits: [{ id: 'unknown', state: 'accepted' }],
        })
      ).status,
    ).toBe(400);
    const change = { id: data.edits[0].id, state: 'accepted' };
    expect(
      (await request('/applications/job/tailoring', 'PATCH', { edits: [change, change] })).status,
    ).toBe(400);
    expect(
      (await request('/applications/missing/tailoring', 'PATCH', { edits: [change] })).status,
    ).toBe(404);
  });
  it('flags stale edits after changes and missing bases after deletion', async () => {
    const data = await generate();
    store.resumes[0].tex = sampleTex.replace(draft.find, 'Other words');
    const view = await (await request('/applications/job/tailoring')).json();
    expect(view.staleEditIds).toEqual([data.edits[0].id]);
    expect(view.edits[0].stale).toBe(true);
    await request('/resumes/swe', 'DELETE');
    expect((await (await request('/applications/job/tailoring')).json()).baseMissing).toBe(true);
    expect((await request('/applications/job/resume.pdf')).status).toBe(400);
  });
});
describe('PDF download', () => {
  it('compiles only accepted edits with escaping and returns PDF headers without storing a PDF', async () => {
    const data = await generate();
    await request('/applications/job/tailoring', 'PATCH', {
      edits: [{ id: data.edits[0].id, state: 'accepted', replace: 'R&D 20%' }],
    });
    const response = await request('/applications/job/resume.pdf');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="Austin_Zhang_Resume_SWE_JPMorganChaseCo.pdf"',
    );
    expect(response.headers.get('x-page-count')).toBe('1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toContain('%PDF-');
    expect(compile).toHaveBeenCalledWith(sampleTex.replace(draft.find, 'R\\&D 20\\%'));
    expect(store.apps[0]).not.toHaveProperty('pdf');
    expect(store.resumes[0].tex).toBe(sampleTex);
  });
  it('skips stale accepted edits and flags them on the download', async () => {
    const data = await generate();
    await request('/applications/job/tailoring', 'PATCH', {
      edits: [{ id: data.edits[0].id, state: 'accepted' }],
    });
    store.resumes[0].tex = sampleTex.replace(draft.find, 'Rewritten base');
    const response = await request('/applications/job/resume.pdf');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.headers.get('x-stale-edit-ids')!)).toEqual([data.edits[0].id]);
    expect(compile).toHaveBeenCalledWith(store.resumes[0].tex);
  });
  it('returns 422 with compilation diagnostics and no PDF', async () => {
    await generate();
    compile.mockRejectedValue(new CompilationError('Last twenty lines'));
    const response = await request('/applications/job/resume.pdf');
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Resume compilation failed',
      log: 'Last twenty lines',
    });
  });
  it('requires tailoring and an existing application', async () => {
    expect((await request('/applications/job/resume.pdf')).status).toBe(400);
    expect((await request('/applications/missing/resume.pdf')).status).toBe(404);
    expect(compile).not.toHaveBeenCalled();
  });
});
