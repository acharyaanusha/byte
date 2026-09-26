// Pure pet state logic: no I/O, so the browser replay can reuse it.
import type {
  Behavior, MilestoneChoice, MilestoneKind, PetEvent, PetJudgment, PetState, Stage, TurnEvidence,
} from '../shared/types.js';

export const XP: Record<MilestoneKind, number> = { verified_progress: 10, recovered_from_failure: 20 };
export const MIN_PROBABILITY = 0.8;
export const CELEBRATE_MS = 4000;
const MAX_IDS = 300;
const MAX_RECENT = 12;
const MAX_HISTORY = 20;

export const CAPTIONS = {
  hello: 'Hi! I’m Byte.',
  prompt: 'Ooh, a new task.',
  read: 'Reading along…',
  edit: 'Watching the code change.',
  check: 'Checking, checking…',
  failed: 'That check needs another try.',
  passed: 'Looking good.',
  stop: 'Nice session. Resting now.',
  attention: 'I think you’re needed.',
  verified: 'Verified progress! +10 XP',
  recovered: 'A breakthrough! +20 XP',
  grew: 'A little more grown up.',
  pet: 'Hehe.',
} as const;

export function stageFor(xp: number): Stage {
  if (xp >= 50) return 'companion';
  if (xp >= 20) return 'sprout';
  return 'hatchling';
}

export function initialState(): PetState {
  return {
    xp: 0, stage: 'hatchling', behavior: 'idle', caption: CAPTIONS.hello,
    celebrateUntil: 0, grewAt: 0, lastEventAt: 0,
    activeSessionId: null, otherSessionAt: 0, connection: 'waiting',
    milestoneHistory: [], awardedTurnIds: [], seenEventIds: [],
    currentTurnEvidence: null, pastTurnIds: [], lastJudgment: null,
  };
}

const MAX_TURN_EVENTS = 200;
/** A new session that starts can replace a bound session idle this long. A new prompt always takes over. */
export const TAKEOVER_MS = 60_000;

export function newEvidence(turnId: string, promptExcerpt = ''): TurnEvidence {
  return {
    turnId, promptExcerpt, events: [], version: 0, failed: {}, editSinceLastPass: false, sawEdit: false,
    recoveredCheck: null, verifiedCheck: null, trailIds: [],
  };
}

/**
 * Re-derives the milestone evidence by folding the turn's events in hook-time
 * order. Folding from scratch makes late (out-of-order) deliveries land in the
 * right place instead of being judged in arrival order.
 */
export function deriveEvidence(ev: TurnEvidence): TurnEvidence {
  const failed: Record<string, { editedSince: boolean; failId: string; editId?: string }> = {};
  let editSinceLastPass = false, sawEdit = false, lastEditId = '';
  let recoveredCheck: string | null = null, verifiedCheck: string | null = null;
  let trailIds: string[] = [];
  for (const e of ev.events) {
    if (e.kind === 'edit') {
      sawEdit = true; editSinceLastPass = true; lastEditId = e.id;
      for (const f of Object.values(failed)) if (!f.editedSince) { f.editedSince = true; f.editId = e.id; }
    } else if (e.kind === 'command_failed' && e.check) {
      failed[e.check] = { editedSince: false, failId: e.id };
    } else if (e.kind === 'command_ok' && e.check && e.checkPassed) {
      const f = failed[e.check];
      if (f?.editedSince) {
        if (!recoveredCheck) trailIds = [f.failId, f.editId!, e.id];
        recoveredCheck ??= e.check;
      } else if (editSinceLastPass && !verifiedCheck) {
        verifiedCheck = e.check;
        if (!recoveredCheck) trailIds = [lastEditId, e.id];
      }
      delete failed[e.check];
      editSinceLastPass = false;
    }
  }
  const failedOut = Object.fromEntries(Object.entries(failed).map(([k, v]) => [k, { editedSince: v.editedSince }]));
  return { ...ev, failed: failedOut, editSinceLastPass, sawEdit, recoveredCheck, verifiedCheck, trailIds };
}

const RELEVANT = new Set(['edit', 'command_failed', 'command_ok']);

