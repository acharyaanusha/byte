#!/usr/bin/env node
// Byte's passive coding-agent hook (Claude Code, Codex CLI, Gemini CLI).
// Usage: byte-hook.mjs [--agent claude|codex|gemini]   (default: claude)
// Reads the hook JSON from stdin, keeps only a bounded subset, and POSTs it to the
// local Byte server with a 300 ms timeout. It never writes to stdout, never blocks,
// and always exits 0. The server does the per-agent translation (server/agents.ts).
const URL = process.env.BYTE_URL ?? 'http://127.0.0.1:4317/events';
// Stamped before anything else: async hooks may be delivered out of order, so the
// server orders a turn's events by this time, not by arrival.
const HOOK_TS = Date.now();
const argAt = process.argv.indexOf('--agent');
const AGENT = argAt > 0 ? process.argv[argAt + 1] : 'claude';
const cut = (s, n, fromEnd = false) =>
  typeof s !== 'string' ? undefined : s.length <= n ? s : fromEnd ? s.slice(-n) : s.slice(0, n);

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2_000_000) break;
  }
  const raw = JSON.parse(input);
  const ti = raw.tool_input ?? {};
  const tr = raw.tool_response ?? {};
  // No file bodies, no environment: just what Byte needs to judge the turn.
  const payload = {
    hook_ts: HOOK_TS,
    agent: AGENT,
    turn_id: raw.turn_id,
    session_id: raw.session_id,
    prompt_id: raw.prompt_id,
    hook_event_name: raw.hook_event_name,
    source: raw.source,
    prompt: cut(raw.prompt, 500),
    tool_name: raw.tool_name,
    tool_use_id: raw.tool_use_id,
    tool_input: { command: cut(Array.isArray(ti.command) ? ti.command.join(' ') : ti.command, 500), file_path: cut(ti.file_path, 300) },
    // Claude: {stdout, stderr, interrupted}. Codex: a plain output string.
    // Gemini: {llmContent, returnDisplay, error}.
    tool_response: typeof tr === 'string'
      ? cut(tr, 2000, true)
      : typeof tr === 'object'
        ? {
            stdout: cut(tr.stdout, 2000, true), stderr: cut(tr.stderr, 1000, true), interrupted: tr.interrupted,
            llmContent: cut(typeof tr.llmContent === 'string' ? tr.llmContent : undefined, 2000, true),
            error: tr.error ? cut(typeof tr.error === 'string' ? tr.error : JSON.stringify(tr.error), 500) : undefined,
          }
        : undefined,
    error: cut(raw.error, 2000, true),
    last_assistant_message: cut(raw.last_assistant_message, 200),
    message: cut(raw.message, 200),
    notification_type: cut(raw.notification_type, 60),
  };
  await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
