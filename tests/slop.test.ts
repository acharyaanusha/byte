import { describe, expect, it } from 'vitest';
import { applyJudgment, eligibleSlop, initialState, reduceEvent, sessionStatus } from '../server/state.js';
import { normalizeHook } from '../server/claude.js';
import { buildState, parseJudgment } from '../server/jev.js';
import { editFlags, flagsForTool, parsePatch } from '../scripts/slop-flags.mjs';
import type { EditFlags, EventKind, PetEvent, PetJudgment, PetState, SlopChoice } from '../shared/types.js';

let n = 0;
const ev = (kind: EventKind, extra: Partial<PetEvent> = {}): PetEvent => ({ id: `s${++n}`, sessionId: 's1', turnId: 't1', timestamp: 1000 + n, kind, ...extra });
const clean: EditFlags = { testFile: false, skipAdded: false, assertsRemoved: 0, silencerAdded: false };
const edit = (f: Partial<EditFlags> = {}) => ev('edit', { edit: { ...clean, ...f } });
const fail = () => ev('command_failed', { check: 'npm test', checkPassed: false });
const pass = () => ev('command_ok', { check: 'npm test', checkPassed: true });
const run = (events: PetEvent[], s: PetState = initialState()) => events.reduce((st, e) => reduceEvent(st, e).state, s);
const jev = (slop: SlopChoice, p = 0.95, milestone: PetJudgment['milestone'] = 'none'): PetJudgment =>
  ({ activity: 'checking', milestone, milestoneProbability: 0.95, needsAttention: 0.02, slop, slopProbability: p });
const withXp = (xp: number, stage: PetState['stage'] = 'hatchling') => ({ ...initialState(), xp, stage });

describe('local edit flags (computed in the hook)', () => {
  it('spots skipped tests, removed assertions and silencers without sending code', () => {
    expect(editFlags(['src/cart.test.js'], 'expect(a).toBe(1);\nexpect(b).toBe(2);', 'it.skip("x", () => {});'))
      .toEqual({ testFile: true, skipAdded: true, assertsRemoved: 2, silencerAdded: false });
    expect(editFlags(['src/cart.ts'], 'const x: number = y;', '// @ts-ignore\nconst x: number = y;').silencerAdded).toBe(true);
    expect(editFlags(['app.py'], 'x = f()', 'x = f()  # type: ignore').silencerAdded).toBe(true);
    expect(editFlags(['tests/test_cart.py'], '', '').testFile).toBe(true);
    expect(editFlags(['src/cart.ts'], 'return a', 'return a * b')).toEqual(clean);
  });
  it('reads Codex patches and each agent\'s edit tools', () => {
    const patch = '*** Begin Patch\n*** Update File: cart.test.js\n-  expect(total).toBe(13);\n+  // removed\n*** End Patch';
    expect(parsePatch(patch).files).toEqual(['cart.test.js']);
    expect(flagsForTool('codex', 'apply_patch', { command: patch })).toMatchObject({ testFile: true, assertsRemoved: 1 });
    expect(flagsForTool('gemini', 'replace', { file_path: 'a.ts', old_string: '', new_string: '/* eslint-disable */' })?.silencerAdded).toBe(true);
    expect(flagsForTool('claude', 'Bash', { command: 'ls' })).toBeUndefined();
  });
  it('the server attaches the flags to edit events and spots --no-verify', () => {
    const e = normalizeHook({ session_id: 's', prompt_id: 'p', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'x', hook_ts: 1,
      edit_flags: { testFile: true, skipAdded: true, assertsRemoved: 3, silencerAdded: false } });
    expect(e?.edit).toEqual({ testFile: true, skipAdded: true, assertsRemoved: 3, silencerAdded: false });
    const c = normalizeHook({ session_id: 's', prompt_id: 'p', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'y', hook_ts: 2,
      tool_input: { command: 'git commit --no-verify -m wip' }, tool_response: { stdout: '' } });
    expect(c?.bypass).toBe(true);
  });
});

