import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AI,
  Application,
  Classification,
  Email,
  Job,
  Store,
  Status,
  emailProgress,
  interviewRoundSchema,
  emailEventTime,
  matchesEmail,
  jobSchema,
  matchApplications,
  normalize,
  statuses,
} from './domain.js';

const JOB_TEXT_LIMIT = 20_000;
function eventRound(
  progress: Pick<Application, 'status' | 'interviewRound'>,
  classification: Classification,
) {
  return classification.category === 'interview'
    ? Math.max(progress.interviewRound || 1, classification.interviewRound || 1)
    : progress.status === 'Interview'
      ? progress.interviewRound || 1
      : undefined;
}

export const patchSchema = jobSchema
  .partial()
  .extend({
    status: z.enum(statuses).optional(),
    interviewRound: interviewRoundSchema.optional(),
    appliedAt: z.string().datetime().optional(),
    lastActivityAt: z.string().datetime().optional(),
  })
  .strict();
export const resolveSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('apply'),
    applicationId: z.string(),
    status: z.enum(statuses),
    interviewRound: interviewRoundSchema.optional(),
  }),
  z.object({ type: z.literal('create'), fields: jobSchema }),
  z.object({ type: z.literal('dismiss') }),
]);
export class NotFound extends Error {}
export type EmailOutcome = 'updated' | 'review' | 'skipped';
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
      const status = fields.status ?? app.status;
      const round = fields.interviewRound ?? app.interviewRound ?? 1;
      if (
        (fields.status && fields.status !== app.status) ||
        (status === 'Interview' &&
          fields.interviewRound !== undefined &&
          round !== (app.interviewRound ?? 1))
      ) {
        app.events.push({
          at: now,
          type: 'status_change',
          status,
          ...(status === 'Interview' ? { interviewRound: round } : {}),
        });
        app.lastActivityAt = now;
      }
      Object.assign(app, fields, { updatedAt: now });
      await this.store.saveApplication(app);
      return app;
    });
  }
  async recheckEmail(
    email: Email,
    classification: Classification,
    body = '',
  ): Promise<EmailOutcome> {
    const apps = await this.store.listApplications();
    if ((await this.store.listReview()).some((review) => review.id === email.id)) return 'skipped';
    const existing = apps.find((app) => app.events.some((event) => matchesEmail(event, email)));
    if (existing) {
      const latest = existing.events
        .filter((event) => event.gmailLink)
        .reduce<(typeof existing.events)[number] | undefined>(
          (newest, event) =>
            !newest || emailEventTime(event) >= emailEventTime(newest) ? event : newest,
          undefined,
        );
      let changed = false;
      for (const event of existing.events.filter((event) => matchesEmail(event, email))) {
        if (event.type === classification.category && classification.category !== 'interview')
          continue;
        const progress = emailProgress(
          event === latest
            ? existing
            : { status: event.status || 'Applied', interviewRound: event.interviewRound },
          classification,
        );
        const round =
          classification.category === 'interview'
            ? Math.max(event.interviewRound || 1, eventRound(progress, classification) || 1)
            : eventRound(progress, classification);
        if (
          event.type !== classification.category ||
          event.status !== progress.status ||
          event.interviewRound !== round
        ) {
          Object.assign(event, { type: classification.category, status: progress.status });
          if (round !== undefined) event.interviewRound = round;
          else delete event.interviewRound;
          changed = true;
        }
        if (
          event === latest &&
          (existing.status !== progress.status ||
            existing.interviewRound !== progress.interviewRound)
        ) {
          Object.assign(existing, progress);
          changed = true;
        }
      }
      if (!changed) return 'skipped';
      existing.updatedAt = this.now();
      await this.store.saveApplication(existing);
      return 'updated';
    }
    return this.receive(email, classification, body);
  }
  async receive(email: Email, classification: Classification, body = ''): Promise<EmailOutcome> {
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
      return 'review';
    }
    await this.applyEmail(confident, email, classification);
    return 'updated';
  }
  private async applyEmail(
    app: Application,
    email: Email,
    classification: Classification,
    statusOverride?: Status,
  ) {
    Object.assign(app, emailProgress(app, classification, statusOverride));
    if (!app.jobId && classification.jobId && classification.category === 'confirmation')
      app.jobId = classification.jobId;
    app.lastActivityAt = app.updatedAt = this.now();
    const round = eventRound(app, classification);
    app.events.push({
      at: this.now(),
      type: classification.category,
      status: app.status,
      ...(round !== undefined ? { interviewRound: round } : {}),
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
        await this.applyEmail(
          app,
          review.email,
          {
            ...review.classification,
            ...(action.interviewRound !== undefined
              ? { interviewRound: action.interviewRound }
              : {}),
          },
          action.status,
        );
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
