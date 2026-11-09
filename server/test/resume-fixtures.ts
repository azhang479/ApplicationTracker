import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import type { AI, Application, GmailConfig, Review, Store } from '../src/domain.js';
import type { Resume } from '../src/resume-domain.js';

export const sampleTex = readFileSync(
  new URL('../fixtures/sample-resume.tex', import.meta.url),
  'utf8',
);
export const draft = {
  find: 'Built reliable services',
  replace: 'Developed reliable services',
  reason: 'Emphasize development',
};
export function resume(id = 'swe', label = 'SWE'): Resume {
  return { id, label, tex: sampleTex, updatedAt: '2026-06-01' };
}
export function application(): Application {
  return {
    id: 'job',
    company: 'JPMorgan Chase & Co.',
    title: 'Software Engineer',
    jobId: '',
    url: 'https://example.com/job',
    location: '',
    workMode: 'unknown',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: 'USD',
    salaryPeriod: 'year',
    salaryIsEstimated: false,
    jobSummary: 'Build reliable services',
    keyRequirements: ['Python', 'SQL'],
    status: 'Applied',
    appliedAt: '2026-06-01',
    createdAt: '2026-06-01',
    updatedAt: '2026-06-01',
    lastActivityAt: '2026-06-01',
    events: [],
  };
}
export class ResumeStore implements Store {
  apps = [application()];
  resumes: Resume[] = [];
  reviews: Review[] = [];
  private queue = Promise.resolve();
  private inside = false;
  async listApplications() {
    return structuredClone(this.apps);
  }
  async saveApplication(app: Application) {
    this.assertInside();
    this.apps = [...this.apps.filter((item) => item.id !== app.id), structuredClone(app)];
  }
  async deleteApplication(id: string) {
    this.apps = this.apps.filter((app) => app.id !== id);
  }
  async listResumes() {
    return structuredClone(this.resumes);
  }
  async saveResume(resume: Resume) {
    this.assertInside();
    this.resumes = [
      ...this.resumes.filter((item) => item.id !== resume.id),
      structuredClone(resume),
    ];
  }
  async deleteResume(id: string) {
    this.assertInside();
    this.resumes = this.resumes.filter((resume) => resume.id !== id);
  }
  async listReview() {
    return this.reviews;
  }
  async saveReview(review: Review) {
    this.reviews.push(review);
  }
  async getGmail(): Promise<GmailConfig | undefined> {
    return undefined;
  }
  async saveGmail() {}
  async isProcessed() {
    return false;
  }
  async markProcessed() {}
  private assertInside() {
    if (!this.inside) throw new Error('Mutation outside exclusive');
  }
  exclusive<T>(work: () => Promise<T>) {
    const result = this.queue.then(async () => {
      this.inside = true;
      try {
        return await work();
      } finally {
        this.inside = false;
      }
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
export function fakeAI() {
  return {
    extract: vi.fn(),
    classify: vi.fn(),
    tailor: vi
      .fn<AI['tailor']>()
      .mockResolvedValue({ resumeId: 'swe', reason: 'Best software fit', edits: [draft] }),
  };
}
