import { statuses, type Application } from './types';

export type SortKey = 'company' | 'status' | 'salary' | 'appliedAt' | 'lastActivityAt';
export type SortDirection = 'asc' | 'desc';
type SortableApplication = Pick<
  Application,
  'company' | 'status' | 'salaryMax' | 'salaryMin' | 'appliedAt' | 'lastActivityAt'
>;

function sortValue(app: SortableApplication, key: SortKey): string | number | null {
  if (key === 'company') return app.company;
  if (key === 'status') return statuses.indexOf(app.status);
  if (key === 'salary') return app.salaryMax ?? app.salaryMin;
  const date = Date.parse(app[key]);
  return Number.isFinite(date) ? date : null;
}

export function sortApplications<T extends SortableApplication>(
  apps: readonly T[],
  key: SortKey = 'lastActivityAt',
  direction: SortDirection = 'desc',
): T[] {
  return [...apps].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    const comparison =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), undefined, { sensitivity: 'base' });
    return direction === 'asc' ? comparison : -comparison;
  });
}