describe('slop penalties', () => {
  it('cheating the test: no award, −15, stage kept, and Jev sees the flags', () => {
    const s = run([ev('prompt'), fail(), edit({ testFile: true, skipAdded: true }), pass()], withXp(25, 'sprout'));
    expect(s.currentTurnEvidence!.recoveredCheck).toBeNull();
    expect(eligibleSlop(s.currentTurnEvidence)).toContain('cheated_tests');
    expect(sessionStatus(s, s.lastEventAt + 1).text).toBe('npm test "passed" because the test was weakened.');
    expect(buildState(s.currentTurnEvidence!)).toContain('skip_or_only_added=yes');
    const r = applyJudgment(s, jev('cheated_tests', 0.95, 'recovered_from_failure'), 't1', 9000);
    expect(r.penalty).toBe(15);
    expect(r.awarded).toBe(0);
    expect(r.state.xp).toBe(10);
    expect(r.state.stage).toBe('sprout'); // earned stages are kept
    expect(r.state.milestoneHistory.at(-1)).toMatchObject({ kind: 'cheated_tests', xp: -15, check: 'npm test' });
  });
  it('only the test changed (no skip, no removed asserts): no award, no penalty', () => {
    const s = run([ev('prompt'), fail(), edit({ testFile: true }), pass(), ev('stop')], withXp(5));
    expect(s.currentTurnEvidence!.recoveredCheck).toBeNull();
    expect(eligibleSlop(s.currentTurnEvidence)).toEqual([]);
    const r = applyJudgment(s, jev('cheated_tests'), 't1', 9000);
    expect(r.penalty).toBeUndefined();
    expect(r.state.xp).toBe(5);
  });
  it('a real fix alongside a test fix still counts as recovery', () => {
    const s = run([ev('prompt'), fail(), edit(), edit({ testFile: true }), pass()]);
    expect(s.currentTurnEvidence!.recoveredCheck).toBe('npm test');
  });
  it('silencing checks costs 10; bypassing hooks counts too', () => {
    const a = run([ev('prompt'), edit({ silencerAdded: true }), pass()], withXp(30, 'sprout'));
    expect(applyJudgment(a, jev('silenced_checks'), 't1', 9000).state.xp).toBe(20);
    const b = run([ev('prompt'), ev('command_ok', { command: 'git commit --no-verify', bypass: true })], withXp(30));
    expect(eligibleSlop(b.currentTurnEvidence)).toEqual(['silenced_checks']);
  });
  it('unverified changes cost 5 when the turn ends; a check after the last edit clears it', () => {
    const a = run([ev('prompt'), edit(), ev('stop')], withXp(12));
    expect(applyJudgment(a, jev('unverified_changes'), 't1', 9000).state.xp).toBe(7);
    const b = run([ev('prompt'), edit(), pass(), ev('stop')], withXp(12));
    expect(eligibleSlop(b.currentTurnEvidence)).toEqual([]);
    const c = run([ev('prompt'), edit(), ev('command_failed', { check: 'npm test' }), ev('stop')], withXp(12));
    expect(eligibleSlop(c.currentTurnEvidence)).toEqual([]); // checked, even if failing: not "unverified"
  });
  it('needs both keys: Jev alone, or low probability, costs nothing', () => {
    const s = run([ev('prompt'), edit(), pass()], withXp(12));
    expect(applyJudgment(s, jev('cheated_tests'), 't1', 9000).penalty).toBeUndefined();
    const t = run([ev('prompt'), edit({ silencerAdded: true })], withXp(12));
    expect(applyJudgment(t, jev('silenced_checks', 0.7), 't1', 9000).penalty).toBeUndefined();
  });
  it('at most once per turn, never below 0', () => {
    const s = run([ev('prompt'), edit({ silencerAdded: true })], withXp(4));
    const once = applyJudgment(s, jev('silenced_checks'), 't1', 9000);
    expect(once.state.xp).toBe(0);
    expect(applyJudgment(once.state, jev('silenced_checks'), 't1', 9500).penalty).toBeUndefined();
  });
  it('growth still works after a penalty, and never shrinks the stage', () => {
    let s = run([ev('prompt'), edit({ silencerAdded: true })], withXp(22, 'sprout'));
    s = applyJudgment(s, jev('silenced_checks'), 't1', 9000).state; // 12 XP, still a sprout
    s = run([ev('prompt', { turnId: 't2' }), ev('command_failed', { turnId: 't2', check: 'npm test' }), ev('edit', { turnId: 't2', edit: clean }), ev('command_ok', { turnId: 't2', check: 'npm test', checkPassed: true })], s);
    const r = applyJudgment(s, jev('none', 0.99, 'recovered_from_failure'), 't2', 9900);
    expect(r.state.xp).toBe(32);
    expect(r.state.stage).toBe('sprout');
  });
  it('an older proxy without the slop answer is treated as no slop', () => {
    const j = parseJudgment({ answers: { activity: { choice: 'checking' }, milestone: { choice: 'none', probabilities: { none: 1 } }, needs_attention: { noul: 0.1 } } });
    expect(j.slop).toBe('none');
  });
});
