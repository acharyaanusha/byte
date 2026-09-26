# Byte

**Your coding companion grows with every little breakthrough.**

<img src="public/pet/hatchling.png" width="120" alt="Byte, hatchling"> <img src="public/pet/sprout.png" width="120" alt="Byte, sprout"> <img src="public/pet/companion.png" width="120" alt="Byte, companion">

Byte is a small dragon that lives in a browser window beside your terminal. It watches your
Claude Code session through hooks and grows when you and your agent hit real coding
milestones, such as fixing a failing test.

- **Passive.** Claude Code hooks forward small event summaries to a local server. The agent never has to call a pet tool, and the hooks never block or steer it.
- **Evidence first.** XP needs *both* local evidence (an edit, then a matching check whose output shows a pass) *and* [Jev](https://docs.typesafe.ai) agreeing, with probability ≥ 0.8. A claim like "all tests pass" earns nothing on its own.
- **Honest when offline.** If Jev is unreachable, Byte keeps reacting to your session but awards no XP, and it shows the connection as degraded.

| Milestone | XP | Evidence required in one prompt turn |
|---|---:|---|
| Verified progress | 10 | An edit, then a supported check that passes |
| Recovered from failure | 20 | A check fails, then an edit, then **the same** check passes |

Stages: hatchling (0–19 XP) → sprout (20–49) → companion (50+). A turn earns at most one milestone. You never lose XP.

## How it works

```
Claude Code ──hooks──▶ scripts/claude-hook.mjs ──POST /events (300 ms, fail-open)──▶ server (127.0.0.1:4317)
                                                                                     │  reduceEvent: behavior + turn evidence
                                                                                     │  debounce 2 s, 1 in flight, ≤ 1 call / 10 s
                                                                                     ▼
                                               Jev: 3 questions in 1 batched request (activity, milestone, needs_attention)
                                                                                     │
                                          applyJudgment: award only if evidence + Jev agree, once per turn
                                                                                     ▼
browser (Vite, polls /api/state every second) ◀── .byte/pet.json (atomic writes)
```

- **Behaviors:** idle (breathing), focused (bobbing), puzzled (tilting, after a failed command), celebrating (hopping, 4 s), sleeping (after 90 s with no activity). Growing to a new stage adds a flash and a scale pop. Byte holds each ordinary behavior for at least 3 s so it doesn't flicker.
- **Turns:** each event's Claude Code `prompt_id` is its turn ID. A Jev reply for an older turn is ignored, so it can't award XP to a newer one.
- **Supported checks:** `npm test`, `npm run test`, `npm run typecheck`. A passing run must also show recognizable output (node:test, vitest or jest summaries; no `error TS` for typecheck). Compound shell commands (`&&`, `|`, `;` …) can change Byte's mood but can't earn XP.
- **What Jev sees:** the prompt excerpt (≤ 500 chars) and the turn's last 12 events, with command output tails of ≤ 500 chars each and ≤ 8,000 chars in total. File contents, environment and anything that looks like a key are left out. The prompt tells Jev to treat all of it as evidence, not instructions.

## Setup

Requires Node 22+ and Claude Code.

```bash
npm install
cp .env.example .env          # then set TYPESAFE_API_KEY (server-side only)
npm run dev                   # server on 127.0.0.1:4317, UI on http://127.0.0.1:5173
```

Open http://127.0.0.1:5173 in a narrow window (about 360 × 480) beside your terminal.

### Install the hooks in a repo

```bash
npm run install-hooks -- /path/to/your/repo
```

This prints the target path, backs up the file, and merges only Byte's entries into
`<repo>/.claude/settings.local.json`. Your existing settings and hooks stay as they are, and running it
again changes nothing. Global Claude settings are never touched. If the file isn't valid JSON, the installer leaves it alone and reports the error.
Restart Claude Code in that repo afterwards.

**Remove:** `npm run install-hooks -- /path/to/your/repo --remove` (or restore the `.byte-backup-*` file).

The hooks are `async` command hooks for SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure and Stop.
The tool hooks only match Read, Grep, Glob, Edit, Write and Bash. The hook script always exits 0 and writes nothing to stdout, even when the Byte server isn't running.

### Sessions

Byte follows the first Claude Code session it sees. Events from other sessions are ignored, and a banner says another session is active.
**Disconnect** releases the session, so the next session to send an event takes over. Progress lives in `.byte/pet.json` and survives restarts and page reloads.

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
npm run sprites   # regenerate art via OpenRouter (needs OPENROUTER_API_KEY)
```

`fixtures/claude-code-2.1.283-hooks.json` holds real hook payloads captured from Claude Code 2.1.283 (with paths and file contents stripped). The tests run the normalizer against them.

The sprites were generated with `google/gemini-3-pro-image` through OpenRouter. The hatchling came first, and each later stage was generated as an edit of the stage before it to keep the character consistent. The model painted on flat magenta, which `sharp` keys out to transparency (`scripts/gen-sprites.mjs`).

## Known limits

- Only Claude Code, and only one active session and one pet.
- Only the three npm check commands above can earn XP. Other test runners still affect Byte's mood.
- The 0.8 probability threshold is a starting heuristic, not a calibrated accuracy claim. XP is playful recognition of progress, not proof that a patch is correct.
- Secret scrubbing is pattern-based and best effort.
