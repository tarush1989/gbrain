/**
 * The managed conversation facts session probes the canonical writer lock
 * without waiting. Live 2026-09-29 the company Dream failed 5 pages with
 * "The canonical fact writer is busy" in the same second the previous page's
 * coordinated publish finished. Opening a page must ride out a briefly busy
 * lock, and still fail the page truthfully when the lock stays busy.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';

const real = await import('../src/core/persistence/facts-maintenance.ts');
let busyFor = 0;
let prepareCalls = 0;
let failWith: Error | null = null;
mock.module('../src/core/persistence/facts-maintenance.ts', () => ({
  ...real,
  prepareManagedFactsSession: async () => {
    prepareCalls++;
    if (failWith) throw failWith;
    if (prepareCalls <= busyFor) {
      throw new OperationError('writer_lock_unavailable', 'The canonical fact writer is busy; extraction has not started.');
    }
    return { config: {} };
  },
  resumeManagedFacts: async () => ({ inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [], write_requests: [] }),
}));

const { openConversationManagedPage } = await import('../src/core/facts/conversation-managed.ts');
const input = { sourceId: 'default', slug: 'meetings/example', versionToken: 'v1', body: 'x', source: 'cli:extract-conversation-facts',
  retryDelaysMs: [1, 1, 1] };

afterEach(() => { busyFor = 0; prepareCalls = 0; failWith = null; });

test('a briefly busy writer lock is retried and the page opens', async () => {
  busyFor = 2;
  const page = await openConversationManagedPage({} as never, input);
  expect(prepareCalls).toBe(3);
  expect(page.completed).not.toBeNull();
});

test('a writer lock that stays busy still fails the page after the bounded retries', async () => {
  busyFor = 99;
  await expect(openConversationManagedPage({} as never, input)).rejects.toMatchObject({ code: 'writer_lock_unavailable' });
  expect(prepareCalls).toBe(4);
});

test('any other refusal is not retried', async () => {
  failWith = new OperationError('owner_unavailable', 'The canonical fact writer is unavailable; extraction has not started.');
  await expect(openConversationManagedPage({} as never, input)).rejects.toMatchObject({ code: 'owner_unavailable' });
  expect(prepareCalls).toBe(1);
});

test('an abort during the wait stops retrying', async () => {
  busyFor = 99;
  const controller = new AbortController();
  const pending = openConversationManagedPage({} as never, { ...input, retryDelaysMs: [60_000], signal: controller.signal });
  await Bun.sleep(5);
  controller.abort(new Error('aborted'));
  await expect(pending).rejects.toThrow('aborted');
  expect(prepareCalls).toBe(1);
});
