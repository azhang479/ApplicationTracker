import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { GmailService } from '../src/gmail.js';
import type { Tracker } from '../src/service.js';

const config = {
  OWNER_EMAIL: 'owner@gmail.com',
  OAUTH_CLIENT_ID: 'client',
  OAUTH_CLIENT_SECRET: 'private-oauth-secret',
  EXTENSION_API_KEY: 'private-extension-key-long-enough',
  PUBLIC_URL: 'https://tracker.test',
  PUSH_SERVICE_ACCOUNT: 'push@test.iam.gserviceaccount.com',
} as Config;
const input = {
  url: 'https://example.com/job',
  pageTitle: 'Engineer',
  text: 'PRIVATE FULL PAGE TEXT',
};
let server: Server;
const capture = vi.fn();
const processNotification = vi.fn();
let log: ReturnType<typeof vi.spyOn>;
let base: string;
beforeEach(async () => {
  capture.mockReset();
  processNotification.mockReset();
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const app = createApp(
    config,
    { capture } as unknown as Tracker,
    { processNotification } as unknown as GmailService,
    {
      verify: async () => ({
        email: config.PUSH_SERVICE_ACCOUNT,
        email_verified: true,
        iss: 'accounts.google.com',
      }),
    },
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
async function post(body: unknown, path = '/api/capture') {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.EXTENSION_API_KEY,
      Authorization: 'Bearer push-token',
    },
    body: JSON.stringify(body),
  });
}
function logged() {
  return JSON.parse(log.mock.calls[0][0] as string);
}
function validationError() {
  try {
    z.object({ salaryMin: z.number() }).parse({ salaryMin: 'invalid' });
  } catch (error) {
    return error;
  }
  throw new Error('Expected invalid fixture');
}
describe('capture request validation and structured errors', () => {
  it.each([
    { ...input, url: '' },
    { ...input, url: 'broken' },
    { ...input, text: 123 },
    { ...input, pageTitle: null },
    {},
  ])('keeps invalid request fields strict', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
    expect(logged().severity).toBe('ERROR');
    expect(logged().issues.length).toBeGreaterThan(0);
    expect(log.mock.calls.flat().join(' ')).not.toContain(input.text);
    expect(log.mock.calls.flat().join(' ')).not.toContain(config.EXTENSION_API_KEY);
  });
  it('returns valid captures unchanged', async () => {
    capture.mockResolvedValue({ company: 'Acme', url: input.url });
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ company: 'Acme', url: input.url });
    expect(log).not.toHaveBeenCalled();
  });
  it('logs the message and stack, redacting credentials and page contents', async () => {
    capture.mockRejectedValue(
      new Error(
        'Vertex failed: ' +
          input.text +
          ' ' +
          config.EXTENSION_API_KEY +
          ' ' +
          config.OAUTH_CLIENT_SECRET,
      ),
    );
    expect((await post(input)).status).toBe(503);
    const entry = logged();
    expect(entry.severity).toBe('ERROR');
    expect(entry.message).toContain('Vertex failed:');
    expect(entry.stack).toContain('at ');
    const output = JSON.stringify(entry);
    for (const secret of [input.text, config.EXTENSION_API_KEY, config.OAUTH_CLIENT_SECRET]) {
      expect(output).not.toContain(secret);
    }
  });
  it('logs only validation paths/messages, not raw Zod input or metadata', async () => {
    capture.mockRejectedValue(validationError());
    expect((await post(input)).status).toBe(400);
    expect(logged().message).toBe('Request failed: Validation failed');
    expect(logged().issues).toEqual([{ path: ['salaryMin'], message: expect.any(String) }]);
    expect(logged().stack).toContain('at ');
    expect(JSON.stringify(logged())).not.toContain('invalid');
  });
  it('logs a Gemini API status and message while returning a server error', async () => {
    capture.mockRejectedValue(
      Object.assign(new Error('Publisher model was not found'), { status: 404 }),
    );
    expect((await post(input)).status).toBe(503);
    expect(logged().status).toBe(404);
    expect(logged().message).toContain('Publisher model was not found');
    expect(logged().severity).toBe('ERROR');
  });
});
describe('Pub/Sub structured errors', () => {
  it.each([1234567, '1234567'])(
    'normalizes a real-shaped Gmail push history ID %s to a string',
    async (historyId) => {
      const push = {
        message: {
          data: Buffer.from(
            JSON.stringify({ emailAddress: config.OWNER_EMAIL, historyId }),
          ).toString('base64'),
          messageId: '2070443601311540',
          publishTime: '2026-10-29T21:00:00.000Z',
        },
        subscription: 'projects/test/subscriptions/gmail-notifications-push',
      };
      expect((await post(push, '/pubsub/gmail')).status).toBe(204);
      expect(processNotification).toHaveBeenCalledExactlyOnceWith({
        emailAddress: config.OWNER_EMAIL,
        historyId: '1234567',
      });
      expect(log).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, null, true, {}, []])(
    'rejects an invalid history ID %s without processing it',
    async (historyId) => {
      const push = {
        message: {
          data: Buffer.from(
            JSON.stringify({ emailAddress: config.OWNER_EMAIL, historyId }),
          ).toString('base64'),
        },
      };
      expect((await post(push, '/pubsub/gmail')).status).toBe(204);
      expect(processNotification).not.toHaveBeenCalled();
      expect(logged().message).toBe('Invalid Gmail notification: Validation failed');
      expect(logged().issues[0].path).toEqual(['historyId']);
    },
  );
  const envelope = {
    message: {
      data: Buffer.from(
        JSON.stringify({ emailAddress: config.OWNER_EMAIL, historyId: '200' }),
      ).toString('base64'),
    },
  };
  it('logs permanent failures before acknowledging them', async () => {
    processNotification.mockRejectedValue(
      Object.assign(new Error('Gmail authorization revoked'), { code: 401 }),
    );
    expect((await post(envelope, '/pubsub/gmail')).status).toBe(204);
    expect(logged().severity).toBe('ERROR');
    expect(logged().message).toContain('Gmail authorization revoked');
    expect(logged().stack).toContain('at ');
  });
  it('logs transient errors and returns a retryable response', async () => {
    processNotification.mockRejectedValue(new Error('Gmail unavailable'));
    expect((await post(envelope, '/pubsub/gmail')).status).toBe(503);
    expect(logged().message).toContain('Gmail unavailable');
    expect(logged().severity).toBe('ERROR');
  });
  it('logs Gemini classification API status and message', async () => {
    processNotification.mockRejectedValue(
      Object.assign(new Error('Publisher model was not found'), { status: 404 }),
    );
    expect((await post(envelope, '/pubsub/gmail')).status).toBe(503);
    expect(logged().status).toBe(404);
    expect(logged().message).toContain('Publisher model was not found');
  });
  it('logs validation errors without serializing their full issues', async () => {
    processNotification.mockRejectedValue(validationError());
    expect((await post(envelope, '/pubsub/gmail')).status).toBe(400);
    expect(logged().issues[0].path).toEqual(['salaryMin']);
    expect(logged().severity).toBe('ERROR');
  });
  it.each([{}, { message: { data: 'not-json' } }])(
    'logs malformed envelopes and acknowledges them',
    async (body) => {
      expect((await post(body, '/pubsub/gmail')).status).toBe(204);
      expect(logged().severity).toBe('ERROR');
      expect(processNotification).not.toHaveBeenCalled();
    },
  );
});
