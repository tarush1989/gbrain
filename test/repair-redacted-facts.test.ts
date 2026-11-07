/**
 * `gbrain repair redacted-facts` (#7125) and doctor `facts_redaction_marker`, on PGLite
 * and, with a safe DATABASE_URL, Postgres (test/e2e/repair-redacted-facts-postgres.test.ts).
 *
 * Protects: a fact whose stored text lost a word to the pre-fix sanitizer
 * ("Business [redacted](ABS)") is restored only from a source page that proves
 * the original words; a fenced row is rewritten in its page (so the canonical
 * projection keeps it) and a database-only row in place; a fact no source can
 * prove, or whose sources disagree, is listed and left unchanged; the apply is
 * bound to the preview hash; a fact edited since the preview is reported and
 * kept; the finding clears.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderFactsTable, FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { factsRedactionMarkerCheck } from '../src/commands/doctor/checks/facts-redaction-marker.ts';
import { classifyRedactedFacts, redactedFactsRepair, restoreRedactedRows, LEGACY_REDACTED_FACTS_INTENT, REDACTED_FACTS_INTENT, type RedactedFactsPage } from '../src/core/repair/redacted-facts.ts';
import { loadApprovedSet, saveApprovedSet, previewHash } from '../src/core/persistence/preview-approval.ts';
import { runWaveChecks } from '../src/commands/doctor/wave-checks.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';
import { resolvePageWriteTarget } from '../src/core/write-through.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../src/core/persistence/prepared-maintenance.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { acquirePageLock } from '../src/core/page-lock.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { withEnv } from './helpers/with-env.ts';
import { _resetCliExitVerdictForTests, currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';

const ACME = 'companies/acme-example';
const NOTES = 'notes/operating-models';
const SOURCE_TEXT = 'Reading list. The Acme Business System (ABS) was developed under the CEO in the 1980s. '
  + 'The Example Operating System (EXOS) is positioned as a layer beneath the planning tools.';
const ABS_DAMAGED = 'Acme Business [redacted](ABS) was developed under the CEO in the 1980s';
const ABS_RESTORED = 'Acme Business System (ABS) was developed under the CEO in the 1980s';
const EXOS_DAMAGED = 'The Example Operating [redacted](EXOS) is positioned as a layer beneath the planning tools';
const EXOS_RESTORED = 'The Example Operating System (EXOS) is positioned as a layer beneath the planning tools';

interface RepairJson { results: Array<{ affected: number; residuals: Record<string, number>; apply_command: string; applied: number; failed?: unknown[];
  listing?: Array<{ item: string; class: string; detail?: string }>; outcomes?: Record<string, number> }> }

async function repair(engine: BrainEngine, args: string[]): Promise<RepairJson> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['redacted-facts', ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as RepairJson;
}
const applyArgs = (json: RepairJson) => json.results[0].apply_command.split(' ').slice(3);

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const factText = async (engine: BrainEngine, id: number) =>
  (await engine.executeRaw<{ fact: string; active: boolean }>('SELECT fact, expired_at IS NULL AS active FROM facts WHERE id=$1', [id]))[0];
const putPage = (ctx: OperationContext, slug: string, content: string) =>
  submitPageMutation(ctx, { operation: 'put_page', params: { request_id: randomUUID(), slug, source_id: 'default', content } });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`gbrain repair redacted-facts, managed (${backend})`, () => {
    test('unbound database-only and connector holders restore only the selected source, including a shared slug', async () => {
      const sources = ['legacy-database-only', 'legacy-connector'];
      await managedBrain(async ({ engine, ctx, root }) => {
        const holder = 'companies/shared-legacy-example';
        const ids: number[] = [];
        for (const source of sources) {
          await submitPageMutation({ ...ctx, sourceId: source }, { operation: 'put_page', params: {
            request_id: randomUUID(), source_id: source, slug: holder,
            content: `---\ntype: company\ntitle: Legacy Example\n---\n${SOURCE_TEXT}\n`,
          } });
          ids.push(await engine.transaction(tx => withCoordinatedWrite(tx, [source], async () =>
            Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts
              (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
              VALUES ($1, $2, $2, 2, $3, 'fact', 'private', 'cli:extract-conversation-facts', $2) RETURNING id`, [source, holder, ABS_DAMAGED]))[0].id), TEST_WRITE_ATTRIBUTION)));
        }
        for (let index = 0; index < sources.length; index++) {
          const source = sources[index]!;
          expect((await engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE source_id=$1', [source]))).toEqual([]);
          const [candidate] = await classifyRedactedFacts(engine, [source], { ids: [ids[index]!] });
          expect(candidate).toMatchObject({ class: 'evidenced', route: 'legacy_database', source_id: source });
          const preview = await repair(engine, ['--source', source]);
          expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ restored: 1 });
          expect((await factText(engine, ids[index]!)).fact).toBe(ABS_RESTORED);
          if (index === 0) expect((await factText(engine, ids[1]!)).fact).toBe(ABS_DAMAGED);
        }
        // Value: protects=an unbound managed source with a checkout (local_path) holds a proved legacy row instead of
        // restoring it database-only; fails_when=the local_path branch of the unbound-source check returns null, so an
        // unverified canonical file is bypassed; why_new=the rows above cover only a connector and a source without a
        // path; seam=none; no_claim=the sync.repo_path variant of the default source
        const checkoutSource = sources[0]!;
        const checkout = join(dirname(root), 'legacy-checkout'); mkdirSync(checkout);
        await engine.transaction(async tx => {
          await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
          await tx.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [checkoutSource, checkout]);
        });
        const checkoutId = await engine.transaction(tx => withCoordinatedWrite(tx, [checkoutSource], async () =>
          Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ($1, $2, $2, 3, $3, 'fact', 'private', 'cli:extract-conversation-facts', $2) RETURNING id`, [checkoutSource, holder, ABS_DAMAGED]))[0].id), TEST_WRITE_ATTRIBUTION));
        expect((await engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE source_id=$1', [checkoutSource]))).toEqual([]);
        expect((await classifyRedactedFacts(engine, [checkoutSource], { ids: [checkoutId] }))[0])
          .toMatchObject({ class: 'held', reason: 'legacy_canonical_unproven', restored: ABS_RESTORED });
        expect((await factText(engine, checkoutId)).fact).toBe(ABS_DAMAGED);
      }, { databaseUrl, setup: async ({ engine }) => {
        for (const source of sources) {
          await engine.executeRaw('INSERT INTO sources(id,name,config) VALUES($1,$1,$2::jsonb)',
            [source, JSON.stringify(source === 'legacy-connector' ? { kind: 'google' } : {})]);
        }
      } });
    }, 180_000);

    test('a terminal owner refusal preserves the fact and a fresh apply advances the native request attempt', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, ACME, `---\ntype: company\ntitle: Acme Example\n---\n${SOURCE_TEXT}\n`);
        const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
          Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ('default', $1, $1, 2, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [ACME, ABS_DAMAGED]))[0].id), TEST_WRITE_ATTRIBUTION));
        const preview = await repair(engine, []);
        // The existing consumer fault boundary supplies the old owner's refusal;
        // this tests recovery, not execution of an old binary.
        const priorVerdict = currentExitCode();
        const priorProcessExitCode = process.exitCode;
        expect(priorVerdict).toBe(0);
        expect(priorProcessExitCode ?? 0).toBe(0);
        installFaultHook((point, detail) => {
          if (point === 'consumer:prepared' && detail.operation === 'submit_job') {
            throw new OperationError('invalid_params', 'Unsupported maintenance request.', 'Upgrade the canonical owner and preview again.');
          }
        });
        try {
          expect((await repair(engine, applyArgs(preview))).results[0].failed).toHaveLength(1);
          expect(currentExitCode()).toBe(1);
        } finally {
          installFaultHook(undefined);
          _resetCliExitVerdictForTests();
          if (priorVerdict !== 0) setCliExitVerdict(priorVerdict);
          process.exitCode = priorProcessExitCode ?? 0;
        }
        expect(currentExitCode()).toBe(priorVerdict);
        expect(process.exitCode ?? 0).toBe(priorProcessExitCode ?? 0);
        expect((await factText(engine, id)).fact).toBe(ABS_DAMAGED);
        const fresh = await repair(engine, []);
        expect(applyArgs(fresh)).toEqual(applyArgs(preview));
        const recovered = (await repair(engine, applyArgs(fresh))).results[0];
        expect(recovered.outcomes).toEqual({ restored: 1 });
        expect(recovered.failed ?? []).toEqual([]);
        expect(currentExitCode()).toBe(priorVerdict);
        const requests = await engine.executeRaw<{ request_id: string; state: string }>(
          "SELECT request_id,state FROM persistence_requests WHERE intent->>'kind'=$1 ORDER BY sequence", [LEGACY_REDACTED_FACTS_INTENT]);
        expect(requests.map(row => row.state)).toEqual(['failed', 'committed']);
        expect(new Set(requests.map(row => row.request_id)).size).toBe(2);
        expect((await factText(engine, id)).fact).toBe(ABS_RESTORED);
      }, { databaseUrl });
    }, 180_000);

    test('malformed legacy intents cannot relax the NULL-only request or write through another holder key', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, ACME, `---\ntype: company\ntitle: Acme Example\n---\n${SOURCE_TEXT}\n`);
        const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
          Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ('default', $1, $1, 2, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [ACME, ABS_DAMAGED]))[0].id), TEST_WRITE_ATTRIBUTION));
        const snapshot = (await engine.readPageSnapshot(ACME, { sourceId: 'default' }))!;
        const authority = (await maintenancePreflight(engine, 'default'))!;
        const restore = { id, from: ABS_DAMAGED, to: ABS_RESTORED, visibility: 'private', entity_slug: ACME,
          source_markdown_slug: ACME, expected_row_num: 2, fact_source: 'cli:extract-conversation-facts' };
        for (const invalid of [null, { ...restore, expected_row_num: -1 }, { ...restore, fact_source: undefined },
          { ...restore, fact_source: 'cli:extract-conversation-factsX' }, { ...restore, source_markdown_slug: NOTES }]) {
          expect((await refusal(() => submitDatabaseMaintenanceIntent(engine, authority, ACME,
            { kind: LEGACY_REDACTED_FACTS_INTENT, expected_revision: snapshot.revision, restores: [invalid] }, randomUUID()))).code).toBe('invalid_params');
          expect((await factText(engine, id)).fact).toBe(ABS_DAMAGED);
        }
        expect((await refusal(() => submitDatabaseMaintenanceIntent(engine, authority, ACME,
          { kind: REDACTED_FACTS_INTENT, expected_revision: snapshot.revision, restores: [restore] }, randomUUID()))).code).toBe('invalid_params');
        expect((await factText(engine, id)).fact).toBe(ABS_DAMAGED);
      }, { databaseUrl });
    }, 180_000);

    test('an old approval keeps ordinary and true-fenced restores but cannot acquire the new legacy route', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, NOTES, `---\ntype: note\ntitle: Operating models\n---\n${SOURCE_TEXT}\n`);
        await putPage(ctx, ACME, `---\ntype: company\ntitle: Acme Example\n---\n## Facts\n${renderFactsTable([
          { rowNum: 1, claim: ABS_DAMAGED, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true, context: NOTES },
        ] as never)}\n`);
        const legacyHolder = 'companies/legacy-approval-example';
        await putPage(ctx, legacyHolder, '---\ntype: company\ntitle: Legacy Example\n---\nLegacy notes without a fence.\n');
        const ids = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
          tx.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ('default', $1, NULL, NULL, $2, 'fact', 'private', 'mcp:put_page', $3),
                   ('default', $4, $4, 2, $5, 'fact', 'private', 'cli:extract-conversation-facts', $3)
            RETURNING id`, [ACME, EXOS_DAMAGED, NOTES, legacyHolder, ABS_DAMAGED]), TEST_WRITE_ATTRIBUTION));
        const preview = await repair(engine, []);
        const hash = applyArgs(preview).at(-1)!;
        const approved = await loadApprovedSet<RedactedFactsPage>(engine, { command: 'redacted-facts', hash, previewCommand: 'gbrain repair redacted-facts' });
        const candidates = await classifyRedactedFacts(engine, ['default']);
        const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
        // Exact persisted pre-change wire shape: neither the new route nor provenance/revision fields existed.
        const oldHash = previewHash(['redacted-facts-v1', brain?.brain_id ?? 'host', ['default'],
          candidates.map(f => [f.id, f.class, f.reason, f.fact_hash, f.restored])]);
        const oldItems = approved.items.map(page => ({ ...page, facts: page.facts.map(f => {
          const { route, fact_source, holder_revision, ...old } = f;
          return old;
        }) }));
        await saveApprovedSet(engine, { command: 'redacted-facts', hash: oldHash }, oldItems);
        expect((await repair(engine, ['--apply', '--expect', oldHash])).results[0].outcomes)
          .toEqual({ restored: 1, changed_since_preview: 1 });
        expect((await factText(engine, Number(ids[0]!.id))).fact).toBe(EXOS_RESTORED);
        expect((await factText(engine, Number(ids[1]!.id))).fact).toBe(ABS_DAMAGED);
        expect((await engine.readPageSnapshot(ACME, { sourceId: 'default' }))!.page.compiled_truth).toContain(ABS_RESTORED);
      }, { databaseUrl });
    }, 180_000);

    test('a stale canonical file holds a proved legacy row and cannot grant an old preview a new restoration', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, ACME, `---\ntype: company\ntitle: Acme Example\n---\n${SOURCE_TEXT}\n`);
        const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
          Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ('default', $1, $1, 2, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [ACME, ABS_DAMAGED]))[0].id), TEST_WRITE_ATTRIBUTION));
        const preview = await repair(engine, []);
        const holder = await engine.readPageSnapshot(ACME, { sourceId: 'default' });
        const target = await resolvePageWriteTarget(engine, ACME, 'default');
        if (!target.ok) throw new Error(`fixture has no canonical file: ${target.skipped}`);
        const original = readFileSync(target.filePath, 'utf8');
        writeFileSync(target.filePath, `${original}\n${renderFactsTable([])}\n`);
        const [candidate] = await classifyRedactedFacts(engine, ['default'], { ids: [id] });
        expect(candidate).toMatchObject({ class: 'held', reason: 'legacy_canonical_unproven', restored: ABS_RESTORED });
        expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ changed_since_preview: 1 });
        expect((await factText(engine, id)).fact).toBe(ABS_DAMAGED);
        expect(await engine.readPageSnapshot(ACME, { sourceId: 'default' })).toEqual(holder);
        // Value: protects=the operator sees the held count and its reason in the preview; fails_when=held is omitted from
        // the preview residuals or the legacy_canonical_unproven DETAILS entry is missing from the listing;
        // why_new=the classification above is checked directly, not through the preview output; seam=none;
        // no_claim=the human text format of the preview
        const heldPreview = (await repair(engine, [])).results[0];
        expect(heldPreview.residuals).toEqual({ evidenced: 0, ambiguous: 0, unproven: 0, segmented: 0, held: 1 });
        const heldRow = heldPreview.listing!.find(l => l.item === `default:${ACME}#${id}`)!;
        expect(heldRow.class).toBe('held');
        expect(heldRow.detail).toContain(ABS_RESTORED);
        expect(heldRow.detail).toContain('the canonical file and database cannot be proved to agree');
        writeFileSync(target.filePath, original);
      }, { databaseUrl });
    }, 180_000);

    for (const boundary of ['direct intent', 'after preparation'] as const) {
      test(`owner execution rechecks canonical file agreement for a legacy restore (${boundary})`, async () => {
        await managedBrain(async ({ engine, ctx }) => {
          await putPage(ctx, ACME, `---\ntype: company\ntitle: Acme Example\n---\n${SOURCE_TEXT}\n`);
          const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
            Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts
              (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
              VALUES ('default', $1, $1, 2, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [ACME, ABS_DAMAGED]))[0].id), TEST_WRITE_ATTRIBUTION));
          const holder = (await engine.readPageSnapshot(ACME, { sourceId: 'default' }))!;
          const target = await resolvePageWriteTarget(engine, ACME, 'default');
          if (!target.ok) throw new Error(`fixture has no canonical file: ${target.skipped}`);
          const original = readFileSync(target.filePath, 'utf8');
          const diverge = () => writeFileSync(target.filePath, `${original}\n${renderFactsTable([])}\n`);
          const priorVerdict = currentExitCode();
          const priorProcessExitCode = process.exitCode;
          try {
            if (boundary === 'direct intent') {
              const authority = (await maintenancePreflight(engine, 'default'))!;
              diverge();
              const rejected = await refusal(() => submitDatabaseMaintenanceIntent(engine, authority, ACME,
                { kind: LEGACY_REDACTED_FACTS_INTENT, expected_revision: holder.revision, restores: [{
                  id, from: ABS_DAMAGED, to: ABS_RESTORED, visibility: 'private', entity_slug: ACME,
                  source_markdown_slug: ACME, expected_row_num: 2, fact_source: 'cli:extract-conversation-facts',
                }] }, randomUUID()));
              expect(rejected.code).toBe('source_changed');
            } else {
              const preview = await repair(engine, []);
              let ownerPrepared = false;
              installFaultHook((point, detail) => {
                if (point === 'consumer:prepared' && detail.operation === 'submit_job') {
                  ownerPrepared = true;
                  diverge();
                }
              });
              expect((await repair(engine, applyArgs(preview))).results[0].failed).toHaveLength(1);
              expect(currentExitCode()).toBe(1);
              expect(ownerPrepared).toBe(true);
            }
            expect((await factText(engine, id)).fact).toBe(ABS_DAMAGED);
            expect(await engine.readPageSnapshot(ACME, { sourceId: 'default' })).toEqual(holder);
          } finally {
            installFaultHook(undefined);
            writeFileSync(target.filePath, original);
            _resetCliExitVerdictForTests();
            if (priorVerdict !== 0) setCliExitVerdict(priorVerdict);
            process.exitCode = priorProcessExitCode ?? 0;
          }
          // The same row remains repairable when the canonical file agrees again.
          const fresh = await repair(engine, []);
          expect((await repair(engine, applyArgs(fresh))).results[0].outcomes).toEqual({ restored: 1 });
          expect((await factText(engine, id)).fact).toBe(ABS_RESTORED);
          const requests = await engine.executeRaw<{ state: string; request_id: string }>(
            "SELECT state,request_id FROM persistence_requests WHERE intent->>'kind'=$1 ORDER BY sequence", [LEGACY_REDACTED_FACTS_INTENT]);
          expect(requests.map(row => row.state)).toEqual(['conflict', 'committed']);
          expect(new Set(requests.map(row => row.request_id)).size).toBe(2);
        }, { databaseUrl });
      }, 180_000);
    }

    test('a holder revision change invalidates the old legacy preview and a fresh preview restores it', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, ACME, `---\ntype: company\ntitle: Acme Example\n---\n${SOURCE_TEXT}\n`);
        const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
          Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ('default', $1, $1, 2, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [ACME, ABS_DAMAGED]))[0].id), TEST_WRITE_ATTRIBUTION));
        const preview = await repair(engine, []);
        const before = (await engine.readPageSnapshot(ACME, { sourceId: 'default' }))!;
        await submitPageMutation(ctx, { operation: 'put_page', params: { request_id: randomUUID(), slug: ACME,
          source_id: 'default', expected_revision: before.revision,
          content: `---\ntype: company\ntitle: Acme Example\n---\n${SOURCE_TEXT}\n\nA later owner note.\n`,
        } });
        const changed = (await engine.readPageSnapshot(ACME, { sourceId: 'default' }))!;
        expect(changed.revision).not.toBe(before.revision);
        expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ changed_since_preview: 1 });
        expect((await factText(engine, id)).fact).toBe(ABS_DAMAGED);
        expect(await engine.readPageSnapshot(ACME, { sourceId: 'default' })).toEqual(changed);
        const fresh = await repair(engine, []);
        expect(applyArgs(fresh)).not.toEqual(applyArgs(preview));
        expect((await repair(engine, applyArgs(fresh))).results[0].outcomes).toEqual({ restored: 1 });
        expect((await factText(engine, id)).fact).toBe(ABS_RESTORED);
      }, { databaseUrl });
    }, 180_000);

    test('a legacy row changing provenance, coordinate, privacy, holder or active state after preview is left unchanged', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, ACME, `---\ntype: company\ntitle: Acme Example\n---\n${SOURCE_TEXT}\n`);
        const mutate = (sql: string, values: unknown[]) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'],
          () => tx.executeRaw(sql, values), TEST_WRITE_ATTRIBUTION));
        const id = Number((await mutate(`INSERT INTO facts
          (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
          VALUES ('default', $1, $1, 2, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [ACME, ABS_DAMAGED]))[0].id);
        for (const change of ["source='cli:extract-conversation-facts:changed'", 'row_num=3', "visibility='world'", 'source_markdown_slug=NULL', 'expired_at=now()']) {
          const preview = await repair(engine, []);
          // All SQL fragments are fixed synthetic fixture mutations, never user input.
          await mutate(`UPDATE facts SET ${change} WHERE id=$1`, [id]);
          expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ changed_since_preview: 1 });
          expect((await factText(engine, id)).fact).toBe(ABS_DAMAGED);
          await mutate(`UPDATE facts SET source='cli:extract-conversation-facts',row_num=2,visibility='private',
            source_markdown_slug=$2,expired_at=NULL WHERE id=$1`, [id, ACME]);
        }
      }, { databaseUrl });
    }, 180_000);

    test('legacy extractor coordinates without a canonical fence restore the original rows without changing the holder or metadata', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, NOTES, `---\ntype: note\ntitle: Operating models\n---\n${SOURCE_TEXT}\n`);
        await putPage(ctx, ACME, '---\ntype: company\ntitle: Acme Example\n---\nAcme Example notes without a facts fence.\n');
        const ids = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
          const rows = await tx.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ('default', $1, $1, 0, $2, 'fact', 'private', 'cli:extract-conversation-facts', $3),
                   ('default', $1, $1, 2, $4, 'fact', 'private', 'cli:extract-conversation-facts:legacy', $3),
                   ('default', $1, $1, 3, $2, 'fact', 'private', 'cli:extract-conversation-factsX', $3)
            RETURNING id`, [ACME, ABS_DAMAGED, NOTES, EXOS_DAMAGED]);
          return rows.map(row => Number(row.id));
        }, TEST_WRITE_ATTRIBUTION));
        const [first, second, unrelated] = ids;
        const rows = () => engine.executeRaw<Record<string, unknown>>('SELECT * FROM facts WHERE id=ANY($1::bigint[]) ORDER BY id', [ids]);
        const before = await rows();
        const holder = await engine.readPageSnapshot(ACME, { sourceId: 'default' });
        const versions = () => engine.executeRaw('SELECT * FROM page_versions WHERE page_id=$1 ORDER BY id', [holder!.page.id]);
        const beforeVersions = await versions();
        const preview = await repair(engine, []);
        expect(preview.results[0].listing!.filter(row => row.class === 'evidenced')).toHaveLength(3);
        expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ partially_restored: 1 });
        const after = await rows();
        const requests = await engine.executeRaw<{ id: string; principal_kind: string; principal_id: string; created_at: Date; updated_at: Date }>(
          "SELECT id,principal_kind,principal_id,created_at,updated_at FROM persistence_requests WHERE state='committed' AND intent->>'kind'='managed_maintenance_restore_legacy_redacted_facts'");
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        for (let i = 0; i < before.length; i++) {
          const expected = { ...before[i] };
          if (Number(expected.id) !== unrelated) {
            expected.fact = Number(expected.id) === first ? ABS_RESTORED : EXOS_RESTORED;
            expected.context = `${NOTES} | restored: redacted-facts repair`;
            // Native publication updates last-writer audit fields; original creation attribution stays intact.
            expected.last_write_request_id = request.id;
            expected.last_write_principal_kind = request.principal_kind;
            expected.last_write_principal_id = request.principal_id;
            const writtenAt = new Date(after[i]!.last_written_at as string).getTime();
            expect(writtenAt).toBeGreaterThanOrEqual(new Date(request.created_at).getTime());
            expect(writtenAt).toBeLessThanOrEqual(new Date(request.updated_at).getTime());
            expected.last_written_at = after[i]!.last_written_at;
          }
          expect(after[i]).toEqual(expected);
        }
        expect(await engine.readPageSnapshot(ACME, { sourceId: 'default' })).toEqual(holder);
        expect(await versions()).toEqual(beforeVersions);
        expect((await factText(engine, first!)).fact).toBe(ABS_RESTORED);
        expect((await factText(engine, second!)).fact).toBe(EXOS_RESTORED);
        expect((await factText(engine, unrelated!)).fact).toBe(ABS_DAMAGED);
      }, { databaseUrl });
    }, 180_000);

    test('doctor finding, preview, hash-bound apply: fenced and database-only rows restored, unprovable and conflicting rows kept', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, NOTES, `---
type: note
title: Operating models
---
${SOURCE_TEXT}
`);
        await putPage(ctx, 'notes/launches', '---\ntype: note\ntitle: Launches\n---\nThe Acme Shell (ACS) launch slipped. Later the Acme System (ACS) launch shipped.\n');
        const fence = renderFactsTable([
          { rowNum: 1, claim: ABS_DAMAGED, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true, context: NOTES },
          { rowNum: 2, claim: 'Acme Example ships quarterly', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
        ] as never);
        await putPage(ctx, ACME, `---
type: company
title: Acme Example
---
Acme Example notes.

## Facts

${fence}
`);
        const [fenced] = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE source_markdown_slug=$1 AND row_num=1 AND expired_at IS NULL", [ACME]);
        expect(fenced).toBeDefined();
        const insert = (fact: string, context: string | null) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
          Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, context)
            VALUES ('default', $1, $2, 'fact', 'private', 'mcp:put_page', $3) RETURNING id`, [ACME, fact, context]))[0].id), TEST_WRITE_ATTRIBUTION));
        const dbOnly = await insert(EXOS_DAMAGED, NOTES);
        const unproven = await insert('Some vendor [redacted](VND) rollout finished', NOTES);
        const noPage = await insert('The Retail Operating [redacted](ROS) pilot ended', 'notes/deleted-page');
        const conflicting = await insert('The Acme [redacted](ACS) launch', 'notes/launches');
        const fencedId = Number(fenced!.id);

        const finding = await factsRedactionMarkerCheck(engine);
        expect(finding.status).toBe('warn');
        expect(finding.details).toMatchObject({ affected: 5 });
        expect(finding.message).toContain('gbrain repair redacted-facts');
        const wave = (await runWaveChecks(engine, { only: 'wave' })).find(f => f.spec.id === 'facts_redaction_marker')!;
        expect(wave.state).toBe('finding');
        expect(wave.spec.count(wave.check.details!)).toBe(5);

        const preview = await repair(engine, []);
        expect(preview.results[0].residuals).toEqual({ evidenced: 2, ambiguous: 1, unproven: 2, segmented: 0 });
        const classes = Object.fromEntries(preview.results[0].listing!.map(l => [Number(l.item.split('#')[1]), l.class]));
        expect(classes).toEqual({ [fencedId]: 'evidenced', [dbOnly]: 'evidenced', [unproven]: 'unproven', [noPage]: 'unproven', [conflicting]: 'ambiguous' });
        expect(preview.results[0].listing!.find(l => l.item.endsWith(`#${fencedId}`))!.detail).toContain(ABS_RESTORED);
        expect(preview.results[0].apply_command).toMatch(/^gbrain repair redacted-facts --apply --expect [0-9a-f]+$/);
        expect((await factText(engine, dbOnly)).fact).toBe(EXOS_DAMAGED);

        expect((await refusal(() => repair(engine, ['--apply']))).code).toBe('invalid_params');
        const applied = await repair(engine, applyArgs(preview));
        expect(applied.results[0].outcomes).toEqual({ restored: 1 });

        // Database-only row: rewritten in place by one committed maintenance request.
        expect(await factText(engine, dbOnly)).toEqual({ fact: EXOS_RESTORED, active: true });
        expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE state='committed' AND intent->>'kind'='managed_maintenance_restore_redacted_facts'"))[0].n).toBe(1);
        // Fenced row: rewritten in the page; the projection now carries the restored claim at the same row.
        const page = (await engine.readPageSnapshot(ACME, { sourceId: 'default' }))!;
        expect(page.page.compiled_truth).toContain(ABS_RESTORED);
        expect(page.page.compiled_truth).not.toContain('[redacted]');
        const [projected] = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE source_markdown_slug=$1 AND row_num=1 AND expired_at IS NULL', [ACME]);
        expect(projected!.fact).toBe(ABS_RESTORED);
        // Unprovable and conflicting rows are untouched.
        expect((await factText(engine, unproven)).fact).toBe('Some vendor [redacted](VND) rollout finished');
        expect((await factText(engine, noPage)).fact).toBe('The Retail Operating [redacted](ROS) pilot ended');
        expect((await factText(engine, conflicting)).fact).toBe('The Acme [redacted](ACS) launch');

        expect((await factsRedactionMarkerCheck(engine)).details).toMatchObject({ affected: 3 });
        expect((await repair(engine, [])).results[0].residuals).toEqual({ evidenced: 0, ambiguous: 1, unproven: 2, segmented: 0 });
      }, { databaseUrl });
    }, 180_000);

    test('a fact edited after the preview reports changed_since_preview and keeps its text', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, NOTES, `---
type: note
title: Operating models
---
${SOURCE_TEXT}
`);
        const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
          Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, context)
            VALUES ('default', $1, $2, 'fact', 'private', 'mcp:put_page', $3) RETURNING id`, [ACME, EXOS_DAMAGED, NOTES]))[0].id), TEST_WRITE_ATTRIBUTION));
        const preview = await repair(engine, []);
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
          tx.executeRaw("UPDATE facts SET visibility='world' WHERE id=$1", [id]), TEST_WRITE_ATTRIBUTION));
        expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ changed_since_preview: 1 });
        expect((await factText(engine, id)).fact).toBe(EXOS_DAMAGED);
      }, { databaseUrl });
    }, 180_000);
  });

  describe(`gbrain repair redacted-facts, unmanaged (${backend})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }, 120_000);
    afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

    test('a retained page version proves the words the current page no longer holds', async () => {
      const page = await engine.putPage(NOTES, { type: 'note', title: 'Operating models', compiled_truth: 'Rewritten notes without the list.' }, { sourceId: 'default' });
      await engine.executeRaw('INSERT INTO page_versions (page_id, compiled_truth) VALUES ($1, $2)', [page.id, SOURCE_TEXT]);
      const id = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, context)
        VALUES ('default', $1, $2, 'fact', 'private', 'sync:import', $3) RETURNING id`, [ACME, ABS_DAMAGED, NOTES]))[0].id);
      const preview = await repair(engine, []);
      expect(preview.results[0].residuals).toEqual({ evidenced: 1, ambiguous: 0, unproven: 0, segmented: 0 });
      expect(preview.results[0].listing![0].detail).toContain(`${NOTES}@version:`);
      expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ restored: 1 });
      const [row] = await engine.executeRaw<{ fact: string; context: string }>('SELECT fact, context FROM facts WHERE id=$1', [id]);
      expect(row!.fact).toBe(ABS_RESTORED);
      expect(row!.context).toBe(`${NOTES} | restored: redacted-facts repair`);
      expect((await factsRedactionMarkerCheck(engine)).status).toBe('ok');
    }, 120_000);

    test('a segmented source page proves a restoration from its second segment; a proved fenced row on a segmented page is listed, never rewritten', async () => {
      const source = 'notes/segmented-models';
      const held = 'companies/segmented-example';
      await createSegmentedPage(engine, { slug: source, truth: `${'Filler line.\n'.repeat(90_000)}${SOURCE_TEXT}\n` });
      await createSegmentedPage(engine, { slug: held, truth: 'Segmented example notes.\n' });
      const insert = async (fact: string, rowNum: number | null, holder: string | null) => Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
        (source_id, entity_slug, fact, kind, visibility, source, context, row_num, source_markdown_slug)
        VALUES ('default', $1, $2, 'fact', 'private', 'sync:import', $3, $4, $5) RETURNING id`, [held, fact, source, rowNum, holder]))[0].id);
      const dbOnly = await insert(EXOS_DAMAGED, null, null);
      const fenced = await insert(ABS_DAMAGED, 1, held);
      const preview = await repair(engine, []);
      expect(preview.results[0].residuals).toEqual({ evidenced: 1, ambiguous: 0, unproven: 0, segmented: 1 });
      const listed = Object.fromEntries(preview.results[0].listing!.map(l => [Number(l.item.split('#')[1]), l]));
      expect(listed[dbOnly]!.class).toBe('evidenced');
      expect(listed[fenced]!.class).toBe('segmented');
      expect(listed[fenced]!.detail).toContain(ABS_RESTORED);
      expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ restored: 1 });
      expect((await factText(engine, dbOnly)).fact).toBe(EXOS_RESTORED);
      expect((await factText(engine, fenced)).fact).toBe(ABS_DAMAGED);
      await engine.executeRaw('DELETE FROM facts WHERE id=$1', [fenced]);
    }, 120_000);

    test('the publication rewrites a row only while it is exactly as previewed (a change after the recheck wins)', async () => {
      const id = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, context)
        VALUES ('default', $1, $2, 'fact', 'private', 'sync:import', $3) RETURNING id`, [ACME, EXOS_DAMAGED, NOTES]))[0].id);
      const approved = { id, from: EXOS_DAMAGED, to: EXOS_RESTORED, visibility: 'private', entity_slug: ACME, source_markdown_slug: null };
      await engine.executeRaw("UPDATE facts SET visibility='world' WHERE id=$1", [id]);
      expect(await engine.transaction(tx => restoreRedactedRows(tx, 'default', [approved]))).toEqual([]);
      expect((await factText(engine, id)).fact).toBe(EXOS_DAMAGED);
      const updated = await engine.transaction(tx => restoreRedactedRows(tx, 'default', [{ ...approved, visibility: 'world' }]));
      expect(updated.map(r => Number(r.id))).toEqual([id]);
      expect((await factText(engine, id)).fact).toBe(EXOS_RESTORED);
    }, 120_000);

    test('legacy extractor rows on a database-only unmanaged holder restore in place', async () => {
      const holder = 'companies/legacy-database-example';
      await engine.putPage(holder, { type: 'company', title: 'Legacy Example', compiled_truth: SOURCE_TEXT }, { sourceId: 'default' });
      const id = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
        (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
        VALUES ('default', $1, $1, 0, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [holder, ABS_DAMAGED]))[0].id);
      const before = await engine.readPageSnapshot(holder, { sourceId: 'default' });
      const preview = await repair(engine, []);
      expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ restored: 1 });
      expect(await factText(engine, id)).toEqual({ fact: ABS_RESTORED, active: true });
      expect(await engine.readPageSnapshot(holder, { sourceId: 'default' })).toEqual(before);
      expect((await engine.executeRaw<{ row_num: number; source: string; source_markdown_slug: string }>(
        'SELECT row_num,source,source_markdown_slug FROM facts WHERE id=$1', [id]))[0])
        .toEqual({ row_num: 0, source: 'cli:extract-conversation-facts', source_markdown_slug: holder });
      // Value: protects=a holder that declares its canonical file (source_path) is held when no repo is configured,
      // instead of being restored as database-only; fails_when=the source_path clause of
      // requireCanonicalTarget is dropped, so no_repo_configured reads as unavailable; why_new=the missing-canonical
      // case below sets local_path, so its target resolves; seam=none; no_claim=the other unresolved-target skip reasons
      const declared = 'companies/legacy-declared-example';
      let declaredId: number | undefined;
      try {
        await engine.putPage(declared, { type: 'company', title: 'Declared Example', compiled_truth: SOURCE_TEXT,
          source_path: `${declared}.md` }, { sourceId: 'default' });
        expect(await resolvePageWriteTarget(engine, declared, 'default')).toEqual({ ok: false, skipped: 'no_repo_configured' });
        declaredId = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
          (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
          VALUES ('default', $1, $1, 0, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [declared, ABS_DAMAGED]))[0].id);
        expect((await classifyRedactedFacts(engine, ['default'], { ids: [declaredId] }))[0])
          .toMatchObject({ class: 'held', reason: 'legacy_canonical_unproven', restored: ABS_RESTORED });
        expect((await factText(engine, declaredId)).fact).toBe(ABS_DAMAGED);
      } finally {
        if (declaredId !== undefined) await engine.executeRaw('DELETE FROM facts WHERE id=$1', [declaredId]);
        await engine.deletePage(declared, { sourceId: 'default' });
      }
    }, 120_000);

    test('canonical fence readers distinguish closed examples, genuine fences and ambiguous legacy holders', async () => {
      const examples = [
        { name: 'plain', body: SOURCE_TEXT, timeline: '', route: 'legacy_database', klass: 'evidenced' },
        { name: 'closed-code', body: `${SOURCE_TEXT}\n\n\`\`\`markdown\n${FACTS_FENCE_BEGIN}\n${FACTS_FENCE_END}\n\`\`\``, timeline: '', route: 'legacy_database', klass: 'evidenced' },
        { name: 'orphan-begin', body: `${SOURCE_TEXT}\n${FACTS_FENCE_BEGIN}`, timeline: '', route: 'fenced', klass: 'held' },
        { name: 'orphan-end', body: `${SOURCE_TEXT}\n${FACTS_FENCE_END}`, timeline: '', route: 'fenced', klass: 'held' },
        { name: 'unclosed-code', body: `${SOURCE_TEXT}\n\`\`\`markdown\n${FACTS_FENCE_BEGIN}`, timeline: '', route: 'fenced', klass: 'held' },
        { name: 'empty-fence', body: `${SOURCE_TEXT}\n${renderFactsTable([])}`, timeline: '', route: 'fenced', klass: 'evidenced' },
        { name: 'timeline-fence', body: SOURCE_TEXT, timeline: renderFactsTable([]), route: 'fenced', klass: 'evidenced' },
      ];
      for (const example of examples) {
        const holder = `companies/legacy-${example.name}`;
        await engine.putPage(holder, { type: 'company', title: 'Legacy Example', compiled_truth: example.body, timeline: example.timeline }, { sourceId: 'default' });
        const id = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
          (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
          VALUES ('default', $1, $1, 2, $2, 'fact', 'private', 'cli:extract-conversation-facts:legacy', $1) RETURNING id`, [holder, ABS_DAMAGED]))[0].id);
        const [candidate] = await classifyRedactedFacts(engine, ['default'], { ids: [id] });
        expect(candidate).toMatchObject({ id, class: example.klass, route: example.route, restored: ABS_RESTORED });
        expect((await factText(engine, id)).fact).toBe(ABS_DAMAGED);
      }
    }, 120_000);

    test('the unmanaged restore excludes the real file-first writer until its CAS commits, and holds a missing canonical file', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-legacy-repair-lock-'));
      const [sourceBefore] = await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'");
      try {
        await withEnv({ GBRAIN_HOME: home }, async () => {
          const root = join(home, 'content'); mkdirSync(root);
          await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
          const holder = 'companies/legacy-writer-interleave';
          await engine.putPage(holder, { type: 'company', title: 'Legacy Example', compiled_truth: SOURCE_TEXT }, { sourceId: 'default' });
          const snapshot = (await engine.readPageSnapshot(holder, { sourceId: 'default' }))!;
          const path = join(root, `${holder}.md`); mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
          const id = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ('default', $1, $1, 2, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [holder, ABS_DAMAGED]))[0].id);
          const plan = await redactedFactsRepair.plan(engine, await resolveRepairScope(engine), null, { apply: false });
          const item = plan.items.find(item => item.slug === holder)!;
          expect(item).toBeDefined();
          let reached!: () => void, resume!: () => void;
          const atCas = new Promise<void>(resolve => { reached = resolve; });
          const continueCas = new Promise<void>(resolve => { resume = resolve; });
          // Observe the real storage write boundary, without a production test export or timing sleep.
          const observed = new Proxy(engine, { get(target, key) {
            if (key === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(new Proxy(tx, { get(inner, member) {
              if (member === 'executeRaw') return async (sql: string, params?: unknown[]) => {
                if (/UPDATE\s+facts\b/i.test(sql)) { reached(); await continueCas; }
                return inner.executeRaw(sql, params);
              };
              const value = Reflect.get(inner, member); return typeof value === 'function' ? value.bind(inner) : value;
            } })));
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
          } });
          const ctx: OperationContext = { engine: observed, config: { engine: engine.kind, embedding_disabled: true },
            sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
          const applying = redactedFactsRepair.apply(ctx, item);
          try {
            await Promise.race([atCas, applying.then(() => { throw new Error('restore never reached its storage write'); })]);
            const competingWriter = await acquirePageLock(holder);
            try { expect(competingWriter).toBeNull(); } finally { await competingWriter?.release(); }
          } finally { resume(); await applying; }
          expect((await factText(engine, id)).fact).toBe(ABS_RESTORED);
          const written = await writeFactsToFence(engine, { sourceId: 'default', localPath: root, slug: holder, resolutionSource: 'exact_page' },
            [{ fact: 'Acme Example ships quarterly', kind: 'fact', notability: 'medium', visibility: 'private',
              source: 'test:canonical-writer', embedding: null, sessionId: null }]);
          expect(written.inserted).toBe(1);
          expect(readFileSync(path, 'utf8')).toContain(FACTS_FENCE_BEGIN);
          expect((await factText(engine, id)).fact).toBe(ABS_RESTORED);

          const failedHolder = 'companies/legacy-publication-read-error';
          await engine.putPage(failedHolder, { type: 'company', title: 'Read Error Example', compiled_truth: SOURCE_TEXT }, { sourceId: 'default' });
          const failedSnapshot = (await engine.readPageSnapshot(failedHolder, { sourceId: 'default' }))!;
          writeFileSync(join(root, `${failedHolder}.md`), serializePageToMarkdown(failedSnapshot.page, failedSnapshot.tags));
          const failedId = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ('default', $1, $1, 0, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [failedHolder, ABS_DAMAGED]))[0].id);
          const failedPlan = await redactedFactsRepair.plan(engine, await resolveRepairScope(engine), null, { apply: false });
          const unavailable = new Proxy(engine, { get(target, key) {
            if (key === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(new Proxy(tx, { get(inner, member) {
              if (member === 'readPageSnapshot') return async () => { throw Object.assign(new Error('Synthetic publication connection loss'), { code: '08006' }); };
              const value = Reflect.get(inner, member); return typeof value === 'function' ? value.bind(inner) : value;
            } })));
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
          } });
          // Publication failures retain their native error; they are not a successful changed-since-preview skip.
          await expect(redactedFactsRepair.apply({ ...ctx, engine: unavailable }, failedPlan.items.find(item => item.slug === failedHolder)!))
            .rejects.toMatchObject({ code: '08006' });
          expect((await factText(engine, failedId)).fact).toBe(ABS_DAMAGED);

          const missingHolder = 'companies/legacy-missing-canonical';
          const missingPath = join(root, `${missingHolder}.md`);
          await engine.putPage(missingHolder, { type: 'company', title: 'Missing Example', compiled_truth: SOURCE_TEXT,
            source_path: `${missingHolder}.md` }, { sourceId: 'default' });
          writeFileSync(missingPath, SOURCE_TEXT);
          renameSync(missingPath, `${missingPath}.retained`);
          const missingId = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
            (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source, context)
            VALUES ('default', $1, $1, 2, $2, 'fact', 'private', 'cli:extract-conversation-facts', $1) RETURNING id`, [missingHolder, ABS_DAMAGED]))[0].id);
          expect((await classifyRedactedFacts(engine, ['default'], { ids: [missingId] }))[0])
            .toMatchObject({ class: 'held', reason: 'legacy_canonical_unproven' });
          expect((await factText(engine, missingId)).fact).toBe(ABS_DAMAGED);
        });
      } finally {
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [sourceBefore!.local_path]);
        rmSync(home, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
