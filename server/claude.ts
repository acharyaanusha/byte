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

/**
 * Normalizes a Claude Code hook payload (as forwarded by scripts/claude-hook.mjs)
 * into a PetEvent. Returns null for anything Byte does not track.
 */
export function normalizeHook(input: unknown, now = Date.now()): PetEvent | null {
  const raw = obj(input);
  const sessionId = str(raw.session_id);
  const hook = str(raw.hook_event_name);
  if (!sessionId || !hook) return null;
  const turnId = str(raw.prompt_id) ?? null;
  const toolName = str(raw.tool_name);
  const toolUseId = str(raw.tool_use_id);
  const toolInput = obj(raw.tool_input);
  const toolResponse = obj(raw.tool_response);

  let kind: EventKind;
  const extra: Partial<PetEvent> = {};

  if (hook === 'SessionStart') kind = 'session_start';
  else if (hook === 'UserPromptSubmit') {
    kind = 'prompt';
    extra.promptExcerpt = scrub(head(str(raw.prompt) ?? ''));
  } else if (hook === 'Stop') kind = 'stop';
  else if (hook === 'PostToolUse' || hook === 'PostToolUseFailure') {
    if (!toolName) return null;
    if (READ_TOOLS.has(toolName)) kind = 'read';
    else if (EDIT_TOOLS.has(toolName)) {
      if (hook === 'PostToolUseFailure') return null; // a failed edit is not an edit
      kind = 'edit';
    } else if (toolName === 'Bash') {
      const command = str(toolInput.command) ?? '';
      const failed = hook === 'PostToolUseFailure' || toolResponse.interrupted === true;
      // Success output lives in tool_response.stdout/stderr; failure output in `error`.
      const output = failed
        ? str(raw.error) ?? ''
        : [str(toolResponse.stdout), str(toolResponse.stderr)].filter(Boolean).join('\n');
      kind = failed ? 'command_failed' : 'command_ok';
      extra.command = scrub(head(command, 200));
      extra.outputExcerpt = scrub(tail(output));
      const check = canonicalCheck(command);
      if (check) {
        extra.check = check;
        extra.checkPassed = !failed && looksPassing(check, output);
      }
    } else return null;
  } else return null;

  const id = toolUseId
    ? `${sessionId}:${toolUseId}:${kind}`
    : `${sessionId}:${kind}:${stableId([turnId, raw.prompt, raw.source, raw.last_assistant_message, toolInput])}`;
  return { id, sessionId, turnId, timestamp: now, kind, ...extra };
}
