import './style.css';
import { CAPTIONS, publicState } from '../server/state.js';
import type { PublicState } from '../server/state.js';
import { COLORS, SPECIES, SPECIES_LABEL } from '../shared/types.js';
import type { Appearance, Behavior, ColorName, MilestoneRecord, PetState, Species, Stage } from '../shared/types.js';
import { startReplay } from './replay.js';
import { frameUrl, PetAnimator } from './pet.js';

const overlay = new URLSearchParams(location.search).has('overlay');
if (overlay) {
  document.documentElement.classList.add('overlay');
  document.getElementById('demo-banner')!.textContent = 'Demo · simulated';
}

const SLEEP_AFTER_MS = 90_000;
const HOLD_MS = 3000;
const REACTION_MS = 2500;
const AGENT_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' } as const;
/** Overlay bubble: stays up this long after its text changes, then hides unless it needs attention. */
const BUBBLE_MS = 6000;
const THRESHOLDS: Record<Stage, [number, number | null, string | null]> = {
  hatchling: [0, 20, 'sprout'],
  sprout: [20, 50, 'companion'],
  companion: [50, null, null],
};
const MILESTONE_LABEL = { recovered_from_failure: 'Recovered from failure', verified_progress: 'Verified progress' };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  pet: $('pet'), sprite: $<HTMLImageElement>('sprite'), stage: $('stage'), conn: $('conn'), connLabel: $('conn-label'),
  caption: $('caption'), xp: $('xp'), xpNext: $('xp-next'), bar: $('bar'), barFill: $('bar-fill'),
  milestones: $('milestones'), details: $('details-body'), hearts: $('hearts'), flash: $('flash'),
  replay: $<HTMLButtonElement>('replay'), disconnect: $<HTMLButtonElement>('disconnect'),
  demoBanner: $('demo-banner'), otherBanner: $('other-banner'), stageMini: $('stage-mini'), flip: $('flip'), connMini: $('conn-mini'),
  speciesGrid: $('species-grid'), swatches: $('swatches'), stages: $('stages'), customizeBtn: $<HTMLButtonElement>('customize-btn'),
};

const pageStart = Date.now();
let latest: PublicState | null = null;
let offline = false;
let shown: Behavior = 'idle';
let shownSince = 0;
let shownStage: Stage | null = null;
let lastGrewAt = 0;
let petCaptionUntil = 0;
let stopReplay: (() => void) | null = null;
/** Bumped on every replay start/exit so a live poll already in flight can't overwrite demo state. */
let replayGen = 0;
let bubbleText = '';
let bubbleSince = 0;
let hovering = false;
document.addEventListener('mouseover', () => { hovering = true; });
document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) hovering = false; });

const animator = new PetAnimator(el.pet, el.sprite, el.flip);

function targetBehavior(s: PublicState, now: number): Behavior {
  if (now < s.celebrateUntil) return 'celebrating';
  const quietSince = Math.max(s.lastEventAt, pageStart);
  if (now - quietSince > SLEEP_AFTER_MS) return 'sleeping';
  return s.behavior === 'celebrating' ? 'idle' : s.behavior;
}

function ago(ts: number, now: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderMilestones(list: MilestoneRecord[], now: number) {
  const last = list.slice(-3).reverse();
  el.milestones.innerHTML = last.length
    ? last.map((m) => `<li><span class="pts">+${m.xp}</span><span>${MILESTONE_LABEL[m.kind]} · <code>${escape(m.check)}</code></span><span class="when">${ago(m.at, now)}</span></li>`).join('')
    : '<li class="empty">None yet. Fix a failing test to feed Byte.</li>';
}

function renderDetails(s: PublicState, now: number) {
  const j = s.lastJudgment;
  const t = s.turn;
  const rows: [string, string][] = [];
  if (j) {
    rows.push(
      ['Activity', j.activity],
      ['Milestone', `${j.milestone} (p=${j.milestoneProbability.toFixed(2)})`],
      ['Needs you', j.needsAttention.toFixed(2)],
      ['Awarded', j.awarded ? 'yes' : 'no'],
      ['Latency', j.latencyMs ? `${j.latencyMs} ms` : '—'],
      ['Decided', ago(j.at, now)],
    );
  }
  if (t) {
    rows.push(
      ['Turn evidence', [
        t.sawEdit ? 'edited' : 'no edit',
        t.failedChecks.length ? `failing: ${t.failedChecks.join(', ')}` : null,
        t.recoveredCheck ? `recovered: ${t.recoveredCheck}` : null,
        t.verifiedCheck ? `verified: ${t.verifiedCheck}` : null,
      ].filter(Boolean).join(' · ')],
      ['Recent events', s.recent.map((e) => e.check ? `${e.kind}(${e.check}${e.checkPassed ? ' ✓' : ''})` : e.kind).join(' → ') || '—'],
    );
  }
  el.details.innerHTML = rows.length
    ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escape(v)}</dd>`).join('')}</dl>
       <p class="muted">XP needs both local evidence (edit + matching passing check) and Jev agreeing with p ≥ 0.8.</p>`
    : '<p class="muted">No Jev decision yet.</p>';
}

