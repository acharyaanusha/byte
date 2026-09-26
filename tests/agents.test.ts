import { describe, expect, it } from 'vitest';
import { normalizeHook } from '../server/claude.js';
import { initialState, reduceEvent, sessionStatus } from '../server/state.js';
import { AGENTS, isPicoHook, mergeHooks } from '../scripts/install-hooks.mjs';
import type { PetEvent, PetState } from '../shared/types.js';
import codexReal from '../fixtures/codex-0.155.1-hooks.json';
import codexTools from '../fixtures/codex-tool-events.json';
import gemini from '../fixtures/gemini-hook-events.json';

const tag = (agent: string, events: Record<string, unknown>[], ts0 = 1000) =>
  events.map((e, i) => ({ ...e, agent, hook_ts: (e.hook_ts as number) ?? ts0 + i * 100 }));
const fold = (raws: unknown[]) => {
  let s: PetState = initialState();
  for (const r of raws) { const e = normalizeHook(r); if (e) s = reduceEvent(s, e).state; }
  return s;
};

describe('Codex CLI adapter', () => {
  const raws = tag('codex', [...codexReal.events, ...codexTools.events] as Record<string, unknown>[]);
  const events = raws.map((r) => normalizeHook(r)) as PetEvent[];
  it('maps real Codex session/prompt payloads and source-shaped tool events', () => {
    expect(events.map((e) => e?.kind)).toEqual(['session_start', 'prompt', 'command_failed', 'edit', 'command_ok', 'stop']);
    expect(events[1].turnId).toBe((codexReal.events[1] as { turn_id: string }).turn_id);
    expect(events.every((e) => e.agent === 'codex')).toBe(true);
  });
  it('reads pass/fail from test output, since Codex reports no exit code', () => {
    expect(events[2]).toMatchObject({ check: 'npm test', checkPassed: false });
    expect(events[4]).toMatchObject({ check: 'npm test', checkPassed: true });
  });
  it('a Codex fail → patch → pass turn earns recovery evidence and ends as done', () => {
    const s = fold(raws);
    expect(s.activeAgent).toBe('codex');
    expect(s.currentTurnEvidence?.recoveredCheck).toBe('npm test');
    expect(sessionStatus(s, s.lastEventAt + 1000).text).toBe('Done: fixed npm test and it passes ✓');
  });
  it('a failed patch is not an edit; permission requests mean "needs you"', () => {
    const base = { agent: 'codex', session_id: 's', turn_id: 't', hook_ts: 1 };
    expect(normalizeHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'x', tool_response: 'Failed to apply patch: context mismatch' })).toBeNull();
    expect(normalizeHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }))
      .toMatchObject({ kind: 'notify', message: 'Codex needs your permission to run: rm -rf build' });
  });
});

describe('Gemini CLI adapter', () => {
  const raws = tag('gemini', gemini.events as Record<string, unknown>[]);
  it('maps Gemini events, reading exit codes from run_shell_command', () => {
    const events = raws.map((r) => normalizeHook(r)) as PetEvent[];
    expect(events.map((e) => e.kind)).toEqual(['session_start', 'prompt', 'command_failed', 'read', 'edit', 'command_ok', 'stop']);
    expect(events[5]).toMatchObject({ check: 'npm test', checkPassed: true });
  });
  it('starts a turn at each prompt (Gemini has no turn ids) and earns recovery', () => {
    const s = fold(raws);
    expect(s.currentTurnEvidence?.turnId).toMatch(/^gemini:gem-1:/);
    expect(s.currentTurnEvidence?.recoveredCheck).toBe('npm test');
  });
  it('two identical commands in one turn are separate events', () => {
    const run = (hook_ts: number) => normalizeHook({ ...raws[5], hook_ts })!.id;
    expect(run(2000)).not.toBe(run(3000));
  });
});

describe('installer per agent', () => {
  it('writes each agent\'s own events and handler shape, idempotently, preserving other hooks', () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: './mine.sh' }] }] } };
    for (const agent of ['claude', 'codex', 'gemini'] as const) {
      const once = mergeHooks(existing, { agent, hookPath: '/x/pico/scripts/pico-hook.mjs' });
      expect(mergeHooks(once, { agent, hookPath: '/x/pico/scripts/pico-hook.mjs' })).toEqual(once);
      for (const ev of AGENTS[agent].events) expect(once.hooks[ev]).toBeDefined();
      const handler = once.hooks[AGENTS[agent].events[1]][0].hooks[0];
      expect(handler.command).toContain(`--agent ${agent}`);
      if (agent === 'codex') expect(handler.async).toBeUndefined(); // Codex ignores async hooks
      if (agent === 'gemini') expect(handler.timeout).toBe(5000); // milliseconds
      if (agent !== 'gemini') expect(once.hooks.Stop[0].hooks[0].command).toBe('./mine.sh');
      expect(mergeHooks(once, { agent, remove: true })).toEqual(existing);
    }
  });
});

describe('rename from Byte', () => {
  it('recognizes hooks installed under the old name, so reinstalling replaces them instead of duplicating', () => {
    expect(isPicoHook({ command: 'node "/Users/x/Projects/byte/scripts/claude-hook.mjs"' })).toBe(true);
    expect(isPicoHook({ command: 'ELECTRON_RUN_AS_NODE=1 "/A/Byte.app/Contents/MacOS/Byte" "/Users/x/.byte/byte-hook.mjs" --agent codex' })).toBe(true);
    expect(isPicoHook({ command: 'node "/Users/x/.pico/pico-hook.mjs" --agent gemini' })).toBe(true);
    expect(isPicoHook({ command: './mine.sh' })).toBe(false);
    const old = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/x/byte/scripts/claude-hook.mjs"' }] }] } };
    const next = mergeHooks(old, { agent: 'claude', hookPath: '/x/pico/scripts/pico-hook.mjs' });
    expect(next.hooks.Stop).toHaveLength(1);
    expect(next.hooks.Stop[0].hooks[0].command).toContain('pico-hook.mjs');
  });
});
