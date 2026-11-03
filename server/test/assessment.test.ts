import { describe, expect, it } from 'vitest';
import { assessmentEmailLink } from '../../web/src/assessment';
import { statuses, defaultStatus, categoryName, statusColors } from '../../web/src/types';
import { statuses as serverStatuses } from '../src/domain';
import { sortApplications } from '../../web/src/sort';

describe('OA presentation', () => {
  const invite = {
    at: '2026-01-01T00:00:00Z',
    type: 'online_assessment',
    gmailLink: 'https://mail.google.com/mail/u/0/#all/first',
  };
  it('keeps status lists and pipeline sorting aligned', () => {
    expect(statuses).toEqual(serverStatuses);
    expect(statuses[statuses.indexOf('Online Assessment') + 1]).toBe('OA Completed');
    expect(defaultStatus('assessment_completed')).toBe('OA Completed');
    expect(categoryName('assessment_completed')).toBe('Assessment completed');
    expect(statusColors['OA Completed']).toContain('slate');
    const apps = ['Interview', 'OA Completed', 'Online Assessment'].map((status) => ({
      company: '',
      status: status as (typeof statuses)[number],
      salaryMax: null,
      salaryMin: null,
      appliedAt: '',
      lastActivityAt: '',
    }));
    expect(sortApplications(apps, 'status', 'asc').map((app) => app.status)).toEqual([
      'Online Assessment',
      'OA Completed',
      'Interview',
    ]);
  });
  it('selects the newest invite by email date even when processing order differs', () => {
    const events = [
      {
        ...invite,
        at: '2026-01-03T00:00:00Z',
        emailDate: '2026-01-03T00:00:00Z',
        gmailLink: invite.gmailLink + '-latest',
      },
      { ...invite, at: '2026-01-05T00:00:00Z', emailDate: '2026-01-02T00:00:00Z' },
      {
        ...invite,
        at: '2026-01-06T00:00:00Z',
        type: 'assessment_completed',
        gmailLink: invite.gmailLink + '-completed',
      },
      {
        ...invite,
        at: '2026-01-07T00:00:00Z',
        type: 'interview',
        gmailLink: invite.gmailLink + '-interview',
      },
    ];
    expect(assessmentEmailLink({ events })).toBe(invite.gmailLink + '-latest');
    expect(events[0].gmailLink).toBe(invite.gmailLink + '-latest');
  });
  it('uses event time for legacy invites without a valid email date and breaks ties by timeline order', () => {
    expect(assessmentEmailLink({ events: [invite] })).toBe(invite.gmailLink);
    expect(
      assessmentEmailLink({
        events: [
          invite,
          {
            ...invite,
            at: '2026-01-02T00:00:00Z',
            emailDate: 'invalid',
            gmailLink: invite.gmailLink + '-new',
          },
        ],
      }),
    ).toBe(invite.gmailLink + '-new');
    expect(
      assessmentEmailLink({
        events: [invite, { ...invite, gmailLink: invite.gmailLink + '-tie' }],
      }),
    ).toBe(invite.gmailLink + '-tie');
  });
  it('handles empty/legacy timelines and skips missing links, non-invites and invalid dates', () => {
    expect(assessmentEmailLink({ events: [] })).toBeUndefined();
    expect(assessmentEmailLink({ events: [{ at: invite.at, type: 'applied' }] })).toBeUndefined();
    expect(assessmentEmailLink({ events: [{ ...invite, gmailLink: undefined }] })).toBeUndefined();
    expect(assessmentEmailLink({ events: [{ ...invite, at: 'invalid' }] })).toBeUndefined();
    expect(
      assessmentEmailLink({
        events: [invite, { ...invite, at: '2026-01-03T00:00:00Z', gmailLink: undefined }],
      }),
    ).toBe(invite.gmailLink);
  });
});
