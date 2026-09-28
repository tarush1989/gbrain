/**
 * Managed brains: extraction timeline writes enter the persistence coordinator.
 *
 * On a brain with `persistence_brain.enabled`, the `managed_writer_guard`
 * trigger refuses any `timeline_entries` insert made without the coordinator's
 * source capability. Pre-fix the Dream extract phase wrote timeline batches
 * directly, so every batch died with `writer_coordinator_required`, the rows
 * were dropped, the pages were still stamped as extracted, and the phase
 * reported `ok`. PGLite installs the same guard trigger as Postgres, so these
 * tests exercise the real refusal rather than a model of it.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runExtractCore } from '../src/commands/extract.ts';

// The DB page mirrors the file, as sync leaves it, so the in-cycle stale
// drain sees the same timeline the fs walk does.
const ALICE_TIMELINE = '- **2026-01-05** | meeting — Discussed the wiki\n- **2026-01-06** | email — Sent notes\n';

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

async function timelineCount(slug: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id = t.page_id
     WHERE p.slug = $1 AND p.source_id = 'wiki'`, [slug]);
  return row?.n ?? 0;
}

async function stamped(slug: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ at: string | null }>(
    `SELECT links_extracted_at AS at FROM pages WHERE slug = $1 AND source_id = 'wiki'`, [slug]);
  return row?.at != null;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-managed-'));
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-extract-managed-home-'));
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  writeFileSync(join(brainDir, 'people', 'alice.md'), `# Alice\n\nMet [[people/bob]] today.\n\n## Timeline\n\n${ALICE_TIMELINE}`);
  writeFileSync(join(brainDir, 'people', 'bob.md'), '# Bob\n\nFriend of [[people/alice]].\n');
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', $1)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`, [brainDir]);
  });
  await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  await withManagedFixtureWrite(engine, ['wiki'], tx => tx.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ('people/alice', 'wiki', 'person', 'Alice', 'Met [[people/bob]] today.', $1),
            ('people/bob', 'wiki', 'person', 'Bob', '', '')`, [ALICE_TIMELINE]));
});

afterEach(async () => {
  await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(gbrainHome, { recursive: true, force: true });
});

describe('extract timeline writes on a managed brain', () => {
  test('the guard refuses an uncoordinated timeline insert (fixture is live)', async () => {
    await expect(engine.addTimelineEntriesBatch(
      [{ slug: 'people/alice', date: '2026-01-07', source: 'x', summary: 'direct', detail: '', source_id: 'wiki' }],
    )).rejects.toThrow(/writer_coordinator_required/);
  });

  test('Dream extract full walk (extract.timeline_fs) writes timeline rows through the coordinator', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const report = await runCycle(engine, { brainDir, phases: ['extract'] });
      const phase = report.phases.find(p => p.phase === 'extract');
      expect(phase?.status).toBe('ok');
      expect(phase?.details?.timeline_rows_lost).toBeUndefined();
      expect(Number(phase?.details?.timelineCreated ?? 0)).toBe(2);
    });
    expect(await timelineCount('people/alice')).toBe(2);
    expect(await stamped('people/alice')).toBe(true);
  });

  test('incremental cycle path (extract.timeline_inc) writes timeline rows through the coordinator', async () => {
    const result = await runExtractCore(engine, {
      mode: 'all', dir: brainDir, slugs: ['people/alice'], sourceId: 'wiki', jsonMode: true, quiet: true,
    });
    expect(result.timeline_rows_lost).toBeUndefined();
    expect(result.timeline_entries_created).toBe(2);
    expect(await timelineCount('people/alice')).toBe(2);
  });

  test('a lost timeline batch fails the phase and leaves the page stale for retry', async () => {
    const original = engine.addTimelineEntriesBatch;
    // Transaction engines inherit from `engine`, so this also covers tx writes.
    engine.addTimelineEntriesBatch = async () => {
      throw new Error('writer_coordinator_required: canonical writer must use the persistence coordinator');
    };
    try {
      await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
        const report = await runCycle(engine, { brainDir, phases: ['extract'] });
        const phase = report.phases.find(p => p.phase === 'extract');
        expect(phase?.status).toBe('fail');
        expect(phase?.error?.code).toBe('TIMELINE_ROWS_LOST');
        expect(Number(phase?.details?.timeline_rows_lost)).toBe(2);
        expect(report.status).not.toBe('ok');
      });
    } finally {
      engine.addTimelineEntriesBatch = original;
    }
    expect(await timelineCount('people/alice')).toBe(0);
    expect(await stamped('people/alice')).toBe(false);
  });
});
