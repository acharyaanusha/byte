/* eslint-disable @typescript-eslint/no-explicit-any */
export type AgentId = 'claude' | 'codex' | 'gemini';
export const AGENTS: Record<AgentId, { label: string; dir: string; globalFile: string; repoFile: string; events: string[] }>;
export function isByteHook(h: unknown): boolean;
export function hookTarget(agent: AgentId, repo?: string): string;
export function mergeHooks(settings: any, opts?: { agent?: AgentId; remove?: boolean; hookPath?: string; command?: string }): any;
export function writeHooks(target: string, opts: { agent?: AgentId; remove?: boolean; hookPath?: string; command?: string }): string;
