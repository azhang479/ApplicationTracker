import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gmail } from 'googleapis/build/src/apis/gmail/index.js';
import { GmailService } from '../src/gmail.js';
import type { AI, GmailConfig, Store } from '../src/domain.js';
import type { Config } from '../src/config.js';
import type { Tracker } from '../src/service.js';

vi.mock('googleapis/build/src/apis/gmail/index.js', () => ({ gmail: vi.fn() }));

function setup(config: GmailConfig = { refreshToken: 'fake', historyId: '100' }) {
  let saved = { ...config };
  const history = vi.fn().mockResolvedValue({ data: { historyId: '200', history: [] } });
  const list = vi.fn().mockResolvedValue({ data: { messages: [] } });
  const get = vi.fn();
  vi.mocked(gmail).mockReturnValue({
    users: { history: { list: history }, messages: { list, get } },
  } as never);
  const saveGmail = vi.fn(async (next: GmailConfig) => {
    saved = next;
  });
  const store = {
    getGmail: async () => saved,
    saveGmail,
    isProcessed: vi.fn(async () => true),
  } as unknown as Store;
  const service = new GmailService(
    {
      OWNER_EMAIL: 'owner@gmail.com',
      OAUTH_CLIENT_ID: 'client',
      OAUTH_CLIENT_SECRET: 'secret',
      PUBLIC_URL: 'https://example.test',
    } as Config,
    store,
    {} as AI,
    {} as Tracker,
  );
  return { service, history, list, get, saveGmail, saved: () => saved };
}
const notification = { emailAddress: 'owner@gmail.com', historyId: '200' };
beforeEach(() => vi.clearAllMocks());
describe('Gmail sync cursor', () => {
  it('records lastSyncAt even for an empty successful notification', async () => {
    const ctx = setup();
    await ctx.service.processNotification(notification);
    expect(ctx.saved().historyId).toBe('200');
    expect(Date.parse(ctx.saved().lastSyncAt!)).not.toBeNaN();
    expect(ctx.list).not.toHaveBeenCalled();
  });
  it('resets expired cursor without backfill if there is no lastSyncAt', async () => {
    const ctx = setup();
    ctx.history.mockRejectedValue({ code: 404 });
    await ctx.service.processNotification(notification);
    expect(ctx.saved().historyId).toBe('200');
    expect(ctx.saved().lastSyncAt).toBeDefined();
    expect(ctx.list).not.toHaveBeenCalled();
    expect(ctx.get).not.toHaveBeenCalled();
  });
  it('only queries after lastSyncAt, paginates, and resets to notification cursor', async () => {
    const lastSyncAt = '2026-06-01T12:00:00.000Z';
    const ctx = setup({ refreshToken: 'fake', historyId: '100', lastSyncAt });
    ctx.history.mockRejectedValue({ code: 404 });
    ctx.list
      .mockResolvedValueOnce({
        data: { messages: [{ id: 'already-done' }], nextPageToken: 'next' },
      })
      .mockResolvedValueOnce({ data: { messages: [] } });
    await ctx.service.processNotification(notification);
    expect(ctx.list).toHaveBeenNthCalledWith(1, {
      userId: 'me',
      q: 'after:' + Date.parse(lastSyncAt) / 1000,
      pageToken: undefined,
    });
    expect(ctx.list).toHaveBeenNthCalledWith(2, {
      userId: 'me',
      q: 'after:' + Date.parse(lastSyncAt) / 1000,
      pageToken: 'next',
    });
    expect(ctx.saved().historyId).toBe('200');
    expect(ctx.get).not.toHaveBeenCalled();
  });
  it('does not advance the sync timestamp after a transient failure', async () => {
    const ctx = setup();
    ctx.history.mockRejectedValue({ code: 503 });
    await expect(ctx.service.processNotification(notification)).rejects.toEqual({ code: 503 });
    expect(ctx.saveGmail).not.toHaveBeenCalled();
  });
  it('initializes a missing cursor without processing historical email', async () => {
    const ctx = setup({ refreshToken: 'fake' });
    await ctx.service.processNotification(notification);
    expect(ctx.saved().historyId).toBe('200');
    expect(ctx.saved().lastSyncAt).toBeDefined();
    expect(ctx.history).not.toHaveBeenCalled();
  });
  it('ignores a different mailbox', async () => {
    const ctx = setup();
    await ctx.service.processNotification({ ...notification, emailAddress: 'someone@gmail.com' });
    expect(ctx.saveGmail).not.toHaveBeenCalled();
    expect(ctx.history).not.toHaveBeenCalled();
  });
});
