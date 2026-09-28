/**
 * Managed-brain write path for bulk conversation fact extraction.
 *
 * A managed brain refuses direct `insertFacts` (managed_writer_guard), so the
 * conversation extractor publishes each page through the same coordinated
 * session the facts backstop uses (prepare → resume → publish in
 * `persistence/facts-maintenance.ts`). One admitted batch per page snapshot:
 * the batch identity is (page slug, parser version token), so a replay of an
 * already-committed page returns its receipts without provider calls, and the
 * batch's completion receipt is the page's durable outcome (the managed
 * counterpart of the legacy terminal / non-extractable audit rows).
 */
import type { BrainEngine } from '../engine.ts';
import type { ExtractedFact } from './extract.ts';
import type { FactsBackstopCtx } from './backstop.ts';
import { isAvailable } from '../ai/gateway.ts';
import { resolveDefaultVisibility } from './visibility.ts';
import {
  prepareManagedFactsSession, resumeManagedFacts, publishManagedFacts, resolveManagedFactsEmbedding,
  type ManagedFactsResult, type ManagedFactsSession,
} from '../persistence/facts-maintenance.ts';

export const CONVERSATION_MANAGED_INTENT = 'conversation_facts_page:v1';

export interface ConversationManagedPage {
  session: ManagedFactsSession;
  ctx: FactsBackstopCtx;
  /** Non-null when this exact page snapshot already has a committed batch. */
  completed: ManagedFactsResult | null;
}

/**
 * Waits between session-open attempts while the canonical writer lock is busy.
 * The session probe never waits, and the previous page's coordinated publish
 * can still hold the worktree lock when the next page opens (live 2026-09-29:
 * 5 pages failed in the same second as the prior page's publish).
 */
export const WRITER_BUSY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

const isWriterBusy = (error: unknown) => (error as { code?: string } | null)?.code === 'writer_lock_unavailable';

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function openConversationManagedPage(engine: BrainEngine, input: {
  sourceId: string; slug: string; versionToken: string; body: string; source: string; signal?: AbortSignal;
  retryDelaysMs?: readonly number[];
}): Promise<ConversationManagedPage> {
  const delays = input.retryDelaysMs ?? WRITER_BUSY_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await openOnce(engine, input);
    } catch (error) {
      // Only a busy lock is transient; the page still fails if it stays busy.
      if (!isWriterBusy(error) || attempt >= delays.length) throw error;
      await pause(delays[attempt]!, input.signal);
    }
  }
}

async function openOnce(engine: BrainEngine, input: {
  sourceId: string; slug: string; versionToken: string; body: string; source: string; signal?: AbortSignal;
}): Promise<ConversationManagedPage> {
  const ctx: FactsBackstopCtx = {
    engine, sourceId: input.sourceId, sessionId: `${input.source}:${input.slug}`,
    // facts.source is free text at the DB layer (the sweep precedent).
    source: input.source as FactsBackstopCtx['source'],
    mode: 'inline', remote: false, notabilityFilter: 'all', abortSignal: input.signal, sourceSlug: input.slug,
    requestIntent: { kind: CONVERSATION_MANAGED_INTENT, slug: input.slug, versionToken: input.versionToken },
  };
  const session = await prepareManagedFactsSession(ctx, { turnText: input.body });
  if (!session) throw new Error('conversation managed write path used on an unmanaged brain');
  const completed = await resumeManagedFacts(engine, session);
  if (!completed) {
    const embedding = await resolveManagedFactsEmbedding(engine, session.config);
    session.embedding = embedding && isAvailable('embedding', embedding.model) ? embedding : null;
  }
  return { session, ctx, completed };
}

/** Publish every fact of the page (possibly none) as one coordinated batch. */
export async function publishConversationManagedPage(
  engine: BrainEngine, page: ConversationManagedPage, facts: ExtractedFact[],
): Promise<ManagedFactsResult> {
  const visibility = await resolveDefaultVisibility(engine);
  return publishManagedFacts(engine, page.session, page.ctx, facts, visibility);
}
