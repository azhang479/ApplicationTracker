import { z } from 'zod';

export const statuses = [
  'Applied',
  'Online Assessment',
  'Interview',
  'Offer',
  'Rejected',
  'Withdrawn',
  'Ghosted',
] as const;
export const jobSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  jobId: z.string().default(''),
  url: z.string().url(),
  location: z.string().default(''),
  workMode: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).default('unknown'),
  salaryMin: z.number().nonnegative().nullable().default(null),
  salaryMax: z.number().nonnegative().nullable().default(null),
  salaryCurrency: z.string().default('USD'),
  salaryPeriod: z.enum(['year', 'hour']).default('year'),
  salaryIsEstimated: z.boolean(),
  jobSummary: z.string(),
  keyRequirements: z.array(z.string()),
});
export const classificationSchema = z.object({
  isJobRelated: z.boolean(),
  category: z.enum([
    'confirmation',
    'rejection',
    'online_assessment',
    'interview',
    'offer',
    'other',
  ]),
  company: z.string(),
  title: z.string(),
  jobId: z.string(),
  summary: z.string(),
});
export type Job = z.infer<typeof jobSchema>;
export type Classification = z.infer<typeof classificationSchema>;
export type Status = (typeof statuses)[number];
export type Event = {
  at: string;
  type: string;
  status?: Status;
  emailSubject?: string;
  emailFrom?: string;
  emailDate?: string;
  snippet?: string;
  gmailLink?: string;
};
export type Application = Job & {
  id: string;
  status: Status;
  appliedAt: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  events: Event[];
};
export type Email = {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  gmailLink: string;
};
export type Candidate = { applicationId: string; company: string; title: string; score: number };
export type Review = {
  id: string;
  email: Email;
  classification: Classification;
  candidates: Candidate[];
  createdAt: string;
  resolved: boolean;
};
export type GmailConfig = {
  refreshToken: string;
  historyId?: string;
  watchExpiration?: string;
  lastSyncAt?: string;
};
export interface Store {
  listApplications(): Promise<Application[]>;
  saveApplication(app: Application): Promise<void>;
  deleteApplication(id: string): Promise<void>;
  listReview(): Promise<Review[]>;
  saveReview(review: Review): Promise<void>;
  isProcessed(id: string): Promise<boolean>;
  markProcessed(id: string): Promise<void>;
  getGmail(): Promise<GmailConfig | undefined>;
  saveGmail(config: GmailConfig): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}
export interface AI {
  extract(input: { url: string; pageTitle: string; text: string }): Promise<Job>;
  classify(text: string): Promise<Classification>;
}
export const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
export function titleSimilarity(a: string, b: string) {
  const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) || []);
  const x = tokens(a),
    y = tokens(b);
  const union = new Set([...x, ...y]);
  return union.size ? [...x].filter((t) => y.has(t)).length / union.size : 0;
}
export function matchApplications(apps: Application[], result: Classification, sender: string) {
  const available = apps.filter((a) => a.status !== 'Withdrawn');
  const exact = result.jobId ? available.filter((a) => a.jobId === result.jobId) : [];
  const company = normalize(result.company);
  const senderParts = sender
    .toLowerCase()
    .split(/[<@>.\s]+/)
    .map(normalize)
    .filter(Boolean);
  const ranked = available
    .map((app) => {
      const name = normalize(app.company);
      const sameCompany = !!name && ((!!company && name === company) || senderParts.includes(name));
      const similarity = titleSimilarity(app.title, result.title);
      return { app, sameCompany, similarity, score: (sameCompany ? 1 : 0) + similarity };
    })
    .sort((a, b) => b.score - a.score);
  const companyMatches = ranked.filter((r) => r.sameCompany);
  const best = companyMatches[0];
  let confident: Application | undefined;
  if (exact.length === 1) {
    confident = exact[0];
  } else if (exact.length === 0 && best) {
    if (companyMatches.length === 1) {
      confident = best.app;
    } else if (best.similarity >= 0.6 && best.similarity - companyMatches[1].similarity >= 0.2) {
      confident = best.app;
    }
  }
  return {
    confident,
    candidates: ranked.slice(0, 3).map((r) => ({
      applicationId: r.app.id,
      company: r.app.company,
      title: r.app.title,
      score: r.score,
    })),
  };
}
export function categoryStatus(category: Classification['category']): Status | undefined {
  const mapping: Partial<Record<Classification['category'], Status>> = {
    rejection: 'Rejected',
    online_assessment: 'Online Assessment',
    interview: 'Interview',
    offer: 'Offer',
  };
  return mapping[category];
}
export const passesPrefilter = (text: string) =>
  /\b(application|applying|applied|candidacy|candidate|interview|assessment|position|role|recruit\w*|offer|unfortunately|move forward|next steps|hiring)\b/i.test(
    text,
  );
