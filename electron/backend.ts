// Everything the packaged app needs from the Node side, bundled into
// electron/backend.cjs by `npm run app:bundle` (Electron's main process can't load TypeScript).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPico, resolveProxy } from '../server/index.js';
import { AGENTS, hookTarget, isPicoHook, writeHooks } from '../scripts/install-hooks.mjs';

export { createPico, resolveProxy };

export const PICO_HOME = path.join(os.homedir(), '.pico');
const CONFIG = path.join(PICO_HOME, 'config.json');

/** Earlier versions (when the project was called Byte) kept the pet and key in ~/.byte: carry them over once. */
export function migrateHome() {
  const old = path.join(os.homedir(), '.byte');
  if (fs.existsSync(PICO_HOME) || !fs.existsSync(old)) return;
  fs.mkdirSync(PICO_HOME, { recursive: true });
  for (const f of ['pet.json', 'config.json']) {
    const from = path.join(old, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(PICO_HOME, f));
  }
}

export interface Config { typesafeApiKey?: string; askedToConnect?: boolean }

export function readConfig(): Config {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

export function writeConfig(next: Config) {
  fs.mkdirSync(PICO_HOME, { recursive: true });
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
    return Object.values(hooks).some((groups) => groups.some((g) => (g.hooks ?? []).some(isPicoHook)));
  } catch { return false; }
}

/**
 * Connects (or disconnects) Pico to every session of one coding agent: copies the hook
 * script to ~/.pico and merges Pico's hooks into that agent's global config, keeping a
 * backup. The hook runs with this app's own Node runtime, so no separate Node install is needed.
 * Throws, leaving the file untouched, if the agent's config isn't valid JSON.
 */
export function setAgentHooks(agent: AgentId, connect: boolean, hookSource: string, runtime: string): string {
  const hookPath = path.join(PICO_HOME, 'pico-hook.mjs');
  if (connect) {
    fs.mkdirSync(PICO_HOME, { recursive: true });
    fs.copyFileSync(hookSource, hookPath);
  }
  const command = `ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(runtime)} ${JSON.stringify(hookPath)} --agent ${agent}`;
  return writeHooks(hookTarget(agent), { agent, remove: !connect, hookPath, command });
}
