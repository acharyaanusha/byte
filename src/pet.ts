// Frame-based pet animation. A small state machine picks what Byte is doing
// (standing, looking around, sitting, walking, turning, waving for you) and
// which pixel-art frame to show. Walking is a 4-frame cycle that only advances
// on the contact frames, so steps look planted instead of gliding. In the
// browser Byte walks inside the habitat; in the overlay the host (Electron)
// moves the window a short way around the spot where you put it.
import type { Behavior, Stage } from '../shared/types.js';

type Pose = 'idle' | 'blink' | 'walk1' | 'walk2' | 'walkpass' | 'jump' | 'puzzled' | 'sleep' | 'wave' | 'sit';
type Activity = 'stand' | 'look' | 'sit' | 'walk' | 'turn' | 'greet';

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

const POSES: Pose[] = ['idle', 'blink', 'walk1', 'walk2', 'walkpass', 'jump', 'puzzled', 'sleep', 'wave', 'sit'];
/** Contact, passing, contact, passing. Byte only moves on contact frames. */
const WALK: Pose[] = ['walk1', 'walkpass', 'walk2', 'walkpass'];
const TICK_MS = 60;
const WALK_FRAME_MS = 150;
const STEP_PX = 10;
const HABITAT_RANGE = 80;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** prefers-reduced-motion: no walking (which moves the whole overlay window) and no looping frames. */
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const calm = () => !!reducedMotion?.matches;

export class PetAnimator {
  private stage: Stage = 'hatchling';
  private mode: Behavior = 'idle';
  private activity: Activity = 'stand';
  private activityUntil = 0;
  private facing: -1 | 1 = -1;    // -1 = facing/heading left (how the frames are drawn)
  private walkIndex = 0;
  private nextFrameAt = 0;
  private x = 0;                  // habitat offset when not in the overlay
  private waveUntil = 0;
  private blinkUntil = 0;
  private nextBlink = Date.now() + 2500;
  private moving = false;
  private hovered = false;
  private attention = false;
  /** Set while the user drags the overlay. */
  held = false;

  constructor(private root: HTMLElement, private img: HTMLImageElement, private flip: HTMLElement) {
    for (const s of ['hatchling', 'sprout', 'companion']) for (const p of POSES) new Image().src = this.src(s as Stage, p);
    root.addEventListener('mouseenter', () => { this.hovered = true; });
    root.addEventListener('mouseleave', () => { this.hovered = false; });
    setInterval(() => void this.step(), TICK_MS);
  }

  private src(stage: Stage, pose: Pose) { return `/pet/frames/${stage}-${pose}.png`; }

  setStage(stage: Stage) { this.stage = stage; this.render(); }

  setBehavior(b: Behavior) {
    if (b === this.mode) return;
    this.mode = b;
    this.activityUntil = 0; // re-plan right away
  }

  /** Claude needs the user: stop wandering and wave until it's resolved. */
  setAttention(on: boolean) {
    if (on === this.attention) return;
    this.attention = on;
    this.activityUntil = 0;
  }

  wave() { this.waveUntil = Date.now() + 1400; }

  /** Picks the next thing to do, based on the pet's current mood. */
  private plan(now: number) {
    const pick = (a: Activity, min: number, max: number) => { this.activity = a; this.activityUntil = now + rand(min, max); };
    if (calm()) return pick(this.attention ? 'greet' : 'stand', 5000, 5000);
    if (this.attention && this.mode !== 'sleeping' && this.mode !== 'celebrating') {
      // Needs you: stop and wave, with a glance around between waves.
      return this.activity === 'greet' ? pick('look', 800, 1200) : pick('greet', 2500, 3500);
    }
    if (this.mode === 'focused') {
      const r = Math.random();
      if (r < 0.6) return pick('walk', 1800, 3500);
      if (r < 0.85) return pick('look', 1200, 2000);
      return pick('stand', 800, 1500);
    }
    if (this.mode === 'idle') {
      const r = Math.random();
      if (r < 0.3) return pick('walk', 1200, 2500);
      if (r < 0.5) return pick('look', 1500, 2500);
      if (r < 0.75) return pick('sit', 4000, 8000);
      return pick('stand', 2000, 4000);
    }
    pick('stand', 1000, 1000); // puzzled / celebrating / sleeping use fixed poses
  }

  /** Pause briefly facing the old way, then flip: reads as turning around, not bouncing. */
  private turn(now: number) {
    this.activity = 'turn';
    this.activityUntil = now + 350;
  }

  private pose(now: number): Pose {
    if (now < this.waveUntil) return 'wave';
    if (this.mode === 'sleeping') return 'sleep';
    if (this.mode === 'puzzled' && !this.attention) return 'puzzled';
    if (this.mode === 'celebrating') return calm() ? 'jump' : Math.floor(now / 300) % 2 ? 'jump' : 'idle';
    switch (this.activity) {
      case 'walk': return WALK[this.walkIndex];
      case 'sit': return 'sit';
      case 'greet': return 'wave';
      default: return now < this.blinkUntil ? 'blink' : 'idle';
    }
  }

  private async step() {
    const now = Date.now();
    if (!calm() && now >= this.nextBlink) { this.blinkUntil = now + 140; this.nextBlink = now + rand(2500, 5000); }
    if (now >= this.activityUntil) {
      if (this.activity === 'turn') this.facing = this.facing === 1 ? -1 : 1;
      this.plan(now);
      if (this.activity === 'walk' && Math.random() < 0.35) this.turn(now); // sometimes set off the other way
    }
    // Looking around: glance the other way now and then.
    if (!calm() && this.activity === 'look' && Math.random() < 0.03) this.facing = this.facing === 1 ? -1 : 1;

    const walking = !calm() && this.activity === 'walk'
      && !this.held && !this.hovered && now >= this.waveUntil
      && this.mode !== 'sleeping' && this.mode !== 'celebrating' && (this.mode !== 'puzzled' || this.attention);
    if (walking && now >= this.nextFrameAt && !this.moving) {
      this.nextFrameAt = now + WALK_FRAME_MS;
      this.walkIndex = (this.walkIndex + 1) % WALK.length;
      if (WALK[this.walkIndex] !== 'walkpass') await this.advance(STEP_PX, now);
    }
    this.render(now);
  }

  /** Moves one step on a contact frame. Turns around at the edges. */
  private async advance(px: number, now: number) {
    const host = window.byteHost;
    if (host) {
      this.moving = true;
      try {
        const { hitEdge } = await host.moveBy(this.facing * px);
        if (hitEdge) this.turn(now);
      } finally { this.moving = false; }
      return;
    }
    this.x += this.facing * px;
    if (Math.abs(this.x) >= HABITAT_RANGE) {
      this.x = Math.sign(this.x) * HABITAT_RANGE;
      this.turn(now);
    }
    this.root.style.setProperty('--walk-x', `${this.x}px`);
  }

  private render(now = Date.now()): Pose {
    const pose = this.pose(now);
    const src = this.src(this.stage, pose);
    if (!this.img.src.endsWith(src)) this.img.src = src;
    // Every frame is drawn facing left; mirror when Byte faces right.
    this.flip.style.transform = this.facing === 1 ? 'scaleX(-1)' : '';
    this.root.dataset.pose = pose;
    return pose;
  }
}
