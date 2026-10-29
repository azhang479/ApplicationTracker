export type { Application, Job, Review, Status } from '../../server/src/domain';

export const statuses = [
  'Applied',
  'Online Assessment',
  'Interview',
  'Offer',
  'Rejected',
  'Withdrawn',
  'Ghosted',
] as const;
export const statusColors: Record<string, string> = {
  Applied: 'bg-blue-50 text-blue-700 ring-blue-200',
  'Online Assessment': 'bg-amber-50 text-amber-800 ring-amber-200',
  Interview: 'bg-violet-50 text-violet-700 ring-violet-200',
  Offer: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  Rejected: 'bg-rose-50 text-rose-700 ring-rose-200',
  Withdrawn: 'bg-slate-100 text-slate-600 ring-slate-200',
  Ghosted: 'bg-orange-50 text-orange-800 ring-orange-200',
};
export function defaultStatus(category: string) {
  const mapping: Record<string, (typeof statuses)[number]> = {
    rejection: 'Rejected',
    online_assessment: 'Online Assessment',
    interview: 'Interview',
    offer: 'Offer',
  };
  return mapping[category] || 'Applied';
}
export const categoryName = (category: string) =>
  ({
    confirmation: 'Application confirmation',
    rejection: 'Rejection',
    online_assessment: 'Online assessment',
    interview: 'Interview invitation',
    offer: 'Job offer',
    other: 'Other update',
  })[category] || category;
export function formatDate(value: string | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export function salary(job: {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salaryPeriod: string;
}) {
  const money = (n: number) => {
    const amount =
      n >= 1000
        ? (n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'k'
        : n.toLocaleString();
    let symbol = job.salaryCurrency + ' ';
    if (job.salaryCurrency === 'USD') symbol = '$';
    if (job.salaryCurrency === 'EUR') symbol = '€';
    if (job.salaryCurrency === 'GBP') symbol = '£';
    return symbol + amount;
  };
  const { salaryMin: min, salaryMax: max } = job;
  if (min === null && max === null) return 'Not listed';
  let value = '';
  if (min !== null && max !== null)
    value = min === max ? money(min) : money(min) + '–' + money(max);
  else if (min !== null) value = 'From ' + money(min);
  else if (max !== null) value = 'Up to ' + money(max);
  return value + (job.salaryPeriod === 'hour' ? '/hr' : '/yr');
}
