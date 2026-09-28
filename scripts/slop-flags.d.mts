export interface EditFlags { testFile: boolean; skipAdded: boolean; assertsRemoved: number; silencerAdded: boolean }
export function editFlags(files: (string | undefined)[], oldText?: string, newText?: string): EditFlags;
export function parsePatch(patch: string): { files: string[]; oldText: string; newText: string };
export function flagsForTool(agent: string, toolName: string, input: unknown): EditFlags | undefined;
