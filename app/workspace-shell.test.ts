import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceShell } from './workspace-shell.ts';

test('shell confines cwd, filesystem and environment; enforces read-only and approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-shell-'));
  try {
    const workspace = join(root, 'workspace');
    const { mkdirSync } = await import('node:fs'); mkdirSync(workspace);
    writeFileSync(join(root, 'outside'), 'private'); symlinkSync(root, join(workspace, 'escape'));
    const run = (args: Record<string, unknown>, write = true, allow = true) => runWorkspaceShell({ directory: workspace, write }, args, AbortSignal.timeout(5000), async () => allow, { OPENAI_API_KEY: 'hidden-key', NODE_OPTIONS: '--bad', LANG: 'C.UTF-8' });
    await assert.rejects(run({ command: 'pwd', cwd: '..' }), /workspace/);
    await assert.rejects(run({ command: 'pwd', check: 'yes' }), /Invalid/);
    const checked = await run({ command: 'python3 -c "assert 2 + 2 == 4"', check: true });
    assert.equal(checked.check, true); assert.equal(checked.exitCode, 0);
    await assert.rejects(run({ command: 'pwd', cwd: 'escape' }), /workspace/);
    await assert.rejects(run({ command: 'touch denied' }, true, false), /denied/);
    const env = await run({ command: 'pwd; env; cat /home/user/.ssh/id_rsa; cat escape/outside; echo ok > result' });
    assert.match(env.output, /\/workspace/); assert.doesNotMatch(env.output, /hidden-key|NODE_OPTIONS|private/);
    assert.equal(readFileSync(join(workspace, 'result'), 'utf8'), 'ok\n');
    assert.notEqual((await run({ command: 'echo changed > result' }, false)).exitCode, 0);
    assert.equal(readFileSync(join(workspace, 'result'), 'utf8'), 'ok\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell caps output, times out and kills descendants after normal exit and cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-shell-life-'));
  try {
    const run = (command: string, timeoutMs = 2000, signal = AbortSignal.timeout(5000)) => runWorkspaceShell({ directory, write: true }, { command, timeoutMs }, signal, async () => true);
    assert.equal((await run('yes x')).truncated, true);
    assert.equal((await run('sleep 30', 100)).timedOut, true);
    await run('(sleep 0.5; echo escaped > orphan) >/dev/null 2>&1 & exit 0');
    const controller = new AbortController(); const pending = run('(sleep 0.5; echo escaped > aborted) & wait', 2000, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /abort/i);
    await new Promise(resolve => setTimeout(resolve, 600));
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(directory, 'orphan')), false); assert.equal(existsSync(join(directory, 'aborted')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
