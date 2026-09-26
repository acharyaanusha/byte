/**
 * Byte's shared Jev proxy (POST /api/judge on Vercel), so people can use Byte
 * without their own TypeSafe key. It holds the key server-side and only ever asks
 * Byte's three fixed questions (buildQuestions) about the bounded summary Byte
 * sends, so it can't be used as a general-purpose Jev endpoint. Nothing is stored.
 */
import { buildQuestions, JEV_MODEL, JEV_URL, parseJudgment } from '../server/jev.js';
import { createRateLimiter } from './rate-limit.js';

export const MAX_STATE = 8000;
const TIMEOUT_MS = 8000;
// Byte's own scheduler asks at most once per 10 s, so a real user never gets near this.
const defaultAllow = createRateLimiter({ limit: 12, windowMs: 60_000 });

export interface JudgeDeps {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  allow?: (caller: string) => boolean;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Vercel puts the client address first in x-forwarded-for. */
function callerOf(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : null;
}

export async function handleJudge(request: Request, deps: JudgeDeps = {}): Promise<Response> {
  const apiKey = 'apiKey' in deps ? deps.apiKey : process.env.TYPESAFE_API_KEY;
  if (!apiKey) return json(503, { error: 'not_configured' });
  const caller = callerOf(request);
  if (caller !== null && !(deps.allow ?? defaultAllow)(caller)) return json(429, { error: 'rate_limited' });

  let body: unknown;
  try { body = JSON.parse(await request.text()); } catch { return json(400, { error: 'bad_json' }); }
  const state = (body as { state?: unknown })?.state;
  if (typeof state !== 'string' || state.length === 0 || state.length > MAX_STATE) return json(400, { error: 'bad_state' });

  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions: buildQuestions() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return json(504, { error: 'jev_unreachable' });
  }
  if (!res.ok) return json(502, { error: 'jev_error', status: res.status });
  try {
    return json(200, parseJudgment(await res.json()));
  } catch {
    return json(502, { error: 'jev_bad_answer' });
  }
}
