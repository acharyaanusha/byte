/**
 * Debounced, single-flight, rate-limited runner for Jev evaluations.
 * - request() waits `debounceMs` of quiet before running.
 * - Only one run is in flight; a request during a run is kept as pending.
 * - Runs start at most once per `cooldownMs`; a request inside the cooldown is
 *   deferred, never dropped, so the final event of a turn is always evaluated.
 */
export class JudgeScheduler {
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private deferred: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private pending = false;
  private lastStart = -Infinity;

  constructor(
    private run: () => Promise<void>,
    private opts = { debounceMs: 2000, cooldownMs: 10000 },
    private now: () => number = Date.now,
  ) {}

  request(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; void this.tryRun(); }, this.opts.debounceMs);
  }

  get busy(): boolean { return this.inFlight || this.pending || !!this.debounce || !!this.deferred; }

  private async tryRun(): Promise<void> {
    if (this.inFlight) { this.pending = true; return; }
    const wait = this.lastStart + this.opts.cooldownMs - this.now();
    if (wait > 0) {
      if (!this.deferred) this.deferred = setTimeout(() => { this.deferred = null; void this.tryRun(); }, wait);
      return;
    }
    this.inFlight = true;
    this.lastStart = this.now();
    try { await this.run(); } catch { /* run() owns its error handling */ }
    this.inFlight = false;
    if (this.pending) { this.pending = false; void this.tryRun(); }
  }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.deferred) clearTimeout(this.deferred);
  }
}
