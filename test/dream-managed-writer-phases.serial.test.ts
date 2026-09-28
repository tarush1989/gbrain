/**
 * A full Dream on a managed brain must run conversation_facts_backfill through
 * the native coordinated facts writer, and propose_takes must not try its
 * legacy receipt page write there.
 *
 * Live 2026-09-28: the company Dream logged
 *   [propose_takes] receipt write failed: writer_coordinator_required: ...
 * then exited 1 at conversation_facts_backfill ("conversation fact backfill
 * cannot mutate a managed brain through the legacy writer"), skipping every
 * later phase and the cycle report.
 */
import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';

const gateway = await import('../src/core/ai/gateway.ts');
let chatCalls = 0;
mock.module('../src/core/ai/gateway.ts', () => ({
  ...gateway,
  isAvailable: (kind: string) => kind === 'chat',
  chat: async () => {
    chatCalls++;
    return { text: JSON.stringify({ facts: [
      { fact: 'Alice Example signed an offer with Acme Example', kind: 'event', entity: 'alice-example', confidence: 0.9, notability: 'high' },
      { fact: 'The team meets every Monday', kind: 'fact', entity: null, confidence: 0.8, notability: 'medium' },
    ] }), stopReason: 'end' };
  },
}));

const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { runCycle } = await import('../src/core/cycle.ts');
const { runPhaseProposeTakes } = await import('../src/core/cycle/propose-takes.ts');
type ProposeTakesExtractor = import('../src/core/cycle/propose-takes.ts').ProposeTakesExtractor;
type OperationContext = import('../src/core/operations.ts').OperationContext;
type PGLite = InstanceType<typeof PGLiteEngine>;

const CONVERSATION = [
  '**Alice Example** (2024-03-15 9:00 AM): Hi, I just signed the offer letter for Acme Example.',
  '**Bob Demo** (2024-03-15 9:01 AM): Congrats! When do you start?',
  '**Alice Example** (2024-03-15 9:02 AM): Next month. The team meets every Monday.',
].join('\n');
const home = mkdtempSync(join(tmpdir(), 'gbrain-dream-managed-'));
const env = { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host' };
let engine: PGLite;

const setManaged = (on: boolean) =>
  engine.executeRaw(`UPDATE persistence_brain SET enabled=${on} WHERE singleton=1`);
const ctx = (): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never,
  dryRun: false, remote: false, sourceId: 'default',
});
const receipts = () => engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE type='extract_receipt' AND slug LIKE 'extracts/%/takes.proposed/%'");

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.putPage('wiki/managed-a', { type: 'concept', title: 'A', compiled_truth: 'Managed brains keep one canonical writer.', timeline: '', frontmatter: {} });
  await engine.putPage('wiki/managed-b', { type: 'concept', title: 'B', compiled_truth: 'Unmanaged brains accept direct page writes.', timeline: '', frontmatter: {} });
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example is an engineer.', timeline: '', frontmatter: {} });
  await engine.putPage('conversations/managed-example', { type: 'conversation', title: 'Managed example', compiled_truth: CONVERSATION, timeline: '', frontmatter: {} });
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
  await setManaged(true);
}), 120_000);

afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const conversationFacts = () => engine.executeRaw<{ fact: string; entity_slug: string | null; source_markdown_slug: string | null; source: string; context: string | null }>(
  `SELECT fact, entity_slug, source_markdown_slug, source, context FROM facts WHERE source = 'cli:extract-conversation-facts' ORDER BY fact`);

test('managed brain: conversation_facts_backfill publishes through the coordinated writer, then replays without provider calls', async () => withEnv(env, async () => {
  chatCalls = 0;
  const report = await runCycle(engine, { brainDir: null, phases: ['conversation_facts_backfill', 'enrich_thin'] });
  const phase = report.phases.find(p => p.phase === 'conversation_facts_backfill');
  expect(phase?.status).toBe('ok');
  expect(phase?.details).toMatchObject({ sources_processed: 1, pages_processed: 1, pages_failed: 0, facts_inserted: 2 });
  expect(report.phases.map(p => p.phase)).toContain('enrich_thin');
  expect(chatCalls).toBe(1);
  // Native semantics: the entity fact is fenced on its entity page; the
  // unattributed one is DB-only; both keep the conversation as provenance.
  const facts = await conversationFacts();
  expect(facts).toEqual([
    expect.objectContaining({ fact: 'Alice Example signed an offer with Acme Example', entity_slug: 'people/alice-example',
      source_markdown_slug: 'people/alice-example', context: 'conversations/managed-example' }),
    expect.objectContaining({ fact: 'The team meets every Monday', entity_slug: null, context: 'conversations/managed-example' }),
  ]);
  expect((await engine.getPage('people/alice-example'))?.compiled_truth).toContain('Alice Example signed an offer with Acme Example');
  const receipts = await engine.executeRaw<{ state: string }>(
    `SELECT state FROM persistence_requests WHERE operation='extract_facts' AND slug='__managed_facts_complete__'`);
  expect(receipts).toEqual([{ state: 'committed' }]);

  const again = await runCycle(engine, { brainDir: null, phases: ['conversation_facts_backfill'] });
  const replay = again.phases.find(p => p.phase === 'conversation_facts_backfill');
  expect(replay?.status).toBe('ok');
  expect(replay?.details).toMatchObject({ pages_processed: 0, pages_failed: 0, facts_inserted: 0 });
  expect(chatCalls).toBe(1);
  expect(await conversationFacts()).toHaveLength(2);
}));

test('managed brain: propose_takes records proposals and skips the legacy receipt page without an error', async () => withEnv(env, async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'One canonical writer prevents lost updates', kind: 'take', holder: 'brain', weight: 0.7 },
    ];
    const result = await runPhaseProposeTakes(ctx(), { extractor, once: true });
    const details = result.details as Record<string, unknown>;
    expect(details.proposals_inserted).toBeGreaterThan(0);
    expect(details.receipt).toBe('skipped_managed');
    expect(result.status).toBe('ok');
    expect(errors.mock.calls.some(c => String(c[0]).includes('receipt write failed'))).toBe(false);
    expect(await receipts()).toHaveLength(0);
  } finally { errors.mockRestore(); }
}));

test('unmanaged control: propose_takes still writes its receipt page', async () => withEnv(env, async () => {
  await setManaged(false);
  try {
    await engine.putPage('wiki/managed-c', { type: 'concept', title: 'C', compiled_truth: 'A fresh page for the control run.', timeline: '', frontmatter: {} });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Direct writes are fine without a coordinator', kind: 'take', holder: 'brain', weight: 0.6 },
    ];
    const result = await runPhaseProposeTakes(ctx(), { extractor, once: true });
    expect((result.details as Record<string, unknown>).receipt).toBe('written');
    expect(await receipts()).toHaveLength(1);
  } finally { await setManaged(true); }
}));
