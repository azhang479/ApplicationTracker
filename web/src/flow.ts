import type { Application, Status } from './types';

export const interviewStages = [
  'Interview 1',
  'Interview 2',
  'Interview 3',
  'Interview 4',
  'Interview 5',
] as const;
const pipeline = ['Online Assessment', 'OA Completed', ...interviewStages, 'Offer'] as const;
const terminals = ['Rejected', 'Withdrawn', 'Ghosted'] as const;
const stages = ['Applications', ...pipeline, ...terminals, 'No response yet'] as const;
export type FlowStage = (typeof stages)[number];
export type FlowNode = { id: FlowStage; count: number };
export type FlowLink = { source: FlowStage; target: FlowStage; value: number };
export type FlowApplication = Pick<
  Application,
  'status' | 'interviewRound' | 'events' | 'appliedAt'
>;
export type AppliedWindow = 0 | 30 | 90;

export function applicationPath(app: FlowApplication): FlowStage[] {
  const reached = new Set<Status>([
    ...[...app.events]
      .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
      .flatMap((event) => (event.status ? [event.status] : [])),
    app.status,
  ]);
  const rounds = Math.max(
    app.status === 'Interview' ? (app.interviewRound ?? 1) : 0,
    ...app.events.map((event) => (event.status === 'Interview' ? (event.interviewRound ?? 1) : 0)),
  );
  const path: FlowStage[] = [
    'Applications',
    ...pipeline.filter((stage) =>
      stage.startsWith('Interview ')
        ? interviewStages.indexOf(stage as (typeof interviewStages)[number]) < rounds
        : reached.has(stage as Status),
    ),
  ];
  if (terminals.some((stage) => stage === app.status)) path.push(app.status as FlowStage);
  else if (path.length === 1) path.push('No response yet');
  return path;
}

export function applicationsForStage<T extends FlowApplication>(
  applications: T[],
  stage: FlowStage,
): T[] {
  return applications.filter((app) => applicationPath(app).includes(stage));
}

export function buildFlow(applications: FlowApplication[]) {
  const counts = new Map<FlowStage, number>();
  const links = new Map<string, FlowLink>();
  let responded = 0;
  let interviews = 0;
  let offers = 0;
  for (const app of applications) {
    const path = applicationPath(app);
    for (const stage of path) counts.set(stage, (counts.get(stage) || 0) + 1);
    for (let i = 1; i < path.length; i++) {
      const source = path[i - 1];
      const target = path[i];
      const key = source + ':' + target;
      const link = links.get(key) || { source, target, value: 0 };
      link.value++;
      links.set(key, link);
    }
    if (
      path.includes('Interview 1') ||
      app.status !== 'Applied' ||
      app.events.some((event) => event.status && event.status !== 'Applied')
    )
      responded++;
    if (path.includes('Interview 1')) interviews++;
    if (path.includes('Offer')) offers++;
  }
  return {
    total: applications.length,
    responded,
    interviews,
    offers,
    nodes: stages.filter((id) => counts.has(id)).map((id) => ({ id, count: counts.get(id)! })),
    links: [...links.values()].sort(
      (a, b) =>
        stages.indexOf(a.source) - stages.indexOf(b.source) ||
        stages.indexOf(a.target) - stages.indexOf(b.target),
    ),
  };
}

export function filterApplied(applications: Application[], days: AppliedWindow, now = Date.now()) {
  if (!days) return [...applications];
  const start = now - days * 86_400_000;
  return applications.filter((app) => {
    const applied = Date.parse(app.appliedAt);
    return applied >= start && applied <= now;
  });
}
