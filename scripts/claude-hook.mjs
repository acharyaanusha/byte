#!/usr/bin/env node
// Byte's passive Claude Code hook. Reads the hook JSON from stdin, keeps only a
// bounded subset, and POSTs it to the local Byte server with a 300 ms timeout.
// It never writes to stdout, never blocks, and always exits 0.
const URL = process.env.BYTE_URL ?? 'http://127.0.0.1:4317/events';
// Stamped before anything else: async hooks may be delivered out of order, so the
// server orders a turn's events by this time, not by arrival.
const HOOK_TS = Date.now();
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
    session_id: raw.session_id,
    prompt_id: raw.prompt_id,
    hook_event_name: raw.hook_event_name,
    source: raw.source,
    prompt: cut(raw.prompt, 500),
    tool_name: raw.tool_name,
    tool_use_id: raw.tool_use_id,
    tool_input: { command: cut(ti.command, 500), file_path: cut(ti.file_path, 300) },
    tool_response: typeof tr === 'object'
      ? { stdout: cut(tr.stdout, 2000, true), stderr: cut(tr.stderr, 1000, true), interrupted: tr.interrupted }
      : undefined,
    error: cut(raw.error, 2000, true),
    last_assistant_message: cut(raw.last_assistant_message, 200),
  };
  await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
