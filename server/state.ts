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
    currentTurnEvidence: null, recentEvents: [], lastJudgment: null,
  };
}

export function newEvidence(turnId: string, promptExcerpt = ''): TurnEvidence {
  return {
    turnId, promptExcerpt, failed: {}, editSinceLastPass: false, sawEdit: false,
    recoveredCheck: null, verifiedCheck: null,
  };
}

/** Folds one event into the turn's evidence. Returns a new object. */
export function updateEvidence(ev: TurnEvidence, event: PetEvent): TurnEvidence {
  const next: TurnEvidence = { ...ev, failed: { ...ev.failed } };
  if (event.kind === 'edit') {
    next.sawEdit = true;
    next.editSinceLastPass = true;
    for (const k of Object.keys(next.failed)) next.failed[k] = { editedSince: true };
  } else if (event.kind === 'command_failed' && event.check) {
    next.failed[event.check] = { editedSince: false };
  } else if (event.kind === 'command_ok' && event.check && event.checkPassed) {
    const f = next.failed[event.check];
    if (f?.editedSince) next.recoveredCheck = event.check;
    else if (next.editSinceLastPass) next.verifiedCheck ??= event.check;
    if (f) delete next.failed[event.check];
    next.editSinceLastPass = false;
  }
  return next;
}

/** Which milestones the local evidence supports. Recovery implies verified progress. */
export function eligibleMilestones(ev: TurnEvidence | null): MilestoneKind[] {
  if (!ev) return [];
  if (ev.recoveredCheck) return ['recovered_from_failure', 'verified_progress'];
  if (ev.verifiedCheck) return ['verified_progress'];
  return [];
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
 * Applies one normalized event. Binds the first session it sees, ignores other
 * sessions, drops duplicates, and tracks the current turn's evidence.
 */
export function reduceEvent(state: PetState, event: PetEvent): { state: PetState; outcome: EventOutcome } {
  if (state.seenEventIds.includes(event.id)) return { state, outcome: 'duplicate' };
  if (state.activeSessionId && state.activeSessionId !== event.sessionId) {
    return { state: { ...state, otherSessionAt: event.timestamp }, outcome: 'other_session' };
  }
  let s: PetState = {
    ...state,
    activeSessionId: state.activeSessionId ?? event.sessionId,
    seenEventIds: bounded(state.seenEventIds, event.id, MAX_IDS),
    lastEventAt: event.timestamp,
  };

  if (event.kind === 'prompt' && event.turnId) {
    s.currentTurnEvidence = newEvidence(event.turnId, event.promptExcerpt ?? '');
    s.recentEvents = [];
  }
  const ev = s.currentTurnEvidence;
  // Only events in the known current turn count as evidence.
  if (ev && event.turnId === ev.turnId && event.kind !== 'prompt') {
    s.currentTurnEvidence = updateEvidence(ev, event);
  }
  if (ev && event.turnId === ev.turnId) s.recentEvents = bounded(s.recentEvents, event, MAX_RECENT);

  const look = localBehavior(event.kind);
  if (look && event.timestamp >= s.celebrateUntil) {
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
 * turn has not been awarded before. A reply for an old turn is ignored.
 */
export function applyJudgment(state: PetState, judgment: PetJudgment, turnId: string, now: number): { state: PetState; awarded: number } {
  const ev = state.currentTurnEvidence;
  if (!ev || ev.turnId !== turnId) return { state, awarded: 0 };

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
  return { ...state, activeSessionId: null, currentTurnEvidence: null, recentEvents: [], behavior: 'idle', caption: CAPTIONS.hello };
}

/** What the browser sees: no dedup bookkeeping, no raw event outputs. */
export function publicState(state: PetState, now: number) {
  const { seenEventIds, awardedTurnIds, recentEvents, currentTurnEvidence, ...rest } = state;
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
    recent: recentEvents.slice(-5).map((e) => ({ kind: e.kind, check: e.check, checkPassed: e.checkPassed })),
  };
}
export type PublicState = ReturnType<typeof publicState>;
