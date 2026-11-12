import { describe, expect, it } from 'vitest';
import {
  applicationPath,
  buildFlow,
  filterApplied,
  type FlowApplication,
} from '../../web/src/flow';
import type { Application, Status } from '../src/domain';

function app(status: Status, history: Status[] = []): FlowApplication {
  return {
    status,
    appliedAt: '2026-06-01',
    events: history.map((status, i) => ({
      at: `2026-06-${String(i + 1).padStart(2, '0')}`,
      type: 'email',
      status,
    })),
  };
}
describe('application flow', () => {
  it('builds the recorded assessment → interview → rejected path without an Applied node', () => {
    expect(
      applicationPath(
        app('Rejected', ['Applied', 'Online Assessment', 'OA Completed', 'Interview']),
      ),
    ).toEqual(['Applications', 'Online Assessment', 'OA Completed', 'Interview', 'Rejected']);
  });
  it('collapses repeated rounds and out-of-order history into an acyclic pipeline', () => {
    const input = app('Online Assessment', [
      'Interview',
      'OA Completed',
      'Online Assessment',
      'OA Completed',
      'Applied',
    ]);
    const original = structuredClone(input);
    expect(applicationPath(input)).toEqual([
      'Applications',
      'Online Assessment',
      'OA Completed',
      'Interview',
    ]);
    expect(input).toEqual(original);
  });
  it.each(['Rejected', 'Withdrawn', 'Ghosted'] as const)(
    'appends a single current %s terminal from any stage',
    (status) => {
      expect(applicationPath(app(status))).toEqual(['Applications', status]);
      expect(applicationPath(app(status, ['Online Assessment', status, 'Interview']))).toEqual([
        'Applications',
        'Online Assessment',
        'Interview',
        status,
      ]);
    },
  );
  it('ends active paths at recorded stages, leaves offers terminal, and does not infer missing history', () => {
    expect(applicationPath(app('Applied'))).toEqual(['Applications', 'No response yet']);
    expect(applicationPath(app('OA Completed'))).toEqual(['Applications', 'OA Completed']);
    expect(applicationPath(app('Offer', ['Applied', 'Interview']))).toEqual([
      'Applications',
      'Interview',
      'Offer',
    ]);
    expect(applicationPath(app('Interview', ['Ghosted', 'Online Assessment']))).toEqual([
      'Applications',
      'Online Assessment',
      'Interview',
    ]);
    expect(
      applicationPath({ ...app('Interview'), events: [{ at: 'bad-date', type: 'note' }] }),
    ).toEqual(['Applications', 'Interview']);
  });
  it('aggregates unique-app counts and merges terminal nodes reached from different stages', () => {
    const flow = buildFlow([
      app('Rejected'),
      app('Rejected', ['Interview']),
      app('Offer', ['Interview']),
      app('Applied'),
      app('Ghosted'),
      app('Withdrawn'),
    ]);
    expect(flow.nodes.find((node) => node.id === 'Applications')?.count).toBe(6);
    expect(flow.nodes.find((node) => node.id === 'Rejected')?.count).toBe(2);
    expect(flow.nodes.find((node) => node.id === 'Interview')?.count).toBe(2);
    expect(flow.links).toContainEqual({ source: 'Interview', target: 'Rejected', value: 1 });
    expect(flow.links).toContainEqual({ source: 'Applications', target: 'Rejected', value: 1 });
    expect(
      flow.links
        .filter((link) => link.source === 'Applications')
        .reduce((sum, link) => sum + link.value, 0),
    ).toBe(6);
    expect(flow.responded).toBe(5);
    expect(flow.interviews).toBe(2);
    expect(flow.offers).toBe(1);
  });
  it('counts each repeated stage once per app and aggregates links across applications', () => {
    const flow = buildFlow([
      app('Interview', ['Online Assessment', 'OA Completed', 'Online Assessment', 'OA Completed']),
      app('Interview', ['Online Assessment', 'OA Completed']),
    ]);
    expect(flow.nodes.every((node) => node.count === 2)).toBe(true);
    expect(flow.links.every((link) => link.value === 2 && link.source !== link.target)).toBe(true);
  });
  it('has no nodes, links or rates for an empty list', () => {
    expect(buildFlow([])).toEqual({
      total: 0,
      responded: 0,
      interviews: 0,
      offers: 0,
      nodes: [],
      links: [],
    });
  });
});
describe('applied-date window', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');
  const applications = [0, 30, 31, 90, 91, -1].map((days, i) => ({
    ...app('Applied'),
    id: String(i),
    appliedAt: new Date(now - days * 86_400_000).toISOString(),
  })) as Application[];
  it('includes exact boundaries and excludes future and invalid dates in limited windows', () => {
    const data = [...applications, { ...applications[0], id: 'invalid', appliedAt: 'bad-date' }];
    expect(filterApplied(data, 30, now).map((app) => app.id)).toEqual(['0', '1']);
    expect(filterApplied(data, 90, now).map((app) => app.id)).toEqual(['0', '1', '2', '3']);
    expect(filterApplied(data, 0, now)).toEqual(data);
    expect(filterApplied(data, 0, now)).not.toBe(data);
  });
  it('supports an empty list', () => {
    expect(filterApplied([], 30, now)).toEqual([]);
  });
});
