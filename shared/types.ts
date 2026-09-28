export type EventKind = 'prompt' | 'read' | 'edit' | 'command_ok' | 'command_failed' | 'stop' | 'session_start' | 'notify';

export interface PetEvent {
  id: string;
  sessionId: string;
  /** Claude Code's prompt_id; the server fills it from the session's current turn when missing. */
  turnId: string | null;
  timestamp: number;
  kind: EventKind;
  /** Which coding agent sent it. */
  agent?: 'claude' | 'codex' | 'gemini';
  /** Raw command text (bounded) for Bash events. */
  command?: string;
  /** Canonical check ("npm test", "npm run typecheck") when the command is a supported check. */
  check?: string;
  /** True when a successful check also printed recognizable passing output. */
  checkPassed?: boolean;
  outputExcerpt?: string;
  promptExcerpt?: string;
  /** Edit quality flags computed locally by the hook (never the code itself). */
  edit?: EditFlags;
  /** A command that bypasses checks (--no-verify and the like). */
  bypass?: boolean;
  /** Claude Code's Notification text, e.g. "Claude needs your permission to use Bash". */
  message?: string;
}

export interface EditFlags { testFile: boolean; skipAdded: boolean; assertsRemoved: number; silencerAdded: boolean }

export type Activity = 'exploring' | 'implementing' | 'checking' | 'blocked' | 'resting';
export type MilestoneKind = 'recovered_from_failure' | 'verified_progress';
export type MilestoneChoice = MilestoneKind | 'none';
/** Slop that costs XP. */
export type SlopKind = 'cheated_tests' | 'silenced_checks' | 'unverified_changes';
export type SlopChoice = SlopKind | 'none';

export interface PetJudgment {
  activity: Activity;
  milestone: MilestoneChoice;
  milestoneProbability: number;
  needsAttention: number;
  /** Jev's read on slop in this turn (absent from older proxies: treated as none). */
  slop?: SlopChoice;
  slopProbability?: number;
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
  /** Slop evidence: a check "passed" by weakening its test, silenced checks, edits never verified. */
  slop: { cheatedCheck: string | null; onlyTestsChanged: boolean; silenced: boolean; unverified: boolean; ids: string[] };
  /** Failures since the last success, per check or command: the loop detector. */
  failStreaks: Record<string, number>;
  edits: number;
}

export type Stage = 'hatchling' | 'sprout' | 'companion';
export type Behavior = 'idle' | 'focused' | 'puzzled' | 'celebrating' | 'sleeping';
export type Connection = 'live' | 'degraded' | 'waiting';

export interface MilestoneRecord {
  turnId: string;
  /** A milestone (+XP) or a slop penalty (−XP). */
  kind: MilestoneKind | SlopKind;
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
  /** After a slop penalty the pet looks upset until this time. */
  sadUntil: number;
  /** Turns already penalized (at most one penalty per turn). Bounded. */
  penalizedTurnIds: string[];
  grewAt: number;
  lastEventAt: number;
  activeSessionId: string | null;
  /** The coding agent of the followed session. */
  activeAgent?: 'claude' | 'codex' | 'gemini';
  otherSessionAt: number;
  connection: Connection;
  milestoneHistory: MilestoneRecord[];
  awardedTurnIds: string[];
  seenEventIds: string[];
  currentTurnEvidence: TurnEvidence | null;
  /** Set by a permission/input notification; cleared by the next sign of work. */
  needsYou: { since: number; message: string } | null;
  /** Last notification seen, to drop a repeated delivery of the same one. */
  lastNotify: { message: string; at: number } | null;
  /** Turns that are over; late events for them never count as evidence. Bounded. */
  pastTurnIds: string[];
  lastJudgment: (PetJudgment & { turnId: string; at: number; awarded: boolean }) | null;
  /** How the pet looks: type and color. */
  appearance: Appearance;
}

/** Pet types (each has its own frames in public/pet/<species>/) and color presets. */
export const SPECIES = ['dragon', 'cat', 'robot'] as const;
export type Species = (typeof SPECIES)[number];
export const SPECIES_LABEL: Record<Species, string> = { dragon: 'Mint dragon', cat: 'Wizard cat', robot: 'Robot' };
/** Target hue (degrees) for each color preset; "original" keeps the art as drawn; "black" darkens instead of shifting hue. */
export const COLORS = { original: null, mint: 150, sky: 205, lavender: 270, rose: 335, ember: 12, gold: 45, black: 'black' } as const;
export type ColorName = keyof typeof COLORS;
export interface Appearance { species: Species; color: ColorName }
