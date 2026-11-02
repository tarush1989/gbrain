/**
 * Inline autopilot must stamp its registered source without turning a full
 * non-default-source cycle into the narrower source-freshness phase set.
 * Exercise the real daemon, not a test-only export of its private tick.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

test('inline daemon stamps a non-default source and retains brain-wide maintenance', async () => {
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
  try {
    await checked([process.execPath, '--no-env-file', '--config=/dev/null',
      join(import.meta.dir, '..', 'src', 'cli.ts'), 'init', '--pglite', '--no-embedding']);
    mkdirSync(repo);
    writeFileSync(join(repo, 'README.md'), '# Example notes\n');
    await checked(['git', 'init', '-q'], repo);
    await checked(['git', 'add', 'README.md'], repo);
    await checked(['git', '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed fixture'], repo);
    await checked([process.execPath, '--no-env-file', '--config=/dev/null',
      join(import.meta.dir, '..', 'src', 'cli.ts'), 'sources', 'add', 'inline-example',
      '--path', repo, '--no-harden']);

    // Purge is outside SOURCE_FRESHNESS_PHASES. Its fixture-only side effect
    // proves that merely passing sourceId cannot silently narrow this cycle.
    const staleClone = join(home, '.gbrain', 'clones', '.tmp', 'stale-example');
    mkdirSync(staleClone, { recursive: true });
    const stale = new Date(Date.now() - 100 * 3_600_000);
    utimesSync(staleClone, stale, stale);
    const daemon = cli('autopilot', '--repo', repo, '--interval', '1', '--inline', '--no-worker');
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

    const config = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
    expect(isAbsolute(config.database_path)).toBe(true);
    expect(relative(home, config.database_path).startsWith('..')).toBe(false);
    const engine = new PGLiteEngine();
    await withEnv({ HOME: home, GBRAIN_HOME: home }, async () => {
      await engine.connect({ database_path: config.database_path });
      try {
        const sources = await engine.listAllSources();
        const source = sources.find(s => s.id === 'inline-example');
        expect(source?.config?.last_source_cycle_at).toEqual(expect.any(String));
        expect(source?.config?.last_full_cycle_at).toEqual(expect.any(String));
      } finally { await engine.disconnect(); }
    });
    expect(existsSync(staleClone)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 150_000);
