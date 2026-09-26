import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createByte } from '../server/index.js';
import { JudgeScheduler } from '../server/scheduler.js';
import { mergeHooks } from '../scripts/install-hooks.mjs';
import { parseJudgment } from '../server/jev.js';
import type { PetJudgment } from '../shared/types.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'byte-'));
const hook = (name: string, extra: Record<string, unknown> = {}) =>
  ({ session_id: 'S', prompt_id: 'P1', hook_event_name: name, ...extra });
const bash = (id: string, ok: boolean, out: string) =>
  ok
    ? hook('PostToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'npm test' }, tool_response: { stdout: out, stderr: '', interrupted: false } })
    : hook('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'npm test' }, error: `Exit code 1\n${out}` });
const recoverySession = [
  hook('UserPromptSubmit', { prompt: 'fix the test' }),
  bash('b1', false, '# pass 1\n# fail 1'),
  hook('PostToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'cart.js' }, tool_response: {} }),
  bash('b2', true, '# pass 2\n# fail 0'),
];
const fast = { debounceMs: 10, cooldownMs: 0 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let open: { close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(open.map((b) => b.close())); open = []; });

function byte(judgeImpl: () => Promise<PetJudgment>, statePath = path.join(tmp(), 'pet.json')) {
  const b = createByte({ statePath, apiKey: 'test', judgeImpl, schedule: fast, log: () => {} });
  open.push(b);
  return b;
}

describe('server + Jev', () => {
  it('failure → edit → matching pass with a positive Jev judgment awards 20 and persists', async () => {
    const statePath = path.join(tmp(), 'pet.json');
    const b = byte(async () => ({ activity: 'checking', milestone: 'recovered_from_failure', milestoneProbability: 0.93, needsAttention: 0.02 }), statePath);
    for (const e of recoverySession) b.ingest(e);
    b.ingest(bash('b2', true, '# pass 2\n# fail 0')); // duplicate delivery
    await wait(60);
    await b.flush();
    expect(b.getState().xp).toBe(20);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).xp).toBe(20);
  });

  it('timeout or malformed answer grants no XP and marks degraded', async () => {
    const b = byte(async () => { throw new Error('timeout'); });
    for (const e of recoverySession) b.ingest(e);
    await wait(60);
    expect(b.getState().xp).toBe(0);
    expect(b.getState().connection).toBe('degraded');
    expect(() => parseJudgment({ answers: { activity: { choice: 'dancing' } } })).toThrow();
  });

  it('a reply arriving after a new prompt does not award the new turn', async () => {
    let release!: (j: PetJudgment) => void;
    const b = byte(() => new Promise((r) => { release = r; }));
    for (const e of recoverySession) b.ingest(e);
    await wait(30);
    b.ingest(hook('UserPromptSubmit', { prompt_id: 'P2', prompt: 'next' }));
    release({ activity: 'checking', milestone: 'recovered_from_failure', milestoneProbability: 0.99, needsAttention: 0 });
    await wait(20);
    expect(b.getState().xp).toBe(0);
  });
});

describe('scheduler', () => {
  it('debounces, single-flights, and still evaluates the final queued event', async () => {
    vi.useFakeTimers();
    let runs = 0;
    let finish!: () => void;
    const s = new JudgeScheduler(() => { runs++; return new Promise<void>((r) => { finish = r; }); }, { debounceMs: 2000, cooldownMs: 10000 });
    s.request(); s.request();
    await vi.advanceTimersByTimeAsync(2000);
    expect(runs).toBe(1);
    s.request(); // arrives while in flight
    await vi.advanceTimersByTimeAsync(2000);
    expect(runs).toBe(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1); // deferred by cooldown, not dropped
    await vi.advanceTimersByTimeAsync(10000);
    expect(runs).toBe(2);
    finish();
    s.stop();
    vi.useRealTimers();
  });
});

describe('hook transport', () => {
  it('exits 0 with no stdout when the server is offline', () => {
    const r = spawnSync('node', ['scripts/claude-hook.mjs'], {
      input: JSON.stringify(recoverySession[0]),
      env: { ...process.env, BYTE_URL: 'http://127.0.0.1:9/events' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('');
  });
  it('exits 0 on garbage input', () => {
    const r = spawnSync('node', ['scripts/claude-hook.mjs'], { input: 'not json' });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('');
  });
});

describe('installer', () => {
  it('preserves existing hooks and is idempotent across two runs', () => {
    const existing = {
      permissions: { allow: ['Bash(ls)'] },
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './mine.sh' }] }] },
    };
    const hookPath = '/x/byte/scripts/claude-hook.mjs';
    const once = mergeHooks(existing, { hookPath });
    const twice = mergeHooks(once, { hookPath });
    expect(twice).toEqual(once);
    expect(once.permissions).toEqual(existing.permissions);
    expect(once.hooks.PostToolUse[0].hooks[0].command).toBe('./mine.sh');
    expect(once.hooks.PostToolUse).toHaveLength(2);
    expect(Object.keys(once.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(mergeHooks(once, { hookPath, remove: true })).toEqual(existing);
  });
});
