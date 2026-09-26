// Everything the packaged app needs from the Node side, bundled into
// electron/backend.cjs by `npm run app:bundle` (Electron's main process can't load TypeScript).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createByte, resolveProxy } from '../server/index.js';
import { AGENTS, hookTarget, isByteHook, writeHooks } from '../scripts/install-hooks.mjs';

export { createByte, resolveProxy };

export const BYTE_HOME = path.join(os.homedir(), '.byte');
const CONFIG = path.join(BYTE_HOME, 'config.json');

export interface Config { typesafeApiKey?: string; askedToConnect?: boolean }

export function readConfig(): Config {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

export function writeConfig(next: Config) {
  fs.mkdirSync(BYTE_HOME, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2), { mode: 0o600 });
}

export type AgentId = 'claude' | 'codex' | 'gemini';
export const AGENT_IDS: AgentId[] = ['claude', 'codex', 'gemini'];
export const agentLabel = (a: AgentId) => AGENTS[a].label;

/** Is this agent installed on this machine (its config folder exists)? */
export function agentPresent(agent: AgentId): boolean {
  return fs.existsSync(path.join(os.homedir(), AGENTS[agent].dir));
}

export function hooksInstalled(agent: AgentId): boolean {
  try {
    const target = hookTarget(agent);
    if (!fs.existsSync(target)) return false;
    const hooks = (JSON.parse(fs.readFileSync(target, 'utf8')).hooks ?? {}) as Record<string, { hooks?: unknown[] }[]>;
    return Object.values(hooks).some((groups) => groups.some((g) => (g.hooks ?? []).some(isByteHook)));
  } catch { return false; }
}

/**
 * Connects (or disconnects) Byte to every session of one coding agent: copies the hook
 * script to ~/.byte and merges Byte's hooks into that agent's global config, keeping a
 * backup. The hook runs with this app's own Node runtime, so no separate Node install is needed.
 * Throws, leaving the file untouched, if the agent's config isn't valid JSON.
 */
export function setAgentHooks(agent: AgentId, connect: boolean, hookSource: string, runtime: string): string {
  const hookPath = path.join(BYTE_HOME, 'byte-hook.mjs');
  if (connect) {
    fs.mkdirSync(BYTE_HOME, { recursive: true });
    fs.copyFileSync(hookSource, hookPath);
  }
  const command = `ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(runtime)} ${JSON.stringify(hookPath)} --agent ${agent}`;
  return writeHooks(hookTarget(agent), { agent, remove: !connect, hookPath, command });
}
