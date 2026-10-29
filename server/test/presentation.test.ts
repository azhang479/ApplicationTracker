import { describe, expect, it } from 'vitest';
import { salary, defaultStatus, formatDate } from '../../web/src/types';
import { backendUrl, salary as extensionSalary } from '../../extension/shared.js';

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
