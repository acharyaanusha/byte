// Scripted demo: fixed events and fixed Jev decisions run through the same pure
// reducer as the live server, in a separate in-memory state. Nothing here
// touches the live pet or its XP.
import { applyJudgment, initialState, reduceEvent } from '../server/state.js';
import type { EventKind, PetEvent, PetJudgment, PetState } from '../shared/types.js';

type Step =
  | { wait: number; event: Omit<PetEvent, 'id' | 'sessionId' | 'timestamp'> }
  | { wait: number; judgment: PetJudgment; turnId: string };

const e = (kind: EventKind, turnId: string, extra: Partial<PetEvent> = {}) => ({ kind, turnId, ...extra });
const fail = (t: string) => e('command_failed', t, { command: 'npm test', check: 'npm test', checkPassed: false, outputExcerpt: '# pass 1\n# fail 1' });
const pass = (t: string) => e('command_ok', t, { command: 'npm test', check: 'npm test', checkPassed: true, outputExcerpt: '# pass 2\n# fail 0' });
const decide = (turnId: string, milestone: PetJudgment['milestone'], p: number): Step =>
  ({ wait: 1600, turnId, judgment: { activity: 'checking', milestone, milestoneProbability: p, needsAttention: 0.03, latencyMs: 0 } });

export const SCRIPT: Step[] = [
  { wait: 600, event: e('prompt', 'demo-1', { promptExcerpt: 'Fix the failing subtotal test' }) },
  { wait: 1400, event: e('read', 'demo-1') },
  { wait: 1400, event: fail('demo-1') },
  { wait: 3000, event: e('edit', 'demo-1') },
  { wait: 1800, event: pass('demo-1') },
  decide('demo-1', 'recovered_from_failure', 0.94), // +20 → sprout
  { wait: 5000, event: e('prompt', 'demo-2', { promptExcerpt: 'Add a test for applyDiscount rounding' }) },
  { wait: 1400, event: e('edit', 'demo-2') },
  { wait: 1800, event: pass('demo-2') },
  decide('demo-2', 'verified_progress', 0.9), // +10
  { wait: 5000, event: e('prompt', 'demo-3', { promptExcerpt: 'Handle an empty cart' }) },
  { wait: 1400, event: fail('demo-3') },
  { wait: 3000, event: e('edit', 'demo-3') },
  { wait: 1800, event: pass('demo-3') },
  decide('demo-3', 'recovered_from_failure', 0.91), // +20 → companion
];

/** Runs the script, calling onState after every step. Returns a stop function. */
export function startReplay(onState: (s: PetState) => void, onDone: () => void): () => void {
  let state: PetState = { ...initialState(), connection: 'live' };
  let i = 0;
  let timer: ReturnType<typeof setTimeout>;
  let n = 0;
  onState(state);
  const next = () => {
    if (i >= SCRIPT.length) { timer = setTimeout(onDone, 5000); return; }
    const step = SCRIPT[i++];
    timer = setTimeout(() => {
      const now = Date.now();
      if ('event' in step) {
        state = reduceEvent(state, { ...step.event, id: `demo-${++n}`, sessionId: 'demo', timestamp: now }).state;
      } else {
        state = applyJudgment(state, step.judgment, step.turnId, now).state;
      }
      onState(state);
      next();
    }, step.wait);
  };
  next();
  return () => clearTimeout(timer);
}
