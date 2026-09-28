// Local "slop" signals for one file edit, computed inside the hook on the user's machine.
// Only these booleans and counts are sent to Pico's server; the edited code never is.
//
// editFlags(files, oldText, newText) -> { testFile, skipAdded, assertsRemoved, silencerAdded }
//   testFile       an edited file looks like a test (foo.test.ts, tests/, __tests__/, test_x.py, x_test.go)
//   skipAdded      the edit adds .skip/.only/.todo, xit/xdescribe, pytest skip, t.Skip, @Disabled
//   assertsRemoved how many assertions (expect(, assert…, .toBe…) the edit removes, net
//   silencerAdded  the edit adds @ts-ignore/@ts-nocheck/@ts-expect-error, eslint-disable, # type: ignore, # noqa, nolint…

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]*\.py$/i;
const SKIP = /\b(?:it|test|describe|context)\.(?:skip|only|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|\bt\.Skip\w*\(|@Disabled\b|@Ignore\b/g;
// One match per assertion: where it starts (expect(…), assert…(…), assert x, x.should…), not each matcher after it.
const ASSERT = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\bassert\s+\S|\.should\b/g;
const SILENCER = /@ts-(?:ignore|nocheck|expect-error)|eslint-disable|#\s*type:\s*ignore|#\s*noqa|\/\/\s*nolint|#\s*pylint:\s*disable|@SuppressWarnings/g;

const count = (re, text) => (text ? (text.match(re) ?? []).length : 0);

export function editFlags(files, oldText = '', newText = '') {
  return {
    testFile: files.some((f) => typeof f === 'string' && TEST_PATH.test(f)),
    skipAdded: count(SKIP, newText) > count(SKIP, oldText),
    assertsRemoved: Math.max(0, count(ASSERT, oldText) - count(ASSERT, newText)),
    silencerAdded: count(SILENCER, newText) > count(SILENCER, oldText),
  };
}

/** Splits a Codex apply_patch body into touched files and removed/added text. */
export function parsePatch(patch) {
  const files = [], removed = [], added = [];
  for (const line of String(patch).split('\n')) {
    const m = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
    if (m) files.push(m[1].trim());
    else if (line.startsWith('-') && !line.startsWith('---')) removed.push(line.slice(1));
    else if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  return { files, oldText: removed.join('\n'), newText: added.join('\n') };
}

/**
 * The flags for one edit tool call, per agent, or undefined if it isn't an edit.
 * Claude: Edit/MultiEdit/Write. Codex: apply_patch. Gemini: replace/write_file.
 */
export function flagsForTool(agent, toolName, input) {
  const ti = input ?? {};
  if (agent === 'codex') {
    if (toolName !== 'apply_patch') return undefined;
    const body = typeof ti === 'string' ? ti : ti.command ?? ti.input ?? ti.patch ?? '';
    const p = parsePatch(Array.isArray(body) ? body.join('\n') : body);
    return editFlags(p.files, p.oldText, p.newText);
  }
  if (agent === 'gemini') {
    if (toolName === 'replace') return editFlags([ti.file_path], ti.old_string, ti.new_string);
    if (toolName === 'write_file') return editFlags([ti.file_path], '', ti.content);
    return undefined;
  }
  if (toolName === 'Edit') return editFlags([ti.file_path], ti.old_string, ti.new_string);
  if (toolName === 'MultiEdit' && Array.isArray(ti.edits)) {
    return editFlags([ti.file_path], ti.edits.map((e) => e.old_string ?? '').join('\n'), ti.edits.map((e) => e.new_string ?? '').join('\n'));
  }
  if (toolName === 'Write') return editFlags([ti.file_path], '', ti.content);
  return undefined;
}
