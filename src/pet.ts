// Frame-based pet animation: picks pixel-art frames per behavior and walks Byte
// around. In the browser it walks inside the habitat; in the overlay it asks the
// host (Electron) to move the whole window across the screen.
import type { Behavior, Stage } from '../shared/types.js';

type Pose = 'idle' | 'blink' | 'walk1' | 'walk2' | 'jump' | 'puzzled' | 'sleep' | 'wave';
type Mode = Behavior | 'wave';

declare global {
  interface Window {
    byteHost?: {
      moveBy(dx: number): Promise<{ hitEdge: boolean }>;
      onCommand?(cb: (cmd: string) => void): void;
      setInteractive?(on: boolean): void;
      dragStart?(): void;
      dragMove?(dx: number, dy: number): void;
      dragEnd?(): void;
    };
  }
}

const POSES: Pose[] = ['idle', 'blink', 'walk1', 'walk2', 'jump', 'puzzled', 'sleep', 'wave'];
const STEP_PX = 6;          // distance per walk tick
const WALK_TICK_MS = 180;   // frame time per stride
const HABITAT_RANGE = 80;   // max px from center inside the browser habitat

export class PetAnimator {
  private stage: Stage = 'hatchling';
  private mode: Mode = 'idle';
  private tick = 0;
  private dir: -1 | 1 = -1;  // walk frames face left; -1 = moving left
  private x = 0;             // habitat offset when not in the overlay
  private strollUntil = 0;
  private nextStroll = Date.now() + 5000;
  private waveUntil = 0;
  private moving = false;
  private paused = false;
  /** Set while the user drags the overlay: Byte stops walking. */
  held = false;

  constructor(private root: HTMLElement, private img: HTMLImageElement, private flip: HTMLElement) {
    for (const s of ['hatchling', 'sprout', 'companion']) for (const p of POSES) new Image().src = this.src(s as Stage, p);
    setInterval(() => this.step(), WALK_TICK_MS);
    root.addEventListener('mouseenter', () => { this.paused = true; });
    root.addEventListener('mouseleave', () => { this.paused = false; });
  }

  private src(stage: Stage, pose: Pose) { return `/pet/frames/${stage}-${pose}.png`; }

  setStage(stage: Stage) { this.stage = stage; this.render(); }
  setBehavior(b: Behavior) {
    if (b === this.mode) return;
    this.mode = b;
    if (b === 'idle') this.nextStroll = Date.now() + 3000;
    this.render();
  }
  wave() { this.waveUntil = Date.now() + 1400; this.render(); }

  private pose(now: number): Pose {
    if (now < this.waveUntil) return 'wave';
    switch (this.mode) {
      case 'puzzled': return 'puzzled';
      case 'sleeping': return 'sleep';
      case 'celebrating': return this.tick % 4 < 2 ? 'jump' : 'idle';
      case 'focused':
        return this.walking(now) ? (this.tick % 2 ? 'walk1' : 'walk2') : 'idle';
      default:
        if (this.walking(now)) return this.tick % 2 ? 'walk1' : 'walk2';
        return this.tick % 22 === 0 ? 'blink' : 'idle';
    }
  }

  /** Focused: walk most of the time with short pauses. Idle: an occasional short stroll. */
  private walking(now: number): boolean {
    if (this.paused || this.held || now < this.waveUntil) return false;
    if (this.mode === 'focused') return this.tick % 30 < 22;
    if (this.mode !== 'idle') return false;
    if (now >= this.nextStroll && now > this.strollUntil) {
      this.strollUntil = now + 1400 + Math.random() * 1400;
      this.nextStroll = this.strollUntil + 6000 + Math.random() * 6000;
      if (Math.random() < 0.5) this.dir = this.dir === 1 ? -1 : 1;
    }
    return now < this.strollUntil;
  }

  private async step() {
    this.tick++;
    const now = Date.now();
    const pose = this.render(now);
    if ((pose !== 'walk1' && pose !== 'walk2') || this.moving) return;
    const dx = this.dir * STEP_PX;
    if (window.byteHost) {
      this.moving = true;
      try {
        const { hitEdge } = await window.byteHost.moveBy(dx);
        if (hitEdge) this.dir = this.dir === 1 ? -1 : 1;
      } finally { this.moving = false; }
    } else {
      this.x += dx;
      if (Math.abs(this.x) >= HABITAT_RANGE) { this.x = Math.sign(this.x) * HABITAT_RANGE; this.dir = this.dir === 1 ? -1 : 1; }
      this.root.style.setProperty('--walk-x', `${this.x}px`);
    }
  }

  private render(now = Date.now()): Pose {
    const pose = this.pose(now);
    const src = this.src(this.stage, pose);
    if (!this.img.src.endsWith(src)) this.img.src = src;
    // Walk frames face left; mirror them when heading right.
    const facingRight = (pose === 'walk1' || pose === 'walk2') && this.dir === 1;
    this.flip.style.transform = facingRight ? 'scaleX(-1)' : '';
    this.root.dataset.pose = pose;
    return pose;
  }
}
