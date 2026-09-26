// Everything the packaged app needs from the Node side, bundled into
// electron/backend.cjs by `npm run app:bundle` (Electron's main process can't load TypeScript).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createByte } from '../server/index.js';
import { isByteHook, mergeHooks } from '../scripts/install-hooks.mjs';

export { createByte };

export const BYTE_HOME = path.join(os.homedir(), '.byte');
const CONFIG = path.join(BYTE_HOME, 'config.json');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export interface Config { typesafeApiKey?: string; askedToConnect?: boolean }

export function readConfig(): Config {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

export function writeConfig(next: Config) {
  fs.mkdirSync(BYTE_HOME, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function readSettings(): { settings: Record<string, unknown>; original: string | null } {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return { settings: {}, original: null };
  const original = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
  return { settings: JSON.parse(original), original }; // throws on invalid JSON: caller reports, file untouched
}

export function hooksInstalled(): boolean {
  try {
    const hooks = (readSettings().settings.hooks ?? {}) as Record<string, { hooks?: unknown[] }[]>;
    return Object.values(hooks).some((groups) => groups.some((g) => (g.hooks ?? []).some(isByteHook)));
  } catch { return false; }
}

/**
 * Connects (or disconnects) Byte to every Claude Code session: copies the hook script to
 * ~/.byte and merges Byte's async hooks into ~/.claude/settings.json, keeping a backup.
 * The hook runs with this app's own Node runtime, so no separate Node install is needed.
 */
export function setClaudeHooks(connect: boolean, hookSource: string, runtime: string): string {
  const { settings, original } = readSettings();
  const hookPath = path.join(BYTE_HOME, 'claude-hook.mjs');
  if (connect) {
    fs.mkdirSync(BYTE_HOME, { recursive: true });
    fs.copyFileSync(hookSource, hookPath);
  }
  const command = `ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(runtime)} ${JSON.stringify(hookPath)}`;
  const next = mergeHooks(settings, { remove: !connect, hookPath, command });
  const out = JSON.stringify(next, null, 2) + '\n';
  if (out === original) return 'Already up to date.';
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  let note = '';
  if (original !== null) {
    const backup = `${CLAUDE_SETTINGS}.byte-backup-${Date.now()}`;
    fs.writeFileSync(backup, original);
    note = ` Backup: ${backup}`;
  }
  fs.writeFileSync(CLAUDE_SETTINGS, out);
  return (connect ? 'Connected to Claude Code.' : 'Disconnected from Claude Code.') + note;
}
