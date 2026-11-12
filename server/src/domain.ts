import { z } from 'zod';
import type { Resume, Tailoring, TailorOutput } from './resume-domain.js';

export const statuses = [
  'Applied',
  'Online Assessment',
  'OA Completed',
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
export const interviewRoundSchema = z.number().int().min(1).max(5);
export const classificationSchema = z.object({
  interviewRound: z.number().int().min(0).max(5).optional(),
  isJobRelated: z.boolean(),
  category: z.enum([
    'confirmation',
    'rejection',
    'online_assessment',
    'assessment_completed',
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
  interviewRound?: number;
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
  interviewRound?: number;
  id: string;
  status: Status;
  appliedAt: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  events: Event[];
  tailoring?: Tailoring;
};
export type Email = {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  gmailLink: string;
};
export function matchesEmail(event: Event, email: Pick<Email, 'id' | 'gmailLink'>) {
  return (
    !!event.gmailLink &&
    (event.gmailLink === email.gmailLink || event.gmailLink.endsWith('/' + email.id))
  );
}
export function emailEventTime(event: Event) {
  const date = Date.parse(event.emailDate || '');
  const at = Number.isFinite(date) ? date : Date.parse(event.at);
  return Number.isFinite(at) ? at : -Infinity;
}
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
  listResumes(): Promise<Resume[]>;
  saveResume(resume: Resume): Promise<void>;
  deleteResume(id: string): Promise<void>;
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
  tailor(input: {
    job: Pick<Job, 'company' | 'title' | 'jobSummary' | 'keyRequirements'>;
    resumes: Resume[];
  }): Promise<TailorOutput>;
  extract(input: { url: string; pageTitle: string; text: string }): Promise<Job>;
  classify(text: string): Promise<Classification>;
}
const companyAliases: Record<string, string> = {
  jpmorgan: 'jpmorganchase',
};
export const normalize = (value: string) => {
  const name = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(
      /(?:\b(?:co|company|inc|incorporated|llc|ltd|limited|corp|corporation|group|technologies)\b\s*)+$/,
      '',
    )
    .replace(/[^a-z0-9]/g, '');
  return companyAliases[name] || name;
};
function sameCompany(a: string, b: string) {
  return !!a && !!b && a === b;
}
function companyMentions(text: string) {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const mentions = new Set<string>();
  for (let start = 0; start < words.length; start++) {
    for (let length = 1; length <= 6 && start + length <= words.length; length++) {
      mentions.add(normalize(words.slice(start, start + length).join(' ')));
    }
  }
  return [...mentions].filter(Boolean);
}
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
  const mentions = companyMentions(sender);
  const ranked = available
    .map((app) => {
      const name = normalize(app.company);
      const companyMatch =
        sameCompany(name, company) || mentions.some((part) => sameCompany(name, part));
      const similarity = titleSimilarity(app.title, result.title);
      return {
        app,
        sameCompany: companyMatch,
        similarity,
        score: (companyMatch ? 3 : 0) + similarity,
      };
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
    assessment_completed: 'OA Completed',
    interview: 'Interview',
    offer: 'Offer',
  };
  return mapping[category];
}
export function emailStatus(current: Status, category: Classification['category']): Status {
  const next = categoryStatus(category);
  if (current === 'Rejected' || current === 'Withdrawn') return current;
  if (next === 'Rejected') return next;
  if (current === 'Ghosted') return next || 'Applied';
  if (!next) return current;
  if (current === 'OA Completed' && next === 'Online Assessment') return next;
  return statuses.indexOf(next) > statuses.indexOf(current) ? next : current;
}
export function emailProgress(
  current: Pick<Application, 'status' | 'interviewRound'>,
  classification: Classification,
  override?: Status,
) {
  let status = emailStatus(current.status, classification.category);
  if (
    override &&
    classification.category !== 'rejection' &&
    current.status !== 'Rejected' &&
    current.status !== 'Withdrawn' &&
    (current.status !== 'Offer' || override === 'Rejected')
  )
    status = override;
  let round = current.interviewRound;
  if (status === 'Interview') {
    round = Math.max(
      current.interviewRound || 1,
      classification.category === 'interview' || override === 'Interview'
        ? classification.interviewRound || 1
        : 1,
    );
  }
  return { status, ...(round !== undefined ? { interviewRound: round } : {}) };
}
export const passesPrefilter = (text: string) =>
  /\b(applications?|applying|applied|candidacy|candidates?|interviews?|assessments?|position|role|recruit\w*|offers?|unfortunately|move forward|moving forward|next steps|hiring|thank you for your interest|talent|hackerrank|codesignal|coding[\s-]+challenges?|scheduling|schedule[ds]?|screens?|screening|phone[\s-]+screens?|opportunit(?:y|ies)|careers?|regret|not selected|decided|offer[\s-]+letter|background[\s-]+checks?|onboarding)\b/i.test(
    text,
  );
