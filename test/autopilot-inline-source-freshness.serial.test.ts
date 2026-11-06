/**
 * Inline autopilot must stamp its registered source without turning a full
 * non-default-source cycle into the narrower source-freshness phase set.
 * Exercise the real daemon, not a test-only export of its private tick.
 * An unmatched repo must not invent a default source or freshen another one.
 * Value: protects=source stamps follow only the registered inline repo;
 * fails_when=sourceId is omitted, full maintenance narrows, or unmatched defaults;
 * why_new=primitive tests do not invoke the daemon caller; seam=none;
 * no_claim=live providers, Postgres contention, or shutdown-during-resolution.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

test('inline daemon stamps its source, retains full maintenance, and leaves unmatched repos unstamped', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-inline-freshness-'));
  const repo = join(home, 'repo');
  // Deliberate allowlist: no operator DB URLs, provider keys or config.
  const env = { HOME: home, GBRAIN_HOME: home, PATH: process.env.PATH,
    GBRAIN_DISABLE_UPDATE_CHECK: '1', GBRAIN_MODEL_DISCOVERY: 'off' };
  const cli = (...args: string[]) => Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null',
    join(import.meta.dir, '..', 'src', 'cli.ts'), ...args],
  { cwd: home, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  async function checked(command: string[], cwd = home) {
    const p = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => p.kill('SIGKILL'), 45_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
      ]);
      expect(exit, `${command[0]} failed: ${stdout}\n${stderr}`).toBe(0);
    } finally { clearTimeout(timer); }
  }
  async function seedRepo(path: string) {
    mkdirSync(path);
    writeFileSync(join(path, 'README.md'), '# Example notes\n');
    await checked(['git', 'init', '-q'], path);
    await checked(['git', 'add', 'README.md'], path);
    await checked(['git', '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed fixture'], path);
  }
  async function oneCycle(path: string) {
    const daemon = cli('autopilot', '--repo', path, '--interval', '1', '--inline', '--no-worker');
    let stdout = '', stderr = '';
    const out = (async () => { for await (const chunk of daemon.stdout) stdout += new TextDecoder().decode(chunk); })();
    const err = (async () => { for await (const chunk of daemon.stderr) stderr += new TextDecoder().decode(chunk); })();
    try {
      await waitFor(() => {
        if (daemon.exitCode !== null) throw new Error(`Daemon exited: ${stdout}\n${stderr}`);
        return stdout.includes('[cycle-inline ');
      }, { timeoutMs: 60_000, label: 'first inline cycle completes' });
    } finally {
      daemon.kill('SIGTERM');
      const kill = setTimeout(() => daemon.kill('SIGKILL'), 10_000);
      try { await daemon.exited; await Promise.all([out, err]); } finally { clearTimeout(kill); }
    }
    expect(stdout, stderr).toMatch(/\[cycle-inline (?:ok|clean|partial)\]/);
  }
  try {
    await checked([process.execPath, '--no-env-file', '--config=/dev/null',
      join(import.meta.dir, '..', 'src', 'cli.ts'), 'init', '--pglite', '--no-embedding']);
    await seedRepo(repo);
    await checked([process.execPath, '--no-env-file', '--config=/dev/null',
      join(import.meta.dir, '..', 'src', 'cli.ts'), 'sources', 'add', 'inline-example',
      '--path', repo, '--no-harden']);

    // Purge is outside SOURCE_FRESHNESS_PHASES. Its fixture-only side effect
    // proves that merely passing sourceId cannot silently narrow this cycle.
    const staleClone = join(home, '.gbrain', 'clones', '.tmp', 'stale-example');
    mkdirSync(staleClone, { recursive: true });
    const stale = new Date(Date.now() - 100 * 3_600_000);
    utimesSync(staleClone, stale, stale);
    await oneCycle(repo);

    const config = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
    expect(isAbsolute(config.database_path)).toBe(true);
    expect(relative(home, config.database_path).startsWith('..')).toBe(false);
    async function sourceStamps() {
      const engine = new PGLiteEngine();
      return withEnv({ HOME: home, GBRAIN_HOME: home }, async () => {
        await engine.connect({ database_path: config.database_path });
        try {
          return (await engine.listAllSources()).map(source => ({
            id: source.id,
            lastSource: source.config?.last_source_cycle_at ?? null,
            lastFull: source.config?.last_full_cycle_at ?? null,
          })).sort((a, b) => a.id.localeCompare(b.id));
        } finally { await engine.disconnect(); }
      });
    }
    const completed = await sourceStamps();
    expect(completed.find(source => source.id === 'inline-example')?.lastSource).toEqual(expect.any(String));
    expect(completed.find(source => source.id === 'inline-example')?.lastFull).toEqual(expect.any(String));
    expect(existsSync(staleClone)).toBe(false);

    const unmatched = join(home, 'unregistered-repo');
    await seedRepo(unmatched);
    await oneCycle(unmatched);
    expect(await sourceStamps()).toEqual(completed);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 150_000);
