import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function openPopup(
  response: { status: number; ok?: boolean; json?: () => Promise<unknown> } | Error,
  pageText = 'Page',
) {
  const elements = new Map<
    string,
    {
      hidden: boolean;
      disabled: boolean;
      textContent: string;
      className: string;
      addEventListener: ReturnType<typeof vi.fn>;
    }
  >();
  for (const id of [
    'track',
    'message',
    'result',
    'result-label',
    'company',
    'title',
    'salary',
    'dashboard',
    'settings',
  ]) {
    elements.set(id, {
      hidden: false,
      disabled: false,
      textContent: '',
      className: '',
      addEventListener: vi.fn(),
    });
  }
  vi.stubGlobal('document', {
    getElementById: (id: string) => elements.get(id),
    title: 'Engineer',
    body: { innerText: pageText },
  });
  vi.stubGlobal('location', { href: 'https://example.com/job' });
  vi.stubGlobal('chrome', {
    storage: {
      sync: { get: async () => ({ backendUrl: 'http://localhost:8080', apiKey: 'test-key' }) },
    },
    tabs: { query: async () => [{ id: 1, url: 'https://example.com/job' }] },
    scripting: {
      executeScript: async ({
        func,
        args,
      }: {
        func: (limit: number) => unknown;
        args: number[];
      }) => [{ result: func(args[0]) }],
    },
  });
  const fetch = vi.fn();
  if (response instanceof Error) fetch.mockRejectedValue(response);
  else fetch.mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  await import('../../extension/popup.js');
  await elements.get('track')!.addEventListener.mock.calls[0][1]();
  expect(elements.get('track')!.disabled).toBe(false);
  return elements;
}
describe('extension capture feedback', () => {
  it.each([0, 19999, 20000, 20001, 40000])(
    'caps a %s-character page before sending it',
    async (length) => {
      await openPopup(
        { status: 200, ok: true, json: async () => ({ company: 'Acme' }) },
        'x'.repeat(length),
      );
      const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);
      expect(body).toEqual({
        url: 'https://example.com/job',
        pageTitle: 'Engineer',
        text: 'x'.repeat(Math.min(length, 20000)),
      });
    },
  );
  it.each([
    [401, "API key doesn't match. Check Settings."],
    [400, "Couldn't read this job page."],
    [503, 'Server error. Try again.'],
    [500, 'Server error. Try again.'],
    [502, 'Server error. Try again.'],
  ])('explains HTTP %s', async (status, message) => {
    const elements = await openPopup({ status: Number(status), ok: false });
    expect(elements.get('message')!.textContent).toBe(message);
    expect(elements.get('result')!.hidden).toBe(true);
  });
  it('explains a network failure', async () => {
    const elements = await openPopup(new TypeError('Failed to fetch'));
    expect(elements.get('message')!.textContent).toBe(
      "Can't reach the server. Check the backend URL in Settings.",
    );
  });
  it('still displays successful and duplicate captures', async () => {
    for (const duplicate of [false, true]) {
      vi.resetModules();
      const elements = await openPopup({
        status: 200,
        ok: true,
        json: async () => ({
          company: 'Acme',
          title: 'Engineer',
          salaryMin: null,
          salaryMax: null,
          duplicate,
        }),
      });
      expect(elements.get('company')!.textContent).toBe('Acme');
      expect(elements.get('result-label')!.textContent).toBe(
        duplicate ? '✓ Already tracked' : '✓ Added to your applications',
      );
      expect(elements.get('result')!.hidden).toBe(false);
      expect(elements.get('message')!.textContent).toBe('');
    }
  });
});
