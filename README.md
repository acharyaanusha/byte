<p align="center"><img src="docs/logo.png" width="128" alt="Byte logo"></p>

# Byte

**Your coding companion grows with every little breakthrough.**

<img src="public/pet/dragon/hatchling-idle.png" width="150" alt="Byte, hatchling"> <img src="public/pet/dragon/sprout-walk1.png" width="150" alt="Byte, sprout, walking"> <img src="public/pet/dragon/companion-jump.png" width="150" alt="Byte, companion, celebrating">

Byte is a small pixel-art dragon that floats in an always-on-top overlay above your terminal or coding app, or in a browser window beside it. It watches your
coding agent through its hooks (**Claude Code, Codex CLI, or Gemini CLI**) and grows when you and your agent hit real coding
milestones, such as fixing a failing test.

- **Passive.** Claude Code hooks forward small event summaries to a local server. The agent never has to call a pet tool, and the hooks never block or steer it.
- **Evidence first.** XP needs *both* local evidence (an edit, then a matching check whose output shows a pass) *and* [Jev](https://docs.typesafe.ai) agreeing, with probability ≥ 0.8. A claim like "all tests pass" earns nothing on its own.
- **Honest when offline.** If Jev is unreachable, Byte keeps reacting to your session but awards no XP, and it shows the connection as degraded.

| Milestone | XP | Evidence required in one prompt turn |
|---|---:|---|
| Verified progress | 10 | An edit, then a supported check that passes |
| Recovered from failure | 20 | A check fails, then an edit, then **the same** check passes |

Stages: hatchling (0–19 XP) → sprout (20–49) → companion (50+). A turn earns at most one milestone. You never lose XP.

## Make it yours

Pick a **pet type** (mint dragon, fire dragon, wizard cat, robot) and a **color** (original, mint, sky, lavender, rose, ember, gold). In the overlay, right-click Byte → **Pet** / **Color**; in the full view, use the selectors. Your choice is saved with your pet. Every type has the same three growth stages and the same animations. Colors recolor only the main body hue, so eyes, bellies and accents stay as drawn (for the robot, the color changes its glow).

The art for each type was generated in Byte's pixel style by `scripts/gen-species.mjs`.

## Supported agents

| Agent | Hooks Byte uses | Notes |
|---|---|---|
| Claude Code | `~/.claude/settings.json`: SessionStart, UserPromptSubmit, PostToolUse(Failure), Stop, Notification (async) | Verified with real sessions |
| Codex CLI | `~/.codex/hooks.json`: SessionStart, UserPromptSubmit, PostToolUse (Bash, apply_patch), PermissionRequest, Stop | Codex reports command output but no exit code, so pass/fail of supported checks is read from the test output. Session and prompt events verified live (0.155.1); tool events follow the Codex source |
| Gemini CLI | `~/.gemini/settings.json`: SessionStart, BeforeAgent, AfterTool, AfterAgent, Notification | Built from the official hooks reference; not yet verified with a live run. Gemini has no turn ids, so each prompt starts a turn |

Byte follows one session at a time, whichever agent you last prompted. From source: `npm run install-hooks -- --global --agent codex` (or `gemini`, `claude`).

## How it works

```
agent ──hooks──▶ scripts/byte-hook.mjs ──POST /events (300 ms, fail-open)──▶ server (127.0.0.1:4317)
                                                                                     │  reduceEvent: behavior + turn evidence
                                                                                     │  debounce 2 s, 1 in flight, ≤ 1 call / 10 s
                                                                                     ▼
                                               Jev: 3 questions in 1 batched request (activity, milestone, needs_attention)
                                                                                     │
                                          applyJudgment: award only if evidence + Jev agree, once per turn
                                                                                     ▼
browser (Vite, polls /api/state every second) ◀── .byte/pet.json (atomic writes)
```

- **Behaviors (frame-animated):** Byte walks with a 4-frame cycle (contact, passing, contact, passing). It only moves forward on the contact frames, bobbing up on the passing ones, so its steps look planted. When idle it mixes standing, blinking, looking around, sitting and short strolls. It turns around before changing direction. While your agent works (focused) it paces more. It scratches its head after a failed check, jumps when it earns XP, and curls up after 90 s with no activity. When Claude needs you, it stops and waves. Clicking Byte makes it wave. In the overlay Byte stays wherever you drop it and only wanders a short way around that spot. Growing to a new stage adds a flash and a scale pop.
- **Session status:** the speech bubble says how the followed session is going, using fixed templates. It shows what Claude is doing, with edit counts, failing checks and elapsed time. It warns *Looping?* when the same check or command fails 3× in a row, and says *Needs you* when Claude Code's Notification hook fires (a permission prompt or waiting for input) or Jev thinks you're needed. When the turn ends, it says whether it finished fixed, verified, or still failing. A small colored dot shows the tone at a glance. Reactions such as "That check needs another try." flash for a moment in between.
- **Turns:** each event's Claude Code `prompt_id` is its turn ID. A Jev reply for an older turn is ignored, so it can't award XP to a newer one.
- **Superseded replies:** each turn's evidence has a version. If new evidence lands while Jev is thinking, that reply is dropped and the current evidence is judged next.
- **Out-of-order hooks:** async hooks can arrive out of order, so the hook stamps each event when Claude Code runs it. The server re-derives the turn's evidence in that order. A tool event that beats its prompt still opens the turn.
- **Long turns:** evidence covers the whole turn (up to 200 events). Jev also sees the failure → edit → pass trail when it's older than the last 12 events.
- **Supported checks:** `npm test`, `npm run test`, `npm run typecheck`. A passing run must also show recognizable output (node:test, vitest or jest summaries; no `error TS` for typecheck). Compound shell commands (`&&`, `|`, `;` …) can change Byte's mood but can't earn XP.
- **What Jev sees:** the prompt excerpt (≤ 500 chars) and the turn's last 12 events, with command output tails of ≤ 500 chars each and ≤ 8,000 chars in total. File contents, environment and anything that looks like a key are left out. The prompt tells Jev to treat all of it as evidence, not instructions.

## Install (macOS, Apple Silicon)

1. Download **Byte-0.3.0-arm64.dmg** from the [latest release](https://github.com/acharyaanusha/byte/releases/latest) and drag Byte to Applications.
2. The app isn't notarized yet. On first launch, right-click Byte → **Open** → **Open**. Or run `xattr -dr com.apple.quarantine /Applications/Byte.app`.
3. Byte finds the coding agents on your Mac (Claude Code, Codex, Gemini CLI) and asks to **connect** to them. It adds small hooks to each agent's settings and keeps a backup. Start a new session and Byte follows it. Codex asks you to trust new hooks the first time; approve Byte's.
That's it: **no API key needed.** Byte asks Jev through a shared service. If you have your own [TypeSafe](https://docs.typesafe.ai) key, right-click Byte → **Use my own Jev API key…** to call Jev directly instead.

Byte runs locally: the app hosts Byte's server on `127.0.0.1:4317` and keeps your pet in `~/.byte/pet.json` (and your own key, if you add one, in `~/.byte/config.json`, readable only by you). The hooks run with the app's own runtime, so you don't need Node. To connect or disconnect an agent later, right-click Byte.

### The shared Jev service

Without your own key, Byte sends each judgment request to `https://byte-jev.vercel.app/api/judge` (`proxy/handler.ts`, `api/judge.ts`). The request is the same bounded summary described above: a prompt excerpt, command names, and output tails, at most 8 KB, with file contents and anything that looks like a secret left out. The service adds Byte's three fixed questions, asks Jev, and returns the typed answer. Nothing is stored. It only answers those three questions, and it's rate-limited per address (12 a minute; Byte itself asks at most once every 10 seconds). Set `BYTE_JEV_PROXY=off` to turn it off, or point it at your own deployment of this repo (set `TYPESAFE_API_KEY` in Vercel).

## Develop from source

Requires Node 22+ and Claude Code. `npm run app` runs the full app locally; `npm run app:dist` builds the `.dmg`.

```bash
npm install
cp .env.example .env          # then set TYPESAFE_API_KEY (server-side only)
npm run dev                   # server on 127.0.0.1:4317, UI on http://127.0.0.1:5173
```

Then either:

- **Overlay (recommended):** `npm run overlay` opens a transparent, frameless, always-on-top Byte that floats above every app, including full-screen terminals, and follows you across Spaces. Drag it by the speech bubble or the XP bar. Right-click it to open the full view, replay the demo, or quit.
- **Browser:** open http://127.0.0.1:5173 in a narrow window (about 360 × 480) for the full view with milestones and Jev details.

### Install the hooks

**Every Claude Code session (recommended):**

```bash
npm run install-hooks -- --global      # merges Byte's hooks into ~/.claude/settings.json
```

**Or just one repo:**

```bash
npm run install-hooks -- /path/to/your/repo
```

The installer prints the target path, backs up the file, and merges only Byte's entries. Your existing settings and hooks stay as they are, and running it
again changes nothing. The repo mode never touches global settings. If the file isn't valid JSON, the installer leaves it alone and reports the error.
Restart Claude Code afterwards (running sessions may also pick the hooks up live).

**Remove:** `npm run install-hooks -- --global --remove` or `npm run install-hooks -- /path/to/your/repo --remove` (or restore the `.byte-backup-*` file).

The hooks are `async` command hooks for SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop and Notification.
The tool hooks only match Read, Grep, Glob, Edit, Write and Bash. The hook script always exits 0 and writes nothing to stdout, even when the Byte server isn't running.

### Sessions

Byte follows one Claude Code session at a time: **the one you last typed a prompt into**. Tool events from other sessions are ignored, and a banner says another session is active. A newly started session takes over once the current one has been quiet for a minute.
**Disconnect** releases the session. Progress lives in `.byte/pet.json` and survives restarts and page reloads.

## Demo (60 seconds)

1. "Byte grows with coding breakthroughs." Show the hatchling beside Claude Code in [`byte-demo`](https://github.com/acharyaanusha/byte-demo), where `npm test` fails on purpose.
2. Ask Claude: *"Run npm test, fix the failing test in cart.js, then run npm test again."*
3. Byte focuses while Claude reads, tilts in confusion when the test fails, focuses again during the edit, then celebrates the recovery (+20 XP) and grows wings.
4. Open **Jev details** to show the evidence and Jev's batched decision.
5. Click **Replay demo** to run the whole path to companion with simulated events and decisions (clearly labeled, and it never touches live XP).

To reset the pet: stop the server and delete `.byte/pet.json`. To reset the demo repo: `git checkout cart.js`.

## Development

```bash
npm test          # vitest: reducer, awards, scheduler, hook transport, installer
npm run build     # typecheck + production bundle (contains no API key)
node scripts/gen-frames.mjs <reference.png>   # regenerate art via OpenRouter (needs OPENROUTER_API_KEY)
```

`fixtures/claude-code-2.1.283-hooks.json` holds real hook payloads captured from Claude Code 2.1.283 (with paths and file contents stripped). The tests run the normalizer against them.

The art is 30 pixel-art frames (3 stages × idle, blink, 3 walk-cycle frames, jump, puzzled, sleep, wave, sit), generated with `google/gemini-3-pro-image` through OpenRouter. The style was picked from four candidates. Each stage is an edit of the one before, and each pose is an edit of its stage's base, which keeps the character consistent. The model painted on flat magenta, which `sharp` keys out to transparency. Every frame shares one scale per stage and one ground line, so switching frames never jumps (`scripts/gen-frames.mjs`).

## Known limits

- Only Claude Code, and only one active session and one pet.
- Only the three npm check commands above can earn XP. Other test runners still affect Byte's mood.
- The 0.8 probability threshold is a starting heuristic, not a calibrated accuracy claim. XP is playful recognition of progress, not proof that a patch is correct.
- Secret scrubbing is pattern-based and best effort.