/** Inserts an event in hook-time order and re-derives the evidence. */
export function addToEvidence(ev: TurnEvidence, event: PetEvent): TurnEvidence {
  const events = [...ev.events];
  let i = events.length;
  while (i > 0 && events[i - 1].timestamp > event.timestamp) i--;
  events.splice(i, 0, event);
  if (events.length > MAX_TURN_EVENTS) events.splice(0, events.length - MAX_TURN_EVENTS);
  const relevant = RELEVANT.has(event.kind) && (event.kind === 'edit' || !!event.check);
  return deriveEvidence({ ...ev, events, version: ev.version + (relevant ? 1 : 0) });
}

/** Which milestones the local evidence supports. Recovery implies verified progress. */
export function eligibleMilestones(ev: TurnEvidence | null): MilestoneKind[] {
  if (!ev) return [];
  if (ev.recoveredCheck) return ['recovered_from_failure', 'verified_progress'];
  if (ev.verifiedCheck) return ['verified_progress'];
  return [];
}

/** What Jev sees: the milestone trail (even if older) plus the last 12 events. */
export function jevEvents(ev: TurnEvidence): { trail: PetEvent[]; recent: PetEvent[] } {
  const recent = ev.events.slice(-MAX_RECENT);
  const recentIds = new Set(recent.map((e) => e.id));
  const trail = ev.events.filter((e) => ev.trailIds.includes(e.id) && !recentIds.has(e.id));
  return { trail, recent };
}

function localBehavior(kind: PetEvent['kind']): [Behavior, string] | null {
  switch (kind) {
    case 'prompt': return ['focused', CAPTIONS.prompt];
    case 'read': return ['focused', CAPTIONS.read];
    case 'edit': return ['focused', CAPTIONS.edit];
    case 'command_failed': return ['puzzled', CAPTIONS.failed];
    case 'command_ok': return ['focused', CAPTIONS.check];
    case 'stop': return ['idle', CAPTIONS.stop];
    default: return null;
  }
}

