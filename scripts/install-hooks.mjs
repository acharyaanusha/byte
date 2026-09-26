#!/usr/bin/env node
// Installs (or removes) Byte's hooks for a coding agent: Claude Code, Codex CLI or Gemini CLI.
// Merges only Byte's entries, preserves everything else, backs up the file, and is idempotent.
//   node scripts/install-hooks.mjs --global [--agent claude|codex|gemini] [--remove]
//       every session of that agent (~/.claude/settings.json, ~/.codex/hooks.json, ~/.gemini/settings.json)
//   node scripts/install-hooks.mjs <repo> [--agent claude|codex|gemini] [--remove]
//       one repo (.claude/settings.local.json, .codex/hooks.json, .gemini/settings.json)
// --agent defaults to claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.url is empty when this file is bundled into the app (which passes its own path).
const HOOK = import.meta.url ? path.join(path.dirname(fileURLToPath(import.meta.url)), 'byte-hook.mjs') : '';

/**
 * Per agent: where its hooks live, which events Byte listens to, and the handler shape it accepts.
 * Codex doesn't support async command hooks, so its handler is a plain command; the hook itself
 * gives up after 300 ms. Gemini timeouts are in milliseconds.
 */
export const AGENTS = {
  claude: {
    label: 'Claude Code',
    dir: '.claude',
    globalFile: 'settings.json',
    repoFile: 'settings.local.json',
    events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification'],
    matchers: { PostToolUse: 'Read|Grep|Glob|Edit|Write|Bash', PostToolUseFailure: 'Read|Grep|Glob|Edit|Write|Bash' },
    handler: (command) => ({ type: 'command', command, async: true, timeout: 5 }),
  },
  codex: {
    label: 'Codex',
    dir: '.codex',
    globalFile: 'hooks.json',
    repoFile: 'hooks.json',
    events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop'],
    matchers: { PostToolUse: '^(Bash|apply_patch)$' },
    handler: (command) => ({ type: 'command', command, timeout: 5 }),
  },
  gemini: {
    label: 'Gemini CLI',
    dir: '.gemini',
    globalFile: 'settings.json',
    repoFile: 'settings.json',
    events: ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent', 'Notification'],
    matchers: { AfterTool: 'run_shell_command|replace|write_file|read_file|read_many_files|glob|search_file_content|grep|list_directory' },
    handler: (command) => ({ type: 'command', name: 'byte', command, timeout: 5000 }),
  },
};

export function isByteHook(h) {
  const c = h?.command;
  return typeof c === 'string' && c.includes('byte') && (c.includes('byte-hook.mjs') || c.includes('claude-hook.mjs'));
}

/** The config file Byte's hooks go in for this agent, globally or for one repo. */
export function hookTarget(agent, repo) {
  const a = AGENTS[agent];
  return repo ? path.resolve(repo, a.dir, a.repoFile) : path.join(os.homedir(), a.dir, a.globalFile);
}

/** Returns settings with Byte's entries removed (and, unless removing, re-added). Pure. */
export function mergeHooks(settings, { agent = 'claude', remove = false, hookPath = HOOK, command } = {}) {
  const a = AGENTS[agent];
  const next = structuredClone(settings);
  next.hooks ??= {};
  for (const event of Object.keys(next.hooks)) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isByteHook(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!remove) {
    const cmd = command ?? `node ${JSON.stringify(hookPath)} --agent ${agent}`;
    for (const event of a.events) {
      const group = { ...(a.matchers[event] ? { matcher: a.matchers[event] } : {}), hooks: [a.handler(cmd)] };
      next.hooks[event] = [...(next.hooks[event] ?? []), group];
    }
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

/**
 * Applies mergeHooks to the agent's config file with a backup. Throws (leaving the file
 * untouched) if it isn't valid JSON. Returns a one-line summary.
 */
export function writeHooks(target, opts) {
  let settings = {};
  let original = null;
  if (fs.existsSync(target)) {
    original = fs.readFileSync(target, 'utf8');
    settings = JSON.parse(original);
  }
  const out = JSON.stringify(mergeHooks(settings, opts), null, 2) + '\n';
  if (out === original) return 'Already up to date; nothing changed.';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let note = '';
  if (original !== null) {
    const backup = `${target}.byte-backup-${Date.now()}`;
    fs.writeFileSync(backup, original);
    note = ` Backup: ${backup}`;
  }
  fs.writeFileSync(target, out);
  return (opts.remove ? 'Removed Byte hooks.' : 'Installed Byte hooks.') + note;
}

function main() {
  const args = process.argv.slice(2);
  const global = args.includes('--global');
  const remove = args.includes('--remove');
  const agentAt = args.indexOf('--agent');
  const agent = agentAt >= 0 ? args[agentAt + 1] : 'claude';
  const repo = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--agent');
  if (!AGENTS[agent] || (!global && !repo)) {
    console.error('usage: node scripts/install-hooks.mjs (--global | <repo>) [--agent claude|codex|gemini] [--remove]');
    process.exit(1);
  }
  const target = hookTarget(agent, global ? undefined : repo);
  console.log(`Target: ${target}`);
  try {
    console.log(writeHooks(target, { agent, remove }));
  } catch (err) {
    console.error(`Could not parse ${target}; left it untouched. ${err.message}`);
    process.exit(1);
  }
  if (!remove) {
    console.log(`Restart ${AGENTS[agent].label} to pick them up.`);
    if (agent === 'codex') console.log('Codex asks you to trust new hooks before running them; approve Byte\'s when it asks.');
  }
}

if (import.meta.url && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
