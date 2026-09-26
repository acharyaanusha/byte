// Frame-based pet animation. A small state machine picks what Pico is doing
// (standing, looking around, sitting, walking, turning, waving for you) and
// which pixel-art frame to show. Walking is a 4-frame cycle (contact, passing,
// contact, passing) while the body moves continuously at a speed matched to the
// stride, the way sprite games do it; moving in jumps on some frames reads as floating. In the
// browser Pico walks inside the habitat; in the overlay the host (Electron)
// moves the window a short way around the spot where you put it.
import { COLORS } from '../shared/types.js';
import type { Behavior, ColorName, Species, Stage } from '../shared/types.js';

type Pose = 'idle' | 'blink' | 'walk1' | 'walk2' | 'walkpass' | 'walkpass2' | 'jump' | 'puzzled' | 'sleep' | 'wave' | 'sit';
type Activity = 'stand' | 'look' | 'sit' | 'walk' | 'turn' | 'greet';

declare global {
  interface Window {
    picoHost?: {
      moveBy(dx: number): Promise<{ hitEdge: boolean }>;
      onCommand?(cb: (cmd: string) => void): void;
      setInteractive?(on: boolean): void;
      dragStart?(): void;
      dragMove?(dx: number, dy: number): void;
      dragEnd?(): void;
      openFullView?(): void;
    };
  }
}

const POSES: Pose[] = ['idle', 'blink', 'walk1', 'walk2', 'walkpass', 'walkpass2', 'jump', 'puzzled', 'sleep', 'wave', 'sit'];
/** Contact, passing, contact, passing. */
const WALK: Pose[] = ['walk1', 'walkpass', 'walk2', 'walkpass2'];
const TICK_MS = 33;
const WALK_FRAME_MS = 140;
/** Body speed: about one stride (~12 px at overlay size) per contact frame. */
const WALK_PX_PER_S = 40;
const HABITAT_RANGE = 80;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** The main body hue of each pet type: only pixels near it are recolored. */
const BODY_HUE: Record<Species, number> = { dragon: 150, fire: 10, cat: 28, robot: 168 };
/** How far from the body hue still counts as body. The robot's recolor is only its teal glow, not its grey-blue metal. */
const HUE_TOLERANCE: Record<Species, number> = { dragon: 32, fire: 32, cat: 32, robot: 18 };

const shared = new Map<string, Promise<string>>();
/**
 * A frame of any pet type at any stage in any color preset, recolored the same way the
 * animator does it (cached). Used by the full view's gallery.
 */
export function frameUrl(species: Species, color: ColorName, stage: Stage, pose = 'idle'): Promise<string> {
  const url = `/pet/${species}/${stage}-${pose}.png`;
  const target = COLORS[color];
  if (target === null) return Promise.resolve(url);
  const key = `${url}#${target}`;
  let p = shared.get(key);
  if (!p) {
    p = recolor(url, BODY_HUE[species], target, HUE_TOLERANCE[species]).catch(() => url);
    shared.set(key, p);
  }
  return p;
}

/**
 * Recolors one frame: pixels that are saturated and near the body hue move to the target
 * hue, keeping their shading. Eyes, bellies, cheeks and accents (other hues or low
 * saturation) stay as drawn. Resolves to an object URL.
 */
async function recolor(url: string, bodyHue: number, targetHue: number | 'black', tolerance: number): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if (max === 0 || delta / max < 0.22) continue; // low saturation: outlines, cream, greys
    let h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
    const dist = Math.abs(((h - bodyHue + 540) % 360) - 180);
    if (dist > tolerance) continue;
    // Black: a near-neutral charcoal that keeps the art's light and shade.
    // Otherwise: same saturation/value, hue moved by the same offset (keeps the art's hue variation).
    const black = targetHue === 'black';
    const nh = black ? 230 : (h - bodyHue + (targetHue as number) + 360) % 360;
    const s = black ? 0.12 : delta / max, v = black ? 0.12 + max * 0.33 : max;
    const k = (n: number) => (n + nh / 60) % 6;
    const f = (n: number) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
    px[i] = Math.round(f(5) * 255); px[i + 1] = Math.round(f(3) * 255); px[i + 2] = Math.round(f(1) * 255);
  }
  ctx.putImageData(d, 0, 0);
  const blob: Blob = await new Promise((res) => c.toBlob((bl) => res(bl!), 'image/png'));
  return URL.createObjectURL(blob);
}
/** prefers-reduced-motion: no walking (which moves the whole overlay window) and no looping frames. */
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const calm = () => !!reducedMotion?.matches;

export class PetAnimator {
  private stage: Stage = 'hatchling';
  private species: Species = 'dragon';
  private color: ColorName = 'original';
  private recolored = new Map<string, string>();
  private pending = new Set<string>();
  private mode: Behavior = 'idle';
  private activity: Activity = 'stand';
  private activityUntil = 0;
  private facing: -1 | 1 = -1;    // -1 = facing/heading left (how the frames are drawn)
  private walkIndex = 0;
  private nextFrameAt = 0;
  private lastMoveAt = 0;
  private carry = 0;              // sub-pixel movement not yet applied
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
    this.preload();
    root.addEventListener('mouseenter', () => { this.hovered = true; });
    root.addEventListener('mouseleave', () => { this.hovered = false; });
    setInterval(() => void this.step(), TICK_MS);
  }

  private base(stage: Stage, pose: Pose) { return `/pet/${this.species}/${stage}-${pose}.png`; }

  /** The frame to show: the drawn art, or its recolored copy once ready. */
  private src(stage: Stage, pose: Pose): string {
    const url = this.base(stage, pose);
    const target = COLORS[this.color];
    if (target === null) return url;
    const key = `${url}#${target}`;
    const ready = this.recolored.get(key);
    if (ready) return ready;
    if (!this.pending.has(key)) {
      this.pending.add(key);
      recolor(url, BODY_HUE[this.species], target, HUE_TOLERANCE[this.species])
        .then((u) => { this.recolored.set(key, u); this.render(); })
        .catch(() => {})
        .finally(() => this.pending.delete(key));
    }
    return url;
  }

  private preload() {
    for (const s of ['hatchling', 'sprout', 'companion'] as Stage[]) for (const p of POSES) {
      const u = this.src(s, p);
      if (!u.startsWith('blob:')) new Image().src = u;
    }
  }

  setStage(stage: Stage) { this.stage = stage; this.render(); }

  setAppearance(species: Species, color: ColorName) {
    if (species === this.species && color === this.color) return;
    this.species = species; this.color = color;
    this.preload();
    this.render();
  }

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
    if (walking && now >= this.nextFrameAt) {
      this.nextFrameAt = now + WALK_FRAME_MS;
      this.walkIndex = (this.walkIndex + 1) % WALK.length;
    }
    const dt = Math.min(100, now - this.lastMoveAt);
    this.lastMoveAt = now;
    if (walking && !this.moving) {
      this.carry += (WALK_PX_PER_S * dt) / 1000;
      const px = Math.floor(this.carry);
      if (px >= 1) { this.carry -= px; await this.advance(px, now); }
    }
    this.render(now);
  }

  /** Moves the body a few pixels. Turns around at the edges. */
  private async advance(px: number, now: number) {
    const host = window.picoHost;
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
    if (this.img.src !== src && !this.img.src.endsWith(src)) this.img.src = src;
    // Every frame is drawn facing left; mirror when Pico faces right.
    this.flip.style.transform = this.facing === 1 ? 'scaleX(-1)' : '';
    this.root.dataset.pose = pose;
    return pose;
  }
}
