import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VertexAI } from '../src/ai.js';
import { resume } from './resume-fixtures.js';

const { generate, clientOptions } = vi.hoisted(() => ({
  generate: vi.fn(),
  clientOptions: vi.fn(),
}));
vi.mock('@google/genai', async (original) => ({
  ...(await original<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    constructor(options: unknown) {
      clientOptions(options);
    }
    models = { generateContent: generate };
  },
}));

const input = {
  url: 'https://example.com/jobs/123',
  pageTitle: 'Engineer at Acme',
  text: 'Job page',
};
const fields = {
  company: 'Acme',
  title: 'Engineer',
  jobId: '123',
  location: 'NY',
  workMode: 'hybrid',
  salaryMin: 120000,
  salaryMax: 150000,
  salaryCurrency: 'USD',
  salaryPeriod: 'year',
  salaryIsEstimated: false,
  jobSummary: 'Build software',
  keyRequirements: ['TypeScript'],
};
const ai = new VertexAI('test-project', 'global', 'test-model');
describe('Gemini resume tailoring', () => {
  const input = {
    job: {
      company: fields.company,
      title: fields.title,
      jobSummary: fields.jobSummary,
      keyRequirements: fields.keyRequirements,
    },
    resumes: [resume()],
  };
  it('uses temperature zero, structured output and conservative text-only instructions', async () => {
    const result = {
      resumeId: 'swe',
      reason: 'Fit',
      edits: [
        {
          find: 'Built reliable services',
          replace: 'Developed reliable services',
          reason: 'Keyword wording',
        },
      ],
    };
    generate.mockResolvedValue({ text: JSON.stringify(result) });
    expect(await ai.tailor(input)).toEqual(result);
    const request = generate.mock.calls[0][0];
    expect(request.config.temperature).toBe(0);
    expect(JSON.parse(request.contents)).toEqual(input);
    expect(request.config.systemInstruction).toContain('about 15 changed words');
    expect(request.config.systemInstruction).toContain(
      'Never add skills, tools, employers, titles or metrics',
    );
    expect(request.config.systemInstruction).toContain('never LaTeX commands or formatting');
    expect(request.config.responseSchema.required).toEqual(['resumeId', 'reason', 'edits']);
  });
  it('rejects malformed top-level output and preserves draft items for per-edit filtering', async () => {
    generate.mockResolvedValue({ text: '{}' });
    await expect(ai.tailor(input)).rejects.toThrow();
    generate.mockResolvedValue({
      text: JSON.stringify({
        resumeId: 'unknown',
        reason: 'Fit',
        edits: [null, { find: '\\bad' }],
      }),
    });
    expect((await ai.tailor(input)).edits).toHaveLength(2);
  });
});
beforeEach(() => {
  generate.mockReset();
});
async function extract(value: unknown) {
  generate.mockResolvedValue({ text: JSON.stringify(value) });
  return ai.extract(input);
}

describe('Gemini extraction', () => {
  it('passes the independently configured location to the Vertex client', () => {
    expect(clientOptions).toHaveBeenCalledWith({
      vertexai: true,
      project: 'test-project',
      location: 'global',
    });
  });
  it('preserves valid extracted fields and uses only the submitted URL', async () => {
    expect(await extract(fields)).toEqual({ ...fields, url: input.url });
    const schema = generate.mock.calls[0][0].config.responseSchema;
    expect(schema.properties).not.toHaveProperty('url');
    expect(schema.required).not.toContain('url');
  });
  it.each(['', 'not a url', 'https://wrong.example/job'])(
    'ignores model URL %s and coerces numeric salaries',
    async (url) => {
      expect(await extract({ ...fields, url, salaryMin: '120000', salaryMax: '150000' })).toEqual({
        ...fields,
        url: input.url,
      });
    },
  );
  it.each(['', 'unexpected', null])('defaults unknown enum values %s', async (value) => {
    const job = await extract({ ...fields, workMode: value, salaryPeriod: value });
    expect(job.workMode).toBe('unknown');
    expect(job.salaryPeriod).toBe('year');
  });
  it('fills missing fields and falls back to the page title', async () => {
    expect(await extract({})).toEqual({
      company: 'Unknown company',
      title: input.pageTitle,
      url: input.url,
      jobId: '',
      location: '',
      workMode: 'unknown',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: 'USD',
      salaryPeriod: 'year',
      salaryIsEstimated: false,
      jobSummary: '',
      keyRequirements: [],
    });
    const job = await extract({ company: '  ', title: null, salaryCurrency: '' });
    expect(job.company).toBe('Unknown company');
    expect(job.title).toBe(input.pageTitle);
    expect(job.salaryCurrency).toBe('USD');
  });
  it.each([null, '', 'not a number', -10])(
    'handles absent or unusable salary %s',
    async (value) => {
      const job = await extract({ ...fields, salaryMin: value, salaryMax: value });
      expect(job.salaryMin).toBeNull();
      expect(job.salaryMax).toBeNull();
    },
  );
  it('retains zero/hourly salaries and parses string booleans without truthiness coercion', async () => {
    const job = await extract({
      ...fields,
      salaryMin: '0',
      salaryMax: '70',
      salaryPeriod: 'hour',
      salaryIsEstimated: 'false',
    });
    expect(job.salaryMin).toBe(0);
    expect(job.salaryMax).toBe(70);
    expect(job.salaryPeriod).toBe('hour');
    expect(job.salaryIsEstimated).toBe(false);
    expect((await extract({ ...fields, salaryIsEstimated: 'true' })).salaryIsEstimated).toBe(true);
  });
  it('uses a readable title when both titles are empty', async () => {
    generate.mockResolvedValue({ text: '{}' });
    expect((await ai.extract({ ...input, pageTitle: '' })).title).toBe('Untitled job');
  });
  it('still rejects malformed JSON and invalid top-level data', async () => {
    generate.mockResolvedValue({ text: 'not JSON' });
    await expect(ai.extract(input)).rejects.toBeInstanceOf(SyntaxError);
    await expect(extract(null)).rejects.toThrow();
    generate.mockRejectedValue(new Error('Vertex unavailable'));
    await expect(ai.extract(input)).rejects.toThrow('Vertex unavailable');
  });
});
describe('Gemini assessment classification', () => {
  it.each([
    ["You've completed your HackerRank assessment", 'assessment_completed'],
    ['Thank you for completing the assessment', 'assessment_completed'],
    ['Complete your next HackerRank assessment', 'online_assessment'],
  ])('accepts %s as %s and supplies the assessment instructions', async (text, category) => {
    const classification = {
      isJobRelated: true,
      category,
      company: 'Acme',
      title: '',
      jobId: '',
      summary: text,
    };
    generate.mockResolvedValue({ text: JSON.stringify(classification) });
    expect(await ai.classify(text)).toEqual(classification);
    const request = generate.mock.calls[0][0];
    expect(request.config.responseSchema.properties.category.enum).toContain(
      'assessment_completed',
    );
    expect(request.config.systemInstruction).toContain('completed or submitted an assessment');
    expect(request.config.systemInstruction).toContain(
      'invitations, reminders, or new assessment rounds',
    );
  });
  it('still rejects unknown categories', async () => {
    generate.mockResolvedValue({
      text: JSON.stringify({
        isJobRelated: true,
        category: 'unknown',
        company: '',
        title: '',
        jobId: '',
        summary: '',
      }),
    });
    await expect(ai.classify('Assessment')).rejects.toThrow();
  });
});