function bounded<T>(list: T[], item: T, max: number): T[] {
  const next = [...list, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

export type EventOutcome = 'applied' | 'duplicate' | 'other_session';

/**
 * Applies one normalized event. Byte follows one session at a time: the one you
 * last typed a prompt into (or a newly started session once the bound one has
 * been quiet for TAKEOVER_MS). Tool events from other sessions are ignored.
 * Drops duplicates and tracks the current turn's evidence in hook-time order.
 */
export function reduceEvent(state: PetState, event: PetEvent): { state: PetState; outcome: EventOutcome } {
  if (state.seenEventIds.includes(event.id)) return { state, outcome: 'duplicate' };
  let s: PetState = state;
  if (s.activeSessionId && s.activeSessionId !== event.sessionId) {
    const takesOver = event.kind === 'prompt'
      || (event.kind === 'session_start' && event.timestamp - s.lastEventAt >= TAKEOVER_MS);
    if (!takesOver) {
      return { state: { ...s, otherSessionAt: event.timestamp }, outcome: 'other_session' };
    }
    s = { ...s, activeSessionId: event.sessionId, currentTurnEvidence: null, otherSessionAt: 0 };
  }
  const latest = event.timestamp >= s.lastEventAt;
  s = {
    ...s,
    activeSessionId: s.activeSessionId ?? event.sessionId,
    seenEventIds: bounded(s.seenEventIds, event.id, MAX_IDS),
    lastEventAt: Math.max(s.lastEventAt, event.timestamp),
  };

  const t = event.turnId;
  let ev = s.currentTurnEvidence;
  if (t && ev?.turnId !== t && !s.pastTurnIds.includes(t) && event.kind !== 'session_start') {
    // A new turn: opened by its prompt, or by a tool event that beat the prompt here.
    if (ev) s.pastTurnIds = bounded(s.pastTurnIds, ev.turnId, MAX_IDS);
    ev = newEvidence(t);
  }
  if (ev && t === ev.turnId) {
    if (event.kind === 'prompt') ev = { ...ev, promptExcerpt: event.promptExcerpt ?? '' };
    else if (event.kind !== 'session_start') ev = addToEvidence(ev, event);
  }
  s.currentTurnEvidence = ev ?? null;

  // A late delivery must not snap the pet back to an older mood.
  const look = localBehavior(event.kind);
  if (look && latest && event.timestamp >= s.celebrateUntil) {
    const [behavior, caption] = look;
    const passed = event.kind === 'command_ok' && event.checkPassed;
    s = { ...s, behavior, caption: passed ? CAPTIONS.passed : caption };
  }
  return { state: s, outcome: 'applied' };
}

const ACTIVITY_BEHAVIOR: Record<PetJudgment['activity'], Behavior> = {
  exploring: 'focused', implementing: 'focused', checking: 'focused', blocked: 'puzzled', resting: 'idle',
};

/**
 * Applies Jev's judgment for `turnId`. XP is awarded only when the local
 * evidence supports the milestone Jev picked, with probability >= 0.8, and the
 * turn has not been awarded before. A reply for an old turn, or for an older
 * version of this turn's evidence, is ignored.
 */
export function applyJudgment(
  state: PetState, judgment: PetJudgment, turnId: string, now: number, evidenceVersion?: number,
): { state: PetState; awarded: number; superseded?: boolean } {
  const ev = state.currentTurnEvidence;
  if (!ev || ev.turnId !== turnId) return { state, awarded: 0, superseded: true };
  // Jev judged an older snapshot of this turn; a queued re-evaluation will judge the current one.
  if (evidenceVersion !== undefined && evidenceVersion !== ev.version) return { state, awarded: 0, superseded: true };

  const choice: MilestoneChoice = judgment.milestone;
  const eligible =
    choice !== 'none' &&
    judgment.milestoneProbability >= MIN_PROBABILITY &&
    eligibleMilestones(ev).includes(choice) &&
    !state.awardedTurnIds.includes(turnId);

  let s: PetState = { ...state, connection: 'live', lastJudgment: { ...judgment, turnId, at: now, awarded: eligible } };

  if (!eligible) {
    if (now >= s.celebrateUntil) {
      const attention = judgment.needsAttention >= MIN_PROBABILITY;
      s.behavior = attention ? 'puzzled' : ACTIVITY_BEHAVIOR[judgment.activity];
      if (attention) s.caption = CAPTIONS.attention;
    }
    return { state: s, awarded: 0 };
  }

  const kind = choice as MilestoneKind;
  const xp = s.xp + XP[kind];
  const stage = stageFor(xp);
  const grew = stage !== s.stage;
  s = {
    ...s,
    xp, stage,
    behavior: 'celebrating',
    caption: grew ? CAPTIONS.grew : kind === 'recovered_from_failure' ? CAPTIONS.recovered : CAPTIONS.verified,
    celebrateUntil: now + CELEBRATE_MS,
    grewAt: grew ? now : s.grewAt,
    awardedTurnIds: bounded(s.awardedTurnIds, turnId, MAX_IDS),
    milestoneHistory: bounded(s.milestoneHistory, {
      turnId, kind, xp: XP[kind], at: now,
      check: (kind === 'recovered_from_failure' ? ev.recoveredCheck : ev.verifiedCheck ?? ev.recoveredCheck) ?? '',
      judgment,
    }, MAX_HISTORY),
  };
  return { state: s, awarded: XP[kind] };
}

/** Jev unavailable: keep local behavior, mark degraded, award nothing. */
export function markDegraded(state: PetState): PetState {
  return { ...state, connection: 'degraded' };
}

export function disconnect(state: PetState): PetState {
  return { ...state, activeSessionId: null, currentTurnEvidence: null, behavior: 'idle', caption: CAPTIONS.hello };
}

/** What the browser sees: no dedup bookkeeping, no raw event outputs. */
export function publicState(state: PetState, now: number) {
  const { seenEventIds, awardedTurnIds, pastTurnIds, currentTurnEvidence, ...rest } = state;
  return {
    ...rest,
    now,
    turn: currentTurnEvidence && {
      turnId: currentTurnEvidence.turnId,
      sawEdit: currentTurnEvidence.sawEdit,
      failedChecks: Object.keys(currentTurnEvidence.failed),
      recoveredCheck: currentTurnEvidence.recoveredCheck,
      verifiedCheck: currentTurnEvidence.verifiedCheck,
    },
    recent: (currentTurnEvidence?.events ?? []).slice(-5).map((e) => ({ kind: e.kind, check: e.check, checkPassed: e.checkPassed })),
  };
}
export type PublicState = ReturnType<typeof publicState>;
