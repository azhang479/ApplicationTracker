import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AI,
  Application,
  Classification,
  Email,
  Job,
  Store,
  categoryStatus,
  jobSchema,
  matchApplications,
  normalize,
  statuses,
} from './domain.js';

const JOB_TEXT_LIMIT = 20_000;

export const patchSchema = jobSchema
  .partial()
  .extend({
    status: z.enum(statuses).optional(),
    appliedAt: z.string().datetime().optional(),
    lastActivityAt: z.string().datetime().optional(),
  })
  .strict();
export const resolveSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('apply'), applicationId: z.string(), status: z.enum(statuses) }),
  z.object({ type: z.literal('create'), fields: jobSchema }),
  z.object({ type: z.literal('dismiss') }),
]);
export class NotFound extends Error {}
export class Tracker {
  constructor(
    public store: Store,
    public ai: AI,
    private now = () => new Date().toISOString(),
  ) {}
  private create(fields: Job): Application {
    const now = this.now();
    return {
      ...fields,
      id: randomUUID(),
      status: 'Applied',
      appliedAt: now,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
      events: [{ at: now, type: 'applied', status: 'Applied' }],
    };
  }
  async capture(input: { url: string; pageTitle: string; text: string }) {
    const known = (await this.store.listApplications()).find((app) => app.url === input.url);
    if (known) return { ...known, duplicate: true };
    const fields = jobSchema.parse(
      await this.ai.extract({ ...input, text: input.text.slice(0, JOB_TEXT_LIMIT) }),
    );
    fields.url = input.url;
    return this.store.exclusive(async () => {
      const existing = (await this.store.listApplications()).find(
        (a) =>
          a.url === fields.url ||
          (fields.jobId &&
            a.jobId === fields.jobId &&
            normalize(a.company) === normalize(fields.company)),
      );
      if (existing) return { ...existing, duplicate: true };
      const app = this.create(fields);
      await this.store.saveApplication(app);
      return { ...app, duplicate: false };
    });
  }
  async patch(id: string, fields: z.infer<typeof patchSchema>) {
    return this.store.exclusive(async () => {
      const app = (await this.store.listApplications()).find((a) => a.id === id);
      if (!app) throw new NotFound();
      const now = this.now();
      if (fields.status && fields.status !== app.status) {
        app.events.push({ at: now, type: 'status_change', status: fields.status });
        app.lastActivityAt = now;
      }
      Object.assign(app, fields, { updatedAt: now });
      await this.store.saveApplication(app);
      return app;
    });
  }
  async receive(email: Email, classification: Classification, body = '') {
    const { confident, candidates } = matchApplications(
      await this.store.listApplications(),
      classification,
      [email.from, email.subject, email.snippet, body].join('\n'),
    );
    if (!confident) {
      await this.store.saveReview({
        id: email.id,
        email,
        classification,
        candidates,
        createdAt: this.now(),
        resolved: false,
      });
      return;
    }
    await this.applyEmail(confident, email, classification);
  }
  private async applyEmail(app: Application, email: Email, classification: Classification) {
    const status = categoryStatus(classification.category);
    if (status) app.status = status;
    if (!app.jobId && classification.jobId && classification.category === 'confirmation')
      app.jobId = classification.jobId;
    app.lastActivityAt = app.updatedAt = this.now();
    app.events.push({
      at: this.now(),
      type: classification.category,
      status: app.status,
      emailSubject: email.subject,
      emailFrom: email.from,
      emailDate: email.date,
      snippet: email.snippet.slice(0, 300),
      gmailLink: email.gmailLink,
    });
    await this.store.saveApplication(app);
  }
  async resolve(id: string, action: z.infer<typeof resolveSchema>) {
    return this.store.exclusive(async () => {
      const review = (await this.store.listReview()).find((r) => r.id === id && !r.resolved);
      if (!review) throw new NotFound();
      if (action.type === 'apply') {
        const app = (await this.store.listApplications()).find(
          (a) => a.id === action.applicationId,
        );
        if (!app) throw new NotFound();
        app.status = action.status;
        await this.applyEmail(app, review.email, { ...review.classification, category: 'other' });
      } else if (action.type === 'create') {
        await this.applyEmail(this.create(action.fields), review.email, review.classification);
      }
      review.resolved = true;
      await this.store.saveReview(review);
    });
  }
  async ghost(days: number) {
    return this.store.exclusive(async () => {
      const cutoff = Date.parse(this.now()) - days * 86400000;
      let count = 0;
      for (const app of await this.store.listApplications()) {
        if (app.status !== 'Applied' || Date.parse(app.lastActivityAt) >= cutoff) continue;
        app.status = 'Ghosted';
        app.updatedAt = this.now();
        app.events.push({ at: this.now(), type: 'ghosted', status: 'Ghosted' });
        await this.store.saveApplication(app);
        count++;
      }
      return count;
    });
  }
}
