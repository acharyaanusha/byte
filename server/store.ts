import fs from 'node:fs';
import path from 'node:path';
import type { PetState } from '../shared/types.js';
import { initialState } from './state.js';

export function loadState(file: string): PetState | null {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Evidence saved by an older version has a different shape; the turn simply starts fresh.
    if (saved.currentTurnEvidence && !Array.isArray(saved.currentTurnEvidence.events)) saved.currentTurnEvidence = null;
    delete saved.recentEvents;
    return { ...initialState(), ...saved };
  } catch {
    return null;
  }
}

/** Serialized atomic JSON writes: each save writes a temp file and renames it over the target. */
export class Store {
  private chain: Promise<void> = Promise.resolve();
  private latest: PetState | null = null;
  private queued = false;

  constructor(private file: string) {}

  save(state: PetState): void {
    this.latest = state;
    if (this.queued) return; // coalesce: the queued write will pick up the newest state
    this.queued = true;
    this.chain = this.chain.then(async () => {
      this.queued = false;
      const snapshot = this.latest;
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(snapshot, null, 2));
      await fs.promises.rename(tmp, this.file);
    }).catch((err) => console.error(`[pico] save failed: ${(err as Error).message}`));
  }

  flush(): Promise<void> { return this.chain; }
}
