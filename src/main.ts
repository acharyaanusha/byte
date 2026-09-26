import './style.css';
import { CAPTIONS, publicState } from '../server/state.js';
import type { PublicState } from '../server/state.js';
import type { Behavior, MilestoneRecord, PetState, Stage } from '../shared/types.js';
import { startReplay } from './replay.js';
import { PetAnimator } from './pet.js';

const overlay = new URLSearchParams(location.search).has('overlay');
if (overlay) document.documentElement.classList.add('overlay');

const SLEEP_AFTER_MS = 90_000;
const HOLD_MS = 3000;
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
  demoBanner: $('demo-banner'), otherBanner: $('other-banner'), stageMini: $('stage-mini'), flip: $('flip'),
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
  el.replay.textContent = replaying ? 'Exit demo' : 'Replay demo';
  el.disconnect.disabled = replaying;

  if (!s) {
    el.conn.dataset.conn = 'offline';
    el.connLabel.textContent = 'Server offline';
    return;
  }

  // Connection
  const conn = offline && !replaying ? 'offline' : s.connection;
  el.conn.dataset.conn = conn;
  el.connLabel.textContent = replaying ? 'Demo' : { live: 'Jev live', degraded: 'Degraded · no XP', waiting: 'Waiting', offline: 'Server offline' }[conn];
  el.conn.title = conn === 'degraded' ? 'Jev unavailable: Byte still reacts, but awards no XP.' : '';
  el.otherBanner.hidden = replaying || !s.otherSessionAt || now - s.otherSessionAt > 15_000;

  // Stage + growth flash
  if (shownStage !== s.stage) {
    animator.setStage(s.stage);
    el.stage.textContent = el.stageMini.textContent = s.stage[0].toUpperCase() + s.stage.slice(1);
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

  // Caption
  el.caption.textContent = now < petCaptionUntil ? CAPTIONS.pet
    : shown === 'sleeping' ? 'Zzz… (no activity for a bit)'
    : s.activeSessionId || replaying ? s.caption
    : 'Start Claude Code in your repo. I’ll follow along.';

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
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    latest = await res.json();
    offline = false;
  } catch {
    offline = true;
  }
  render();
}

el.pet.addEventListener('click', () => {
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
  shownStage = null; lastGrewAt = Date.now();
  stopReplay = startReplay((s: PetState) => { latest = publicState(s, Date.now()); render(); }, exitReplay);
  render();
}
el.replay.addEventListener('click', toggleReplay);
window.byteHost?.onCommand?.((cmd) => { if (cmd === 'replay') toggleReplay(); });

function exitReplay() {
  stopReplay?.();
  stopReplay = null;
  shownStage = null; lastGrewAt = Number.MAX_SAFE_INTEGER; // no growth flash when returning to live
  latest = null;
  void poll().then(() => { lastGrewAt = latest?.grewAt ?? 0; });
}

el.disconnect.addEventListener('click', async () => {
  try { await fetch('/api/disconnect', { method: 'POST' }); } catch { /* offline: nothing to release */ }
  void poll();
});

setInterval(() => void poll(), 1000);
setInterval(render, 500);
void poll().then(() => { lastGrewAt = latest?.grewAt ?? 0; });