function render() {
  const now = Date.now();
  const s = latest;
  const replaying = !!stopReplay;
  el.demoBanner.hidden = !replaying;
  el.stageMini.classList.toggle('demo', replaying);
  el.replay.textContent = replaying ? 'Exit demo' : 'Replay demo';
  el.disconnect.disabled = replaying;

  if (!s) {
    el.conn.dataset.conn = el.connMini.dataset.conn = 'offline';
    el.connLabel.textContent = el.connMini.title = 'Server offline';
    el.caption.dataset.tone = 'failing';
    el.caption.textContent = 'Byte server is offline. Start it with npm run dev.';
    el.caption.classList.add('show');
    return;
  }

  // Connection
  const conn = offline && !replaying ? 'offline' : s.connection;
  el.conn.dataset.conn = el.connMini.dataset.conn = replaying ? 'live' : conn;
  el.connLabel.textContent = el.connMini.title = replaying ? 'Demo' : { live: 'Jev live', degraded: 'Degraded · no XP', waiting: 'Waiting', offline: 'Server offline' }[conn];
  el.conn.title = conn === 'degraded' ? 'Jev unavailable: Byte still reacts, but awards no XP.' : '';
  el.otherBanner.hidden = replaying || !s.otherSessionAt || now - s.otherSessionAt > 15_000;

  // Appearance (the demo replay keeps whatever you picked)
  const look = s.appearance ?? { species: 'dragon', color: 'original' };
  animator.setAppearance(look.species, look.color);
  renderGallery(look, s.stage);

  // Stage + growth flash
  if (shownStage !== s.stage) {
    animator.setStage(s.stage);
    el.stage.textContent = s.stage[0].toUpperCase() + s.stage.slice(1);
    if (shownStage && s.grewAt > lastGrewAt) {
      el.pet.classList.remove('grow'); void el.pet.offsetWidth; el.pet.classList.add('grow');
      el.flash.classList.remove('on'); void el.flash.offsetWidth; el.flash.classList.add('on');
    }
    shownStage = s.stage;
  }
  lastGrewAt = s.grewAt;

  // Behavior with a 3 s hold (celebration always wins)
  const target = targetBehavior(s, now);
  if (target !== shown && (target === 'celebrating' || now - shownSince >= HOLD_MS)) {
    shown = target;
    shownSince = now;
    el.pet.dataset.behavior = shown;
    animator.setBehavior(shown);
  }
  animator.setAttention(s.needsYou && now >= s.celebrateUntil);

  if (offline && !replaying) {
    el.caption.dataset.tone = 'failing';
    el.caption.textContent = 'Byte server is offline. Start it with npm run dev.';
  } else {
  // Caption: a quick reaction right after something happens, otherwise how the session is going.
  const reacting = now - s.lastEventAt < REACTION_MS || now < s.celebrateUntil;
  const tone = now < petCaptionUntil || reacting ? 'reaction' : s.status.tone;
  el.caption.dataset.tone = tone;
  el.caption.textContent = now < petCaptionUntil ? CAPTIONS.pet
    : reacting ? s.caption
    : s.status.tone === 'idle' && shown === 'sleeping' ? 'Zzz… (no activity for a bit)'
    : s.activeAgent && s.status.tone !== 'idle' ? `${AGENT_NAME[s.activeAgent]} · ${s.status.text}` : s.status.text;
  }

  el.stageMini.textContent = replaying ? `Demo · ${el.stage.textContent}` : el.stage.textContent;

  // Overlay bubble: only when something changed, when it matters (needs you / stuck / offline), or on hover.
  // Ticking durations ("· 22s") don't count as a change.
  const key = (el.caption.textContent ?? '').replace(/\d+[sm]\b/g, '');
  if (key !== bubbleText) { bubbleText = key; bubbleSince = now; }
  const urgent = ['waiting', 'stuck'].includes(el.caption.dataset.tone ?? '') || (offline && !replaying);
  el.caption.classList.toggle('show', !overlay || hovering || urgent || now - bubbleSince < BUBBLE_MS);

  // XP
  const [lo, hi, nextStage] = THRESHOLDS[s.stage];
  const pct = hi === null ? 100 : ((s.xp - lo) / (hi - lo)) * 100;
  el.xp.textContent = `${s.xp} XP`;
  el.xpNext.textContent = hi === null ? 'Fully grown' : `${hi - s.xp} to ${nextStage}`;
  el.barFill.style.transform = `scaleX(${Math.min(100, pct) / 100})`;
  el.bar.setAttribute('aria-valuenow', String(Math.round(pct)));

  renderMilestones(s.milestoneHistory, now);
  renderDetails(s, now);
}

