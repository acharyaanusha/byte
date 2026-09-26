import { describe, expect, it } from 'vitest';
import { applyJudgment, initialState, reduceEvent, stageFor } from '../server/state.js';
import { canonicalCheck, looksPassing, normalizeHook } from '../server/claude.js';
import type { EventKind, PetEvent, PetJudgment, PetState } from '../shared/types.js';
import fixtures from '../fixtures/claude-code-2.1.283-hooks.json';

let n = 0;
const ev = (kind: EventKind, extra: Partial<PetEvent> = {}): PetEvent => ({
  id: `e${++n}`, sessionId: 's1', turnId: 't1', timestamp: 1000 + n, kind, ...extra,
});
const failTest = () => ev('command_failed', { check: 'npm test', checkPassed: false });
const passTest = () => ev('command_ok', { check: 'npm test', checkPassed: true });
const yes = (milestone: PetJudgment['milestone'], p = 0.95): PetJudgment => ({
  activity: 'checking', milestone, milestoneProbability: p, needsAttention: 0.05,
});
function run(events: PetEvent[], s: PetState = initialState()) {
  for (const e of events) s = reduceEvent(s, e).state;
  return s;
}

describe('stages', () => {
  it('0/20/50 XP map to hatchling/sprout/companion', () => {
    expect(stageFor(0)).toBe('hatchling');
    expect(stageFor(19)).toBe('hatchling');
    expect(stageFor(20)).toBe('sprout');
    expect(stageFor(49)).toBe('sprout');
    expect(stageFor(50)).toBe('companion');
  });
});

describe('awards', () => {
  it('fail → edit → matching pass + Jev recovery awards 20, not 30', () => {
    const s = run([ev('prompt', { promptExcerpt: 'fix it' }), failTest(), ev('edit'), passTest()]);
    const { state, awarded } = applyJudgment(s, yes('recovered_from_failure'), 't1', 5000);
    expect(awarded).toBe(20);
    expect(state.xp).toBe(20);
    expect(state.stage).toBe('sprout');
    expect(state.milestoneHistory).toHaveLength(1);
  });

  it('a duplicate turn cannot award twice', () => {
    const s = run([ev('prompt'), failTest(), ev('edit'), passTest()]);
    const a = applyJudgment(s, yes('recovered_from_failure'), 't1', 5000).state;
    const b = applyJudgment(a, yes('recovered_from_failure'), 't1', 6000);
    expect(b.awarded).toBe(0);
    expect(b.state.xp).toBe(20);
  });

  it('a completion claim without evidence gives zero', () => {
    const s = run([ev('prompt'), ev('read'), ev('stop')]);
    expect(applyJudgment(s, yes('verified_progress', 0.99), 't1', 5000).awarded).toBe(0);
  });

  it('edit then passing check gives verified progress (10)', () => {
    const s = run([ev('prompt'), ev('edit'), passTest()]);
    expect(applyJudgment(s, yes('verified_progress'), 't1', 5000).awarded).toBe(10);
  });

  it('repeat passing checks without edits award zero', () => {
    const s = run([ev('prompt'), passTest(), passTest()]);
    expect(applyJudgment(s, yes('verified_progress'), 't1', 5000).awarded).toBe(0);
  });

  it('an unrelated passing command does not count as recovery', () => {
    const other = ev('command_ok', { check: 'npm run typecheck', checkPassed: true });
    const s = run([ev('prompt'), failTest(), ev('edit'), other]);
    expect(applyJudgment(s, yes('recovered_from_failure'), 't1', 5000).awarded).toBe(0);
  });

  it('unsupported compound commands cannot mint XP', () => {
    const s = run([ev('prompt'), failTest(), ev('edit'), ev('command_ok', { command: 'npm test && echo ok' })]);
    expect(applyJudgment(s, yes('recovered_from_failure'), 't1', 5000).awarded).toBe(0);
  });

  it('Jev below 0.8 or saying none awards nothing', () => {
    const s = run([ev('prompt'), failTest(), ev('edit'), passTest()]);
    expect(applyJudgment(s, yes('recovered_from_failure', 0.79), 't1', 5000).awarded).toBe(0);
    expect(applyJudgment(s, yes('none'), 't1', 5000).awarded).toBe(0);
  });

  it('a late reply for an old turn cannot touch the new turn', () => {
    let s = run([ev('prompt'), failTest(), ev('edit'), passTest()]);
    s = run([ev('prompt', { turnId: 't2' })], s);
    const r = applyJudgment(s, yes('recovered_from_failure'), 't1', 5000);
    expect(r.awarded).toBe(0);
    expect(r.state).toBe(s);
  });

  it('events before any known turn are not evidence', () => {
    const s = run([failTest(), ev('edit'), passTest()]);
    expect(s.currentTurnEvidence).toBeNull();
    expect(applyJudgment(s, yes('recovered_from_failure'), 't1', 5000).awarded).toBe(0);
  });
});

describe('events', () => {
  it('duplicate event ids do not repeat effects', () => {
    const s = run([ev('prompt')]);
    const e = ev('edit');
    const once = reduceEvent(s, e);
    const twice = reduceEvent(once.state, e);
    expect(twice.outcome).toBe('duplicate');
    expect(twice.state).toBe(once.state);
  });

  it('unrelated sessions do not mutate the active pet', () => {
    const s = run([ev('prompt'), ev('edit')]);
    const r = reduceEvent(s, ev('command_failed', { sessionId: 's2', check: 'npm test' }));
    expect(r.outcome).toBe('other_session');
    expect(r.state.currentTurnEvidence).toEqual(s.currentTurnEvidence);
    expect(r.state.behavior).toBe(s.behavior);
  });
});

describe('normalizeHook on real Claude Code payloads', () => {
  const events = (fixtures as unknown[]).map((f) => normalizeHook(f, 1));
  it('maps each captured hook to the right kind', () => {
    expect(events.map((e) => e?.kind)).toEqual(
      ['session_start', 'prompt', 'command_failed', 'read', 'read', 'edit', 'command_ok', 'stop']);
  });
  it('recognizes the failing and passing npm test runs', () => {
    expect(events[2]).toMatchObject({ check: 'npm test', checkPassed: false });
    expect(events[6]).toMatchObject({ check: 'npm test', checkPassed: true });
  });
  it('the captured session earns recovery evidence end to end', () => {
    const s = run(events as PetEvent[]);
    expect(s.currentTurnEvidence?.recoveredCheck).toBe('npm test');
  });
  it('canonical checks reject shell composition', () => {
    expect(canonicalCheck('npm run test')).toBe('npm test');
    expect(canonicalCheck('npm test | tail')).toBeNull();
    expect(canonicalCheck('cd x; npm test')).toBeNull();
  });
  it('a zero exit without recognizable test output is not a pass', () => {
    expect(looksPassing('npm test', 'all tests passed!')).toBe(false);
    expect(looksPassing('npm test', '# pass 2\n# fail 0')).toBe(true);
  });
});
