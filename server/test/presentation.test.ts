import { describe, expect, it } from 'vitest';
import { salary, defaultStatus, formatDate } from '../../web/src/types';
import { backendUrl, salary as extensionSalary } from '../../extension/shared.js';
import { reviewApplications } from '../../web/src/review';

describe('dashboard presentation', () => {
  const job = { salaryMin: 120000, salaryMax: 150000, salaryCurrency: 'USD', salaryPeriod: 'year' };
  it('formats salary ranges and hourly pay', () => {
    expect(salary(job)).toBe('$120k–$150k/yr');
    expect(salary({ ...job, salaryMin: 50, salaryMax: 70, salaryPeriod: 'hour' })).toBe(
      '$50–$70/hr',
    );
  });
  it('handles missing and one-sided salaries', () => {
    expect(salary({ ...job, salaryMin: null, salaryMax: null })).toBe('Not listed');
    expect(salary({ ...job, salaryMin: null })).toBe('Up to $150k/yr');
    expect(salary({ ...job, salaryMax: null })).toBe('From $120k/yr');
  });
  it('uses the category to suggest status and handles absent dates', () => {
    expect(defaultStatus('rejection')).toBe('Rejected');
    expect(defaultStatus('interview')).toBe('Interview');
    expect(defaultStatus('confirmation')).toBe('Applied');
    expect(formatDate('invalid')).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });
  it('marks extension salary estimates', () => {
    expect(extensionSalary({ ...job, salaryIsEstimated: true })).toBe('$120k–$150k/yr · est.');
  });
});
describe('review application options', () => {
  const apps = [
    { id: 'z', company: 'Zenith', title: 'Engineer' },
    { id: 'b', company: 'Acme', title: 'Product Designer' },
    { id: 'a', company: 'Acme', title: 'Backend Engineer' },
    { id: 'c', company: 'Beta', title: 'Engineer' },
  ];
  const candidates = [
    { applicationId: 'z', company: 'Zenith', title: 'Engineer', score: 1.5 },
    { applicationId: 'c', company: 'Beta', title: 'Engineer', score: 0.8 },
  ];
  it('puts candidates first in ranked order with scores and does not repeat them', () => {
    const options = reviewApplications(apps, candidates);
    expect(options.bestMatches).toEqual([
      { ...apps[0], score: 1.5 },
      { ...apps[3], score: 0.8 },
    ]);
    expect(options.others.map((app) => app.id)).toEqual(['a', 'b']);
    expect(apps.map((app) => app.id)).toEqual(['z', 'b', 'a', 'c']);
  });
  it('sorts all applications by company then title when there are no candidates', () => {
    const options = reviewApplications(apps, []);
    expect(options.bestMatches).toEqual([]);
    expect(options.others.map((app) => app.id)).toEqual(['a', 'b', 'c', 'z']);
  });
  it('handles no applications and ignores missing or repeated candidates', () => {
    expect(reviewApplications([], candidates)).toEqual({ bestMatches: [], others: [] });
    const options = reviewApplications(apps, [
      { ...candidates[0], applicationId: 'deleted' },
      candidates[1],
      candidates[1],
    ]);
    expect(options.bestMatches).toEqual([{ ...apps[3], score: 0.8 }]);
    expect(options.others.map((app) => app.id)).toEqual(['a', 'b', 'z']);
  });
});
describe('extension address validation', () => {
  it('allows only the permitted Cloud Run and local origins', () => {
    expect(backendUrl('https://tracker.example.run.app')).toBe('https://tracker.example.run.app');
    expect(backendUrl('http://localhost:8080/')).toBe('http://localhost:8080');
  });
  it.each([
    'https://example.com',
    'http://tracker.run.app',
    'http://localhost:3000',
    'https://example.run.app/path',
    'https://user:secret@example.run.app',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => backendUrl(url)).toThrow();
  });
});
