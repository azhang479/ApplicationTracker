import { describe, expect, it } from 'vitest';
import { sortApplications, type SortKey } from '../../web/src/sort';
import { statuses } from '../../web/src/types';

const apps = [
  {
    id: 'b',
    company: 'beta',
    status: 'Interview' as const,
    salaryMax: 150000,
    salaryMin: 100000,
    appliedAt: '2026-01-01',
    lastActivityAt: '2026-03-01',
  },
  {
    id: 'a',
    company: 'Acme',
    status: 'Applied' as const,
    salaryMax: null,
    salaryMin: 120000,
    appliedAt: '2026-02-01',
    lastActivityAt: '2026-01-01',
  },
  {
    id: 'c',
    company: 'Zenith',
    status: 'Offer' as const,
    salaryMax: 200000,
    salaryMin: 90000,
    appliedAt: '2026-03-01',
    lastActivityAt: '2026-02-01',
  },
];
const ids = (items: typeof apps) => items.map((app) => app.id);

describe('application sorting', () => {
  it('defaults to newest last activity first', () => {
    expect(ids(sortApplications(apps))).toEqual(['b', 'c', 'a']);
  });
  it.each([
    ['company', ['a', 'b', 'c']],
    ['status', ['a', 'b', 'c']],
    ['salary', ['a', 'b', 'c']],
    ['appliedAt', ['b', 'a', 'c']],
    ['lastActivityAt', ['a', 'c', 'b']],
  ] as [SortKey, string[]][])('sorts %s in both directions', (key, ascending) => {
    expect(ids(sortApplications(apps, key, 'asc'))).toEqual(ascending);
    expect(ids(sortApplications(apps, key, 'desc'))).toEqual([...ascending].reverse());
  });
  it('orders every status in pipeline order rather than alphabetically', () => {
    const pipeline = statuses.map((status) => ({ ...apps[0], status }));
    expect(sortApplications([...pipeline].reverse(), 'status', 'asc').map((a) => a.status)).toEqual(
      statuses,
    );
    expect(sortApplications(pipeline, 'status', 'desc').map((a) => a.status)).toEqual(
      [...statuses].reverse(),
    );
  });
  it.each(['asc', 'desc'] as const)(
    'keeps missing salaries last in %s order and preserves zero',
    (direction) => {
      const salaries = [
        { ...apps[0], id: 'missing', salaryMax: null, salaryMin: null },
        { ...apps[0], id: 'zero', salaryMax: 0 },
        { ...apps[1], id: 'min-only' },
        { ...apps[0], id: 'max' },
      ];
      const ordered = sortApplications(salaries, 'salary', direction);
      expect(ordered.at(-1)?.id).toBe('missing');
      expect(ordered.slice(0, -1).map((a) => a.id)).toEqual(
        direction === 'asc' ? ['zero', 'min-only', 'max'] : ['max', 'min-only', 'zero'],
      );
    },
  );
  it.each(['appliedAt', 'lastActivityAt'] as const)(
    'compares %s timestamps chronologically and puts invalid dates last',
    (key) => {
      const dates = [
        { ...apps[0], id: 'earlier', [key]: '2026-01-01T23:00:00-05:00' },
        { ...apps[1], id: 'later', [key]: '2026-01-02T05:00:00Z' },
        { ...apps[2], id: 'missing', [key]: '' },
        { ...apps[2], id: 'invalid', [key]: 'not-a-date' },
      ];
      expect(ids(sortApplications(dates, key, 'asc'))).toEqual([
        'earlier',
        'later',
        'missing',
        'invalid',
      ]);
      expect(ids(sortApplications(dates, key, 'desc'))).toEqual([
        'later',
        'earlier',
        'missing',
        'invalid',
      ]);
    },
  );
  it('does not mutate input and preserves input order for ties', () => {
    const tied = Object.freeze(apps.map((app) => ({ ...app, company: 'Same' })));
    expect(ids(sortApplications(tied, 'company', 'desc'))).toEqual(['b', 'a', 'c']);
    expect(tied.map((a) => a.id)).toEqual(['b', 'a', 'c']);
  });
  it('handles empty and single-item lists', () => {
    expect(sortApplications([])).toEqual([]);
    expect(sortApplications([apps[0]])).toEqual([apps[0]]);
  });
  it('sorts a filtered search result without restoring excluded applications', () => {
    const filtered = apps.filter(
      (app) => app.status !== 'Offer' && (app.company + ' ' + app.id).toLowerCase().includes('a'),
    );
    expect(ids(sortApplications(filtered, 'company', 'asc'))).toEqual(['a', 'b']);
  });
});
