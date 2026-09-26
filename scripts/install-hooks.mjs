#!/usr/bin/env node
// Installs (or removes) Byte's hooks in <repo>/.claude/settings.local.json.
// Merges only Byte's entries, preserves everything else, backs up the file,
// and is idempotent.
//   node scripts/install-hooks.mjs <repo>              install for one repo (.claude/settings.local.json)
//   node scripts/install-hooks.mjs <repo> --remove     uninstall from that repo
//   node scripts/install-hooks.mjs --global            install for every Claude Code session (~/.claude/settings.json)
//   node scripts/install-hooks.mjs --global --remove   uninstall globally
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-hook.mjs');
const MARKER = 'claude-hook.mjs';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification'];
const TOOL_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);

export function isByteHook(h) {
  return typeof h?.command === 'string' && h.command.includes(MARKER) && h.command.includes('byte');
}

/** Returns settings with Byte's entries removed (and, unless removing, re-added). Pure. */
export function mergeHooks(settings, { remove = false, hookPath = HOOK } = {}) {
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
    for (const event of EVENTS) {
      const group = {
        ...(TOOL_EVENTS.has(event) ? { matcher: 'Read|Grep|Glob|Edit|Write|Bash' } : {}),
        hooks: [{ type: 'command', command: `node ${JSON.stringify(hookPath)}`, async: true, timeout: 5 }],
      };
      next.hooks[event] = [...(next.hooks[event] ?? []), group];
    }
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

function main() {
  const args = process.argv.slice(2);
  const global = args.includes('--global');
  const flag = args.includes('--remove') ? '--remove' : undefined;
  const repo = args.find((a) => !a.startsWith('--'));
  if (!global && !repo) {
    console.error('usage: node scripts/install-hooks.mjs <repo> [--remove]\n       node scripts/install-hooks.mjs --global [--remove]');
    process.exit(1);
  }
  const target = global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.resolve(repo, '.claude', 'settings.local.json');
  console.log(`Target: ${target}`);
  let settings = {};
  let original = null;
  if (fs.existsSync(target)) {
    original = fs.readFileSync(target, 'utf8');
    try {
      settings = JSON.parse(original);
    } catch (err) {
      console.error(`Could not parse ${target}; left it untouched. ${err.message}`);
      process.exit(1);
    }
  }
  const next = mergeHooks(settings, { remove: flag === '--remove' });
  const out = JSON.stringify(next, null, 2) + '\n';
  if (out === original) {
    console.log('Already up to date; nothing changed.');
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (original !== null) {
    const backup = `${target}.byte-backup-${Date.now()}`;
    fs.writeFileSync(backup, original);
    console.log(`Backup: ${backup}`);
  }
  fs.writeFileSync(target, out);
  console.log(flag === '--remove' ? 'Removed Byte hooks.' : `Installed Byte hooks. Restart Claude Code${global ? ' sessions' : ' in that repo'} to pick them up.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