async function poll() {
  if (stopReplay) return;
  const gen = replayGen;
  let next: PublicState | null = null;
  let failed = false;
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    next = await res.json();
  } catch {
    failed = true;
  }
  // The demo started (or restarted) while this request was in flight: drop the live answer.
  if (stopReplay || gen !== replayGen) return;
  if (next) latest = next;
  offline = failed;
  render();
}

el.pet.addEventListener('click', () => {
  if (justDragged) return;
  petCaptionUntil = Date.now() + 1800;
  animator.wave();
  for (let i = 0; i < 4; i++) {
    const h = document.createElement('span');
    h.className = 'heart';
    h.textContent = '♥';
    h.style.left = `${45 + (Math.random() * 20 - 10)}%`;
    h.style.top = `${40 + Math.random() * 10}%`;
    h.style.animationDelay = `${i * 110}ms`;
    el.hearts.appendChild(h);
    setTimeout(() => h.remove(), 1400);
  }
  render();
});

function toggleReplay() {
  if (stopReplay) { exitReplay(); return; }
  replayGen++;
  shownStage = null; lastGrewAt = Date.now();
  stopReplay = startReplay((s: PetState) => { latest = publicState(s, Date.now()); render(); }, exitReplay);
  render();
}
el.replay.addEventListener('click', toggleReplay);
// Customize: type and color are saved with the pet on the server.
const STAGES: Stage[] = ['hatchling', 'sprout', 'companion'];
const STAGE_XP: Record<Stage, number> = { hatchling: 0, sprout: 20, companion: 50 };
const cap = (t: string) => t[0].toUpperCase() + t.slice(1);
/** Swatch fill: the preset's hue, or the pet's own look for "original". */
const SWATCH: Record<ColorName, string> = {
  original: 'conic-gradient(#7fd6b0 0 25%, #e8643c 0 50%, #f0a24a 0 75%, #9fb3c8 0)',
  mint: 'hsl(150 55% 55%)', sky: 'hsl(205 70% 60%)', lavender: 'hsl(270 55% 68%)',
  rose: 'hsl(335 65% 68%)', ember: 'hsl(12 75% 55%)', gold: 'hsl(45 85% 55%)', black: '#26262b',
};

function thumb(species: Species, color: ColorName, stage: Stage, alt: string): HTMLImageElement {
  const img = new Image(96, 64);
  img.alt = alt;
  img.decoding = 'async';
  img.src = `/pet/${species}/${stage}-idle.png`; // the drawn art right away; the recolored copy swaps in when ready
  void frameUrl(species, color, stage).then((u) => { img.src = u; });
  return img;
}

// Built once; renderGallery only updates what changed.
let galleryKey = '';
for (const sp of SPECIES) {
  const b = document.createElement('button');
  b.className = 'species-card';
  b.dataset.species = sp;
  b.setAttribute('role', 'radio');
  b.append(document.createElement('span'));
  const label = document.createElement('small');
  label.textContent = SPECIES_LABEL[sp];
  b.append(label);
  b.addEventListener('click', () => void saveAppearance({ species: sp }));
  el.speciesGrid.append(b);
}
for (const c of Object.keys(COLORS) as ColorName[]) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.color = c;
  b.title = cap(c);
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', cap(c));
  b.style.background = SWATCH[c];
  b.addEventListener('click', () => void saveAppearance({ color: c }));
  el.swatches.append(b);
}

