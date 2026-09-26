export type EventKind = 'prompt' | 'read' | 'edit' | 'command_ok' | 'command_failed' | 'stop' | 'session_start' | 'notify';

export interface PetEvent {
  id: string;
  sessionId: string;
  /** Claude Code's prompt_id; the server fills it from the session's current turn when missing. */
  turnId: string | null;
  timestamp: number;
  kind: EventKind;
  /** Raw command text (bounded) for Bash events. */
  command?: string;
  /** Canonical check ("npm test", "npm run typecheck") when the command is a supported check. */
  check?: string;
  /** True when a successful check also printed recognizable passing output. */
  checkPassed?: boolean;
  outputExcerpt?: string;
  promptExcerpt?: string;
  /** Claude Code's Notification text, e.g. "Claude needs your permission to use Bash". */
  message?: string;
}

export type Activity = 'exploring' | 'implementing' | 'checking' | 'blocked' | 'resting';
export type MilestoneKind = 'recovered_from_failure' | 'verified_progress';
export type MilestoneChoice = MilestoneKind | 'none';

export interface PetJudgment {
  activity: Activity;
  milestone: MilestoneChoice;
  milestoneProbability: number;
  needsAttention: number;
  latencyMs?: number;
}

export interface TurnEvidence {
  turnId: string;
  promptExcerpt: string;
  /** Every event of the turn, sorted by hook time (async hooks can arrive out of order). Bounded. */
  events: PetEvent[];
  /** Bumped whenever milestone-relevant evidence changes; a Jev reply for an older version is superseded. */
  version: number;
  /** Derived by folding `events` in order: */
  failed: Record<string, { editedSince: boolean }>;
  editSinceLastPass: boolean;
  sawEdit: boolean;
  recoveredCheck: string | null;
  verifiedCheck: string | null;
  /** Ids of the events that prove the milestone (failure, edit, pass), kept for Jev even when older than the last 12. */
  trailIds: string[];
  /** Failures since the last success, per check or command: the loop detector. */
  failStreaks: Record<string, number>;
  edits: number;
}

export type Stage = 'hatchling' | 'sprout' | 'companion';
export type Behavior = 'idle' | 'focused' | 'puzzled' | 'celebrating' | 'sleeping';
export type Connection = 'live' | 'degraded' | 'waiting';

export interface MilestoneRecord {
  turnId: string;
  kind: MilestoneKind;
  xp: number;
  at: number;
  check: string;
  judgment: PetJudgment;
}

export interface PetState {
  xp: number;
  stage: Stage;
  behavior: Behavior;
  caption: string;
  /** Celebration stays on screen until this time. */
  celebrateUntil: number;
  grewAt: number;
  lastEventAt: number;
  activeSessionId: string | null;
  otherSessionAt: number;
  connection: Connection;
  milestoneHistory: MilestoneRecord[];
  awardedTurnIds: string[];
  seenEventIds: string[];
  currentTurnEvidence: TurnEvidence | null;
  /** Turns that are over; late events for them never count as evidence. Bounded. */
  pastTurnIds: string[];
  lastJudgment: (PetJudgment & { turnId: string; at: number; awarded: boolean }) | null;
}
