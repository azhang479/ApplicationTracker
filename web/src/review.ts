import type { Application, Review } from './types';

type ApplicationOption = Pick<Application, 'id' | 'company' | 'title'>;

export function reviewApplications(
  applications: ApplicationOption[],
  candidates: Review['candidates'],
) {
  const byId = new Map(applications.map((app) => [app.id, app]));
  const candidateIds = new Set<string>();
  const bestMatches = candidates.flatMap((candidate) => {
    const app = byId.get(candidate.applicationId);
    if (!app || candidateIds.has(app.id)) return [];
    candidateIds.add(app.id);
    return [{ ...app, score: candidate.score }];
  });
  const others = applications
    .filter((app) => !candidateIds.has(app.id))
    .sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
  return { bestMatches, others };
}
