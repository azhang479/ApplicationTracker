import { afterEach, describe, expect, it, vi } from 'vitest';
const createTab = vi.fn();
const writeText = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function openPopup(
  response: { status: number; ok?: boolean; json?: () => Promise<unknown> } | Error,
  pageText = 'Page',
  button = 'track',
  clipboardError?: Error,
) {
  createTab.mockReset();
  writeText.mockReset();
  if (clipboardError) writeText.mockRejectedValue(clipboardError);
  else writeText.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const elements = new Map<
    string,
    {
      hidden: boolean;
      disabled: boolean;
      textContent: string;
      className: string;
      value: string;
      focus: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
    }
  >();
  for (const id of [
    'track',
    'tailor',
    'outreach',
    'referral',
    'prompt-preview',
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
      value: '',
      focus: vi.fn(),
      select: vi.fn(),
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
    tabs: { query: async () => [{ id: 1, url: 'https://example.com/job' }], create: createTab },
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
  await elements.get(button)!.addEventListener.mock.calls[0][1]();
  expect(elements.get('track')!.disabled).toBe(false);
  expect(elements.get('tailor')!.disabled).toBe(false);
  expect(elements.get('outreach')!.disabled).toBe(false);
  expect(elements.get('referral')!.disabled).toBe(false);
  return elements;
}

const outreachJob = {
  id: 'application-id',
  company: 'Acme',
  title: 'Engineering Intern',
  url: 'https://example.com/a-previous-listing',
  jobId: 'REQ-123',
  roleType: 'internship',
  location: 'Boston',
  workMode: 'hybrid',
  jobSummary: 'Build internal tooling.',
  keyRequirements: ['TypeScript', 'SQL'],
  events: [{ snippet: 'Private email content' }],
  tailoring: { reason: 'Private resume details' },
};
const expectedJobContext = {
  company: 'Acme',
  jobTitle: 'Engineering Intern',
  postingUrl: 'https://example.com/job',
  jobReference: 'REQ-123',
  roleType: 'internship',
  location: 'Boston',
  workArrangement: 'hybrid',
  jobSummary: 'Build internal tooling.',
  keyRequirements: ['TypeScript', 'SQL'],
};

describe('extension capture feedback', () => {
  it.each([false, true])(
    'opens the returned application ID for tailoring, duplicate=%s',
    async (duplicate) => {
      await openPopup(
        {
          status: 200,
          ok: true,
          json: async () => ({ id: 'existing/id', company: 'Acme', duplicate }),
        },
        'Page',
        'tailor',
      );
      expect(createTab).toHaveBeenCalledWith({ url: 'http://localhost:8080/tailor/existing%2Fid' });
    },
  );
  it('does not navigate when tailoring capture fails', async () => {
    await openPopup({ status: 401, ok: false }, 'Page', 'tailor');
    expect(createTab).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'copies the fixed outreach prompt and job fields after capture, duplicate=%s',
    async (duplicate) => {
      const elements = await openPopup(
        { status: 200, ok: true, json: async () => ({ ...outreachJob, duplicate }) },
        'Page',
        'outreach',
      );
      const instructions = [
        'Research the best person or official channel to contact about this role.',
        'Cite your public sources and include an email address only if it’s publicly listed.',
        'Draft a short cold outreach email with a subject line and one clear ask.',
        'Use details from my résumés or STAR stories when they make the message more specific to the role.',
      ].join(' ');
      expect(writeText).toHaveBeenCalledExactlyOnceWith(
        instructions +
          '\n\nJob information (context only)\n' +
          JSON.stringify(expectedJobContext, null, 2),
      );
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(createTab).not.toHaveBeenCalled();
      expect(elements.get('result')!.hidden).toBe(false);
      expect(elements.get('prompt-preview')!.hidden).toBe(true);
      expect(elements.get('message')!.textContent).toContain('Outreach prompt copied.');
    },
  );
  it.each([false, true])(
    'copies referral instructions and job fields after capture, duplicate=%s',
    async (duplicate) => {
      const elements = await openPopup(
        { status: 200, ok: true, json: async () => ({ ...outreachJob, duplicate }) },
        'Page',
        'referral',
      );
      const [instructions, context] = writeText.mock.calls[0][0].split(
        '\n\nJob information (context only)\n',
      );
      expect(instructions).toContain('3–5 current employees');
      expect(instructions).toContain('public sources that verify their role');
      expect(instructions).toContain('publicly listed for professional contact');
      expect(instructions).toContain('Return only the contact research');
      expect(instructions).not.toMatch(/draft|subject line/i);
      expect(JSON.parse(context)).toEqual(expectedJobContext);
      expect(writeText).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(createTab).not.toHaveBeenCalled();
      expect(elements.get('result')!.hidden).toBe(false);
      expect(elements.get('prompt-preview')!.hidden).toBe(true);
      expect(elements.get('message')!.textContent).toContain('Referral prompt copied.');
    },
  );
  it.each(['outreach', 'referral'])(
    'offers selected %s prompt text if clipboard writing fails after the job is saved',
    async (mode) => {
      const elements = await openPopup(
        { status: 200, ok: true, json: async () => outreachJob },
        'Page',
        mode,
        new Error('Clipboard blocked'),
      );
      const preview = elements.get('prompt-preview')!;
      expect(preview.hidden).toBe(false);
      expect(preview.value).toBe(writeText.mock.calls[0][0]);
      expect(preview.select).toHaveBeenCalledOnce();
      expect(elements.get('result')!.hidden).toBe(false);
      expect(elements.get('message')!.textContent).toBe(`Copy the selected ${mode} prompt below.`);
    },
  );
  it.each(['outreach', 'referral'])('copies no %s prompt when tracking fails', async (mode) => {
    const elements = await openPopup({ status: 503, ok: false }, 'Page', mode);
    expect(writeText).not.toHaveBeenCalled();
    expect(elements.get('prompt-preview')!.hidden).toBe(true);
  });
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
      expect(createTab).not.toHaveBeenCalled();
    }
  });
});