/** The gallery: every pet in your color, the swatches, and your pet's three stages (locked ones dimmed). */
function renderGallery(look: Appearance, stage: Stage) {
  const key = `${look.species}|${look.color}|${stage}`;
  if (key === galleryKey) return;
  galleryKey = key;
  for (const card of el.speciesGrid.querySelectorAll<HTMLButtonElement>('.species-card')) {
    const sp = card.dataset.species as Species;
    card.setAttribute('aria-checked', String(sp === look.species));
    card.querySelector('span')!.replaceChildren(thumb(sp, look.color, stage, SPECIES_LABEL[sp]));
  }
  for (const sw of el.swatches.querySelectorAll<HTMLButtonElement>('.swatch')) sw.setAttribute('aria-checked', String(sw.dataset.color === look.color));
  const reached = STAGES.indexOf(stage);
  el.stages.replaceChildren(...STAGES.map((st, i) => {
    const fig = document.createElement('figure');
    fig.className = i <= reached ? 'stage-card' : 'stage-card locked';
    fig.append(thumb(look.species, look.color, st, `${SPECIES_LABEL[look.species]}, ${st}`));
    const cap2 = document.createElement('figcaption');
    cap2.textContent = i <= reached ? cap(st) : `${cap(st)} · ${STAGE_XP[st]} XP`;
    fig.append(cap2);
    return fig;
  }));
}
async function saveAppearance(next: Partial<Appearance>) {
  const cur = latest?.appearance ?? { species: 'dragon' as Species, color: 'original' as ColorName };
  const body = { ...cur, ...next };
  if (latest) latest = { ...latest, appearance: body };
  render();
  try { await fetch('/api/appearance', { method: 'POST', body: JSON.stringify(body) }); } catch { /* offline: kept locally until the next poll */ }
}
// Overlay: the ✎ button in the XP pill opens the full view's gallery (no right-click needed).
el.customizeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (window.byteHost?.openFullView) window.byteHost.openFullView();
  else document.getElementById('gallery')?.scrollIntoView({ behavior: 'smooth' });
});

window.byteHost?.onCommand?.((cmd) => {
  if (cmd.startsWith('species:')) void saveAppearance({ species: cmd.slice(8) as Species });
  if (cmd.startsWith('color:')) void saveAppearance({ color: cmd.slice(6) as ColorName });
  if (cmd === 'replay') toggleReplay();
  if (cmd === 'disconnect') el.disconnect.click();
});

function exitReplay() {
  stopReplay?.();
  stopReplay = null;
  replayGen++;
  shownStage = null; lastGrewAt = Number.MAX_SAFE_INTEGER; // no growth flash when returning to live
  latest = null;
  void poll().then(() => { lastGrewAt = latest?.grewAt ?? 0; });
}

el.disconnect.addEventListener('click', async () => {
  try { await fetch('/api/disconnect', { method: 'POST' }); } catch { /* offline: nothing to release */ }
  void poll();
});

// Overlay host: capture the mouse only over Byte's visible parts, and drag the window by them.
let justDragged = false;
const host = window.byteHost;
if (overlay && host?.setInteractive) {
  const handles = ['#pet', '#caption', '.xp', '#demo-banner'];
  const isHandle = (t: EventTarget | null) => t instanceof Element && handles.some((h) => t.closest(h));
  let interactive = false;
  let drag: { x: number; y: number; moved: boolean } | null = null;
  window.addEventListener('mousemove', (e) => {
    const want = !!drag || isHandle(e.target);
    if (want !== interactive) { interactive = want; host.setInteractive!(want); }
  });
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !isHandle(e.target)) return;
    drag = { x: e.screenX, y: e.screenY, moved: false };
    justDragged = false;
    animator.held = true;
    host.dragStart!();
    (e.target as Element).setPointerCapture?.(e.pointerId);
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    host.dragMove!(dx, dy);
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    justDragged = drag.moved; // a real drag should not also count as petting
    drag = null;
    animator.held = false;
    host.dragEnd!();
    setTimeout(() => { justDragged = false; }, 0);
  });
}

setInterval(() => void poll(), 1000);
setInterval(render, 500);
void poll().then(() => { lastGrewAt = latest?.grewAt ?? 0; });
