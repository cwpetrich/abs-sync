import { describe, expect, it } from 'vitest';
import { groupJobs, retryTargetOf, type GroupableJob } from '../lib/job-groups';

/**
 * One book, several rows: a watch queued it, it was cancelled, someone synced it
 * again from another friend, it failed. The Transfers page must show that as one
 * entry with one Retry button.
 */

function job(overrides: Partial<GroupableJob> & { id: string }): GroupableJob {
  return {
    status: 'failed',
    title: 'Mark of the Fool 10',
    author: 'J.M. Clarke',
    normTitle: 'mark of the fool 10',
    normAuthor: 'clarke jm',
    createdAt: '2026-08-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('grouping transfers by book', () => {
  it('collapses every attempt at one book into a single entry', () => {
    const groups = groupJobs([
      job({ id: 'a', status: 'canceled', createdAt: '2026-08-10T10:00:00.000Z' }),
      job({ id: 'b', status: 'failed', createdAt: '2026-08-10T11:00:00.000Z' }),
      job({ id: 'c', status: 'queued', createdAt: '2026-08-10T12:00:00.000Z' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.primary.id).toBe('c');
    expect(groups[0]!.superseded.map((attempt) => attempt.id)).toEqual(['b', 'a']);
    expect(groups[0]!.live).toBe(true);
  });

  it('keeps different books apart, including numbered volumes of one series', () => {
    const groups = groupJobs([
      job({ id: 'a', title: 'Mark of the Fool 9', normTitle: 'mark of the fool 9' }),
      job({ id: 'b', title: 'Mark of the Fool 10', normTitle: 'mark of the fool 10' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('groups the same book queued from two different servers', () => {
    // Same work, two sources: still one book, and syncing it twice would be a
    // duplicate in the library rather than two useful transfers.
    const groups = groupJobs([
      job({ id: 'from-jarom', status: 'canceled' }),
      job({ id: 'from-alex', status: 'queued' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.primary.id).toBe('from-alex');
  });

  it('prefers a running attempt, then queued, over any finished one', () => {
    const groups = groupJobs([
      job({ id: 'done', status: 'completed', createdAt: '2026-08-10T13:00:00.000Z' }),
      job({ id: 'live', status: 'running', createdAt: '2026-08-10T09:00:00.000Z' }),
    ]);

    expect(groups[0]!.primary.id).toBe('live');
  });

  it('lets a completed attempt speak for the book over a later failure', () => {
    // The book did arrive. A row saying "failed" because a stray later attempt
    // was cancelled would send you re-transferring something you already have.
    const groups = groupJobs([
      job({ id: 'late-fail', status: 'failed', createdAt: '2026-08-10T14:00:00.000Z' }),
      job({ id: 'arrived', status: 'completed', createdAt: '2026-08-10T13:00:00.000Z' }),
    ]);

    expect(groups[0]!.primary.id).toBe('arrived');
    expect(groups[0]!.live).toBe(false);
  });

  it('falls back to the displayed title when nothing is normalized', () => {
    const groups = groupJobs([
      { id: 'a', status: 'failed', title: 'Spell or High Water', author: 'Scott Meyer', createdAt: '1' },
      { id: 'b', status: 'canceled', title: 'spell or high water', author: 'scott meyer', createdAt: '2' },
    ]);

    expect(groups).toHaveLength(1);
  });

  it('orders books by their most recent activity', () => {
    const groups = groupJobs([
      job({ id: 'old', title: 'A', normTitle: 'a', createdAt: '2026-08-01T00:00:00.000Z' }),
      job({ id: 'new', title: 'B', normTitle: 'b', createdAt: '2026-08-09T00:00:00.000Z' }),
    ]);

    expect(groups.map((group) => group.primary.id)).toEqual(['new', 'old']);
  });

  it('retries whichever attempt still holds the downloaded audio', () => {
    // The newest attempt may have been cancelled before downloading anything,
    // while an older one has the whole audiobook on disk. Retrying that one
    // uploads gigabytes already fetched instead of pulling them again.
    const group = groupJobs([
      job({ id: 'newest', status: 'failed', createdAt: '2026-08-10T14:00:00.000Z' }),
      job({ id: 'has-audio', status: 'failed', hasDownload: true, createdAt: '2026-08-10T10:00:00.000Z' }),
    ])[0]!;

    expect(group.primary.id).toBe('newest');
    expect(retryTargetOf(group).id).toBe('has-audio');
  });

  it('retries the primary when no attempt kept its download', () => {
    const group = groupJobs([
      job({ id: 'newest', status: 'failed', createdAt: '2026-08-10T14:00:00.000Z' }),
      job({ id: 'older', status: 'canceled', createdAt: '2026-08-10T10:00:00.000Z' }),
    ])[0]!;

    expect(retryTargetOf(group).id).toBe('newest');
  });
});
