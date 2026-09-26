import { describe, expect, it } from 'vitest';
import { applyJudgment, initialState, jevEvents, needsYou, publicState, reduceEvent, sessionStatus, stageFor, TAKEOVER_MS } from '../server/state.js';
import { buildState } from '../server/jev.js';
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

  it('events with no known turn are not evidence', () => {
    const none = { turnId: null };
    const s = run([ev('command_failed', { ...none, check: 'npm test' }), ev('edit', none), ev('command_ok', { ...none, check: 'npm test', checkPassed: true })]);
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

describe('review findings', () => {
  it('keeps milestone evidence (and shows it to Jev) beyond the last 12 events', () => {
    const start = [ev('prompt'), failTest(), ev('edit')];
    const reads = Array.from({ length: 20 }, () => ev('read'));
    const s = run([...start, ...reads, passTest()]);
    const e = s.currentTurnEvidence!;
    expect(e.recoveredCheck).toBe('npm test');
    const { trail, recent } = jevEvents(e);
    expect(recent).toHaveLength(12);
    expect(trail.map((x) => x.kind)).toEqual(['command_failed', 'edit']);
    const state = buildState(e);
    expect(state).toContain('Earlier key events');
    expect(state).toContain('command_failed');
    expect(state.length).toBeLessThanOrEqual(8000);
    expect(applyJudgment(s, yes('recovered_from_failure'), 't1', 9000, e.version).awarded).toBe(20);
  });

  it('rejects a same-turn judgment made on superseded evidence', () => {
    const before = run([ev('prompt'), failTest()]);
    const staleVersion = before.currentTurnEvidence!.version;
    const after = run([ev('edit'), passTest()], before);
    const r = applyJudgment(after, yes('recovered_from_failure'), 't1', 9000, staleVersion);
    expect(r.superseded).toBe(true);
    expect(r.awarded).toBe(0);
    expect(r.state).toBe(after);
    // The re-evaluation on current evidence awards exactly once.
    const ok = applyJudgment(after, yes('recovered_from_failure'), 't1', 9000, after.currentTurnEvidence!.version);
    expect(ok.awarded).toBe(20);
  });

  it('orders async hook deliveries by hook time, not arrival', () => {
    const p = ev('prompt', { timestamp: 1 });
    const fail = ev('command_failed', { check: 'npm test', checkPassed: false, timestamp: 2 });
    const edit = ev('edit', { timestamp: 3 });
    const pass = ev('command_ok', { check: 'npm test', checkPassed: true, timestamp: 4 });
    // Delivered as prompt, fail, pass, edit: still a recovery.
    expect(run([p, fail, pass, edit]).currentTurnEvidence!.recoveredCheck).toBe('npm test');
    // Really pass-before-edit (edit stamped later) delivered in "good" order: not a recovery.
    const lateEdit = ev('edit', { timestamp: 5 });
    const s = run([p, fail, lateEdit, { ...pass, id: 'p2' }]);
    expect(s.currentTurnEvidence!.recoveredCheck).toBeNull();
  });

  it('a tool event that beats its prompt opens the turn; the late prompt does not reset it', () => {
    const s = run([failTest(), ev('prompt', { promptExcerpt: 'fix it' }), ev('edit'), passTest()]);
    expect(s.currentTurnEvidence!.promptExcerpt).toBe('fix it');
    expect(s.currentTurnEvidence!.recoveredCheck).toBe('npm test');
  });

  it('late events for a finished turn never count as evidence', () => {
    let s = run([ev('prompt'), failTest(), ev('edit')]);
    s = run([ev('prompt', { turnId: 't2' })], s);
    s = run([passTest()], s); // t1's pass arrives after t2 began
    expect(s.currentTurnEvidence!.turnId).toBe('t2');
    expect(s.currentTurnEvidence!.recoveredCheck).toBeNull();
    expect(applyJudgment(s, yes('recovered_from_failure'), 't1', 9000).awarded).toBe(0);
  });

  it('follows the session you last prompted; a new session start waits for the bound one to go quiet', () => {
    const s = run([ev('prompt', { timestamp: 1000 }), failTest()]);
    const prompted = reduceEvent(s, ev('prompt', { sessionId: 's2', turnId: 'x', timestamp: 1100 }));
    expect(prompted.outcome).toBe('applied');
    expect(prompted.state.activeSessionId).toBe('s2');
    expect(prompted.state.currentTurnEvidence!.turnId).toBe('x');
    const start = (t: number) => ev('session_start', { sessionId: 's3', turnId: null, timestamp: t });
    expect(reduceEvent(s, start(s.lastEventAt + TAKEOVER_MS - 1)).outcome).toBe('other_session');
    expect(reduceEvent(s, start(s.lastEventAt + TAKEOVER_MS)).state.activeSessionId).toBe('s3');
    // Tool noise from another session never takes over.
    expect(reduceEvent(s, ev('read', { sessionId: 's2', timestamp: 1e9 })).outcome).toBe('other_session');
  });

  it('uses the hook-stamped time when present', () => {
    const e = normalizeHook({ ...(fixtures as Record<string, unknown>[])[1], hook_ts: 42 }, 999);
    expect(e!.timestamp).toBe(42);
  });
});

describe('session status', () => {
  const at = (s: PetState) => sessionStatus(s, s.lastEventAt + 1000);
  it('reports work in progress with counts', () => {
    const st = at(run([ev('prompt'), ev('edit'), failTest()]));
    expect(st.tone).toBe('failing');
    expect(st.text).toMatch(/Running checks · 1 edit · npm test failing/);
  });
  it('flags a loop when the same check keeps failing', () => {
    const st = at(run([ev('prompt'), failTest(), ev('edit'), failTest(), ev('edit'), failTest()]));
    expect(st.tone).toBe('stuck');
    expect(st.text).toContain('npm test” failed 3×');
  });
  it('a pass resets the loop counter', () => {
    const st = at(run([ev('prompt'), failTest(), failTest(), passTest(), failTest()]));
    expect(st.tone).not.toBe('stuck');
  });
  it('says when Claude needs you (Notification hook)', () => {
    const st = at(run([ev('prompt'), ev('notify', { message: 'Claude needs your permission to use Bash' })]));
    expect(st).toEqual({ tone: 'waiting', text: 'Needs you: Claude needs your permission to use Bash' });
  });
  it('summarizes how the turn ended', () => {
    expect(at(run([ev('prompt'), failTest(), ev('edit'), passTest(), ev('stop')])).text).toBe('Done: fixed npm test and it passes ✓');
    expect(at(run([ev('prompt'), ev('edit'), failTest(), ev('stop')]))).toEqual({ tone: 'failing', text: 'Finished, but npm test is still failing.' });
    expect(at(run([ev('prompt'), ev('read'), ev('stop')])).text).toBe('Finished. Just looked around this time.');
  });
  it('normalizes the Notification hook', () => {
    const e = normalizeHook({ session_id: 's', prompt_id: 'p', hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
    expect(e).toMatchObject({ kind: 'notify', message: 'Claude is waiting for your input' });
  });
});

describe('superseded success evidence', () => {
  const regression = () => [ev('prompt'), failTest(), ev('edit'), passTest(), ev('edit'), failTest(), ev('stop')];
  it('fail → edit → pass → edit → fail → stop: no "fixed" status and no pending award', () => {
    const s = run(regression());
    const e = s.currentTurnEvidence!;
    expect(e.recoveredCheck).toBeNull();
    expect(e.verifiedCheck).toBeNull();
    expect(sessionStatus(s, s.lastEventAt + 1000)).toEqual({ tone: 'failing', text: 'Finished, but npm test is still failing.' });
    expect(applyJudgment(s, yes('recovered_from_failure', 0.99), 't1', 9000, e.version).awarded).toBe(0);
  });
  it('a newer edit invalidates pending verification', () => {
    const s = run([ev('prompt'), ev('edit'), passTest(), ev('edit')]);
    expect(s.currentTurnEvidence!.verifiedCheck).toBeNull();
    expect(applyJudgment(s, yes('verified_progress'), 't1', 9000).awarded).toBe(0);
  });
  it('a failure of another check also blocks success', () => {
    const tc = (ok: boolean) => ev(ok ? 'command_ok' : 'command_failed', { check: 'npm run typecheck', checkPassed: ok });
    const s = run([ev('prompt'), ev('edit'), passTest(), tc(false)]);
    expect(s.currentTurnEvidence!.verifiedCheck).toBeNull();
  });
  it('a tweak after a recovery that passes again is still a recovery', () => {
    const s = run([ev('prompt'), failTest(), ev('edit'), passTest(), ev('edit'), passTest()]);
    expect(s.currentTurnEvidence!.recoveredCheck).toBe('npm test');
  });
  it('XP already awarded is kept when the turn later regresses', () => {
    let s = run([ev('prompt'), failTest(), ev('edit'), passTest()]);
    s = applyJudgment(s, yes('recovered_from_failure'), 't1', 9000).state;
    s = run([ev('edit'), failTest(), ev('stop')], s);
    expect(s.xp).toBe(20);
    expect(s.milestoneHistory).toHaveLength(1);
    expect(sessionStatus(s, s.lastEventAt + 1000).tone).toBe('failing');
    expect(applyJudgment(s, yes('recovered_from_failure'), 't1', 9500).awarded).toBe(0);
  });
});

describe('needs you', () => {
  const note = (message: string, timestamp: number, id = `n${timestamp}`) => ev('notify', { id, message, timestamp });
  it('a permission notification turns on attention; resumed work clears it; Stop does not', () => {
    let s = run([ev('prompt', { timestamp: 10 }), note('Claude needs your permission to use Bash', 20)]);
    expect(needsYou(s)).toBe(true);
    expect(publicState(s, 30).needsYou).toBe(true);
    expect(sessionStatus(s, 30).text).toBe('Needs you: Claude needs your permission to use Bash');
    expect(needsYou(run([ev('stop', { timestamp: 25 })], s))).toBe(true);
    s = run([ev('command_ok', { command: 'ls', timestamp: 40 })], s);
    expect(needsYou(s)).toBe(false);
    expect(sessionStatus(s, 50).tone).not.toBe('waiting');
  });
  it('an older Jev judgment no longer asks for you once new events arrive', () => {
    let s = run([ev('prompt', { timestamp: 10 }), failTest()]);
    s = applyJudgment(s, { activity: 'blocked', milestone: 'none', milestoneProbability: 1, needsAttention: 0.95 }, 't1', s.lastEventAt + 1).state;
    expect(needsYou(s)).toBe(true);
    s = run([ev('edit', { timestamp: s.lastEventAt + 5 })], s);
    expect(needsYou(s)).toBe(false);
  });
  it('different notifications in one turn are separate; a repeated delivery is dropped', () => {
    const raw = (message: string, hook_ts: number) => ({ session_id: 's', prompt_id: 'p', hook_event_name: 'Notification', message, hook_ts });
    const a = normalizeHook(raw('Claude needs your permission to use Bash', 1000))!;
    const b = normalizeHook(raw('Claude is waiting for your input', 5000))!;
    const aAgain = normalizeHook(raw('Claude needs your permission to use Bash', 1000))!;
    const aTwin = normalizeHook(raw('Claude needs your permission to use Bash', 1150))!; // second hook install
    const aLater = normalizeHook(raw('Claude needs your permission to use Bash', 60_000))!;
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe(aAgain.id);
    let s = run([ev('prompt', { sessionId: 's', turnId: 'p', timestamp: 500 })]);
    s = reduceEvent(s, a).state;
    expect(reduceEvent(s, aAgain).outcome).toBe('duplicate');
    expect(reduceEvent(s, aTwin).outcome).toBe('duplicate');
    s = reduceEvent(s, b).state;
    expect(reduceEvent(s, aLater).outcome).toBe('applied');
    expect(s.currentTurnEvidence!.events.filter((e) => e.kind === 'notify')).toHaveLength(2);
  });
  it('Jev sees the notification text', () => {
    const s = run([ev('prompt'), ev('notify', { message: 'Claude needs your permission to use Bash' })]);
    expect(buildState(s.currentTurnEvidence!)).toContain('message="Claude needs your permission to use Bash"');
  });
});

describe('stale turns', () => {
  it('a turn with no activity for 10 minutes is shown as resting, not in progress', () => {
    const s = run([ev('prompt', { timestamp: 1000 })]);
    expect(sessionStatus(s, 1000 + 60_000).text).toBe('Thinking about your prompt…');
    expect(sessionStatus(s, 1000 + 11 * 60_000)).toEqual({ tone: 'idle', text: 'Resting. Nothing from Claude for 11m.' });
  });
});
