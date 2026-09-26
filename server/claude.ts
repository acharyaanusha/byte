import { createHash } from 'node:crypto';
import type { EventKind, PetEvent } from '../shared/types.js';

const EXCERPT = 500;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const EDIT_TOOLS = new Set(['Edit', 'Write']);

type Raw = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const tail = (s: string, n = EXCERPT) => (s.length > n ? '…' + s.slice(-n) : s);
const head = (s: string, n = EXCERPT) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Crude secret scrub for excerpts: tokens that look like keys, and KEY=value pairs. */
export function scrub(s: string): string {
  return s
    .replace(/\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\b([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=\S+/g, '$1=[redacted]');
}

/**
 * Maps a supported check command to its canonical form. Anything with shell
 * composition (&&, ;, |, redirects, subshells) is unsupported: it may move the
 * pet's mood but can never mint XP.
 */
export function canonicalCheck(command: string): string | null {
  const c = command.trim().replace(/\s+/g, ' ');
  if (/[;&|<>`$()]/.test(c)) return null;
  if (c === 'npm test' || c === 'npm run test' || c === 'npm t') return 'npm test';
  if (c === 'npm run typecheck') return 'npm run typecheck';
  return null;
}

/** True when successful check output is recognizably a pass, not just a zero exit. */
export function looksPassing(check: string, output: string): boolean {
  if (check === 'npm run typecheck') return !/error TS\d+/.test(output) && !/\berror\b/i.test(output);
  const nodeTest = /# pass [1-9]\d*/.test(output) && /# fail 0\b/.test(output);
  const vitest = /Tests\s+\d+ passed/.test(output) && !/Tests\s+.*\d+ failed/.test(output);
  const jest = /Tests:\s+\d+ passed/.test(output) && !/Tests:.*\d+ failed/.test(output);
  return nodeTest || vitest || jest;
}

function stableId(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

export type Agent = 'claude' | 'codex' | 'gemini';
export const AGENT_LABEL: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };

/** A failing run of a supported check, recognized from its output (for agents that don't report exit codes). */
export function looksFailing(check: string, output: string): boolean {
  if (check === 'npm run typecheck') return /error TS\d+/.test(output);
  return /# fail [1-9]\d*/.test(output) || /Tests\s+.*\d+ failed/.test(output) || /Tests:.*\d+ failed/.test(output)
    || /npm (ERR!|error) /.test(output);
}

/**
 * A shell command as a Byte event. `failed` is the agent's own verdict when it has one
 * (Claude's failure hook, Gemini's exit code); Codex reports only the output text, so
 * for supported checks the verdict comes from the output, and other commands count as ok.
 */
function commandEvent(command: string, output: string, failed: boolean | null): { kind: EventKind; extra: Partial<PetEvent> } {
  const check = canonicalCheck(command);
  const failedNow = failed ?? (check ? looksFailing(check, output) : false);
  const extra: Partial<PetEvent> = { command: scrub(head(command, 200)), outputExcerpt: scrub(tail(output)) };
  if (check) {
    extra.check = check;
    extra.checkPassed = !failedNow && looksPassing(check, output);
  }
  return { kind: failedNow ? 'command_failed' : 'command_ok', extra };
}

type Translated = { kind: EventKind; extra: Partial<PetEvent>; turnId: string | null } | null;

function claudeEvent(raw: Raw, hook: string): Translated {
  const toolName = str(raw.tool_name);
  const toolInput = obj(raw.tool_input);
  const toolResponse = obj(raw.tool_response);
  const turnId = str(raw.prompt_id) ?? null;
  const done = (kind: EventKind, extra: Partial<PetEvent> = {}) => ({ kind, extra, turnId });
  if (hook === 'SessionStart') return done('session_start');
  if (hook === 'UserPromptSubmit') return done('prompt', { promptExcerpt: scrub(head(str(raw.prompt) ?? '')) });
  if (hook === 'Stop') return done('stop');
  if (hook === 'Notification') return done('notify', { message: scrub(head(str(raw.message) ?? '', 160)) });
  if (hook !== 'PostToolUse' && hook !== 'PostToolUseFailure') return null;
  if (!toolName) return null;
  if (READ_TOOLS.has(toolName)) return done('read');
  if (EDIT_TOOLS.has(toolName)) return hook === 'PostToolUseFailure' ? null : done('edit'); // a failed edit is not an edit
  if (toolName !== 'Bash') return null;
  const failed = hook === 'PostToolUseFailure' || toolResponse.interrupted === true;
  // Success output lives in tool_response.stdout/stderr; failure output in `error`.
  const output = failed ? str(raw.error) ?? '' : [str(toolResponse.stdout), str(toolResponse.stderr)].filter(Boolean).join('\n');
  const { kind, extra } = commandEvent(str(toolInput.command) ?? '', output, failed);
  return done(kind, extra);
}

/** Codex CLI: Claude-style hooks with turn_id; Bash output is a plain string with no exit code. */
function codexEvent(raw: Raw, hook: string): Translated {
  const turnId = str(raw.turn_id) ?? null;
  const done = (kind: EventKind, extra: Partial<PetEvent> = {}) => ({ kind, extra, turnId });
  const toolInput = obj(raw.tool_input);
  const response = str(raw.tool_response) ?? '';
  if (hook === 'SessionStart') return done('session_start');
  if (hook === 'UserPromptSubmit') return done('prompt', { promptExcerpt: scrub(head(str(raw.prompt) ?? '')) });
  if (hook === 'Stop') return done('stop');
  if (hook === 'PermissionRequest') {
    const cmd = str(toolInput.command);
    return done('notify', { message: scrub(head(`Codex needs your permission${cmd ? ` to run: ${cmd}` : ''}`, 160)) });
  }
  if (hook !== 'PostToolUse') return null;
  const toolName = str(raw.tool_name);
  if (toolName === 'apply_patch') return /^(error|failed)|failed to apply|verification failed/i.test(response) ? null : done('edit');
  if (toolName !== 'Bash') return null;
  const { kind, extra } = commandEvent(str(toolInput.command) ?? '', response, null);
  return done(kind, extra);
}

const GEMINI_READ = new Set(['read_file', 'read_many_files', 'glob', 'search_file_content', 'grep', 'list_directory']);
const GEMINI_EDIT = new Set(['replace', 'write_file']);

/** Gemini CLI: no turn ids (Byte starts a turn at each prompt); shell results carry "Exit Code: N". */
function geminiEvent(raw: Raw, hook: string): Translated {
  const hookTs = typeof raw.hook_ts === 'number' ? raw.hook_ts : Date.now();
  const done = (kind: EventKind, extra: Partial<PetEvent> = {}, turnId: string | null = null) => ({ kind, extra, turnId });
  const toolInput = obj(raw.tool_input);
  const toolResponse = obj(raw.tool_response);
  if (hook === 'SessionStart') return done('session_start');
  if (hook === 'BeforeAgent') return done('prompt', { promptExcerpt: scrub(head(str(raw.prompt) ?? '')) }, `gemini:${str(raw.session_id)}:${hookTs}`);
  if (hook === 'AfterAgent') return done('stop');
  if (hook === 'Notification') return done('notify', { message: scrub(head(str(raw.message) ?? '', 160)) });
  if (hook !== 'AfterTool') return null;
  const toolName = str(raw.tool_name) ?? '';
  const error = str(toolResponse.error);
  if (GEMINI_READ.has(toolName)) return done('read');
  if (GEMINI_EDIT.has(toolName)) return error ? null : done('edit');
  if (toolName !== 'run_shell_command') return null;
  const output = str(toolResponse.llmContent) ?? '';
  const code = /Exit Code:\s*(-?\d+)/.exec(output);
  const failed = error ? true : code ? Number(code[1]) !== 0 : null;
  const { kind, extra } = commandEvent(str(toolInput.command) ?? '', output, failed);
  return done(kind, extra);
}

/**
 * Normalizes a coding-agent hook payload (as forwarded by scripts/byte-hook.mjs,
 * tagged with `agent`) into a PetEvent. Returns null for anything Byte does not track.
 */
export function normalizeHook(input: unknown, now = Date.now()): PetEvent | null {
  const raw = obj(input);
  const sessionId = str(raw.session_id);
  const hook = str(raw.hook_event_name);
  if (!sessionId || !hook) return null;
  const agent: Agent = raw.agent === 'codex' || raw.agent === 'gemini' ? raw.agent : 'claude';
  const t = agent === 'codex' ? codexEvent(raw, hook) : agent === 'gemini' ? geminiEvent(raw, hook) : claudeEvent(raw, hook);
  if (!t) return null;
  const { kind, extra, turnId } = t;
  const toolUseId = str(raw.tool_use_id);
  const toolInput = obj(raw.tool_input);

  // Tool events carry tool_use_id (Claude, Codex). Notifications, and Gemini's id-less events,
  // are separate occurrences even with the same content, so their id includes the hook time;
  // a repeated delivery of one notification is dropped by the reducer.
  const id = toolUseId
    ? `${sessionId}:${toolUseId}:${kind}`
    : kind === 'notify'
      ? `${sessionId}:notify:${stableId([turnId, raw.message, raw.notification_type, raw.hook_ts])}`
      : agent === 'gemini'
        ? `${sessionId}:${kind}:${stableId([raw.prompt, toolInput, raw.tool_name, raw.hook_ts])}`
        : `${sessionId}:${kind}:${stableId([turnId, raw.prompt, raw.source, raw.last_assistant_message, toolInput])}`;
  // hook_ts is stamped by the hook when the agent runs it, so ordering survives async delivery.
  const timestamp = typeof raw.hook_ts === 'number' && Number.isFinite(raw.hook_ts) ? raw.hook_ts : now;
  return { id, sessionId, turnId, timestamp, kind, agent, ...extra };
}
