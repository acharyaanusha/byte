import { describe, expect, it } from 'vitest';
import { handleJudge } from '../proxy/handler.js';
import { judge } from '../server/jev.js';
import { newEvidence } from '../server/state.js';

const jevAnswer = {
  answers: {
    activity: { type: 'choice', choice: 'checking', probabilities: { checking: 0.9 } },
    milestone: { type: 'choice', choice: 'recovered_from_failure', probabilities: { recovered_from_failure: 0.97, verified_progress: 0.02, none: 0.01 } },
    needs_attention: { type: 'noul', noul: 0.04 },
  },
};
const req = (body: unknown, ip = '1.2.3.4') =>
  new Request('https://x/api/judge', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('shared Jev proxy', () => {
  it('asks only the fixed questions and returns a validated judgment', async () => {
    let sent: { questions: Record<string, unknown>; state: string; model: string } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify(jevAnswer));
    }) as typeof fetch;
    const res = await handleJudge(req({ state: 'summary', questions: { evil: {} } }), { apiKey: 'k', fetchImpl, allow: () => true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ activity: 'checking', milestone: 'recovered_from_failure', milestoneProbability: 0.97, needsAttention: 0.04 });
    expect(Object.keys(sent!.questions)).toEqual(['activity', 'milestone', 'needs_attention']); // caller's questions ignored
    expect(sent!.state).toBe('summary');
  });

  it('rejects bad bodies, oversized summaries, and callers over the limit', async () => {
    const deps = { apiKey: 'k', fetchImpl: (async () => new Response('{}')) as typeof fetch, allow: () => true };
    expect((await handleJudge(req('nope'), deps)).status).toBe(400);
    expect((await handleJudge(req({ state: 42 }), deps)).status).toBe(400);
    expect((await handleJudge(req({ state: 'x'.repeat(8001) }), deps)).status).toBe(400);
    expect((await handleJudge(req({ state: 's' }), { ...deps, allow: () => false })).status).toBe(429);
    expect((await handleJudge(req({ state: 's' }), { ...deps, apiKey: undefined })).status).toBe(503);
  });

  it('turns a malformed Jev answer into a 502, not a judgment', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ answers: { activity: { choice: 'dancing' } } }))) as typeof fetch;
    expect((await handleJudge(req({ state: 's' }), { apiKey: 'k', fetchImpl, allow: () => true })).status).toBe(502);
  });

  it('Pico uses the proxy when it has no personal key, and a personal key bypasses it', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes('proxy')) return new Response(JSON.stringify({ activity: 'checking', milestone: 'none', milestoneProbability: 1, needsAttention: 0.1 }));
      return new Response(JSON.stringify(jevAnswer));
    }) as typeof fetch;
    const ev = newEvidence('t');
    const viaProxy = await judge(ev, { proxyUrl: 'https://proxy.test/api/judge', fetchImpl });
    expect(viaProxy.milestone).toBe('none');
    const direct = await judge(ev, { apiKey: 'mine', proxyUrl: 'https://proxy.test/api/judge', fetchImpl });
    expect(direct.milestone).toBe('recovered_from_failure');
    expect(calls).toEqual(['https://proxy.test/api/judge', 'https://api.typesafe.ai/v1/systemone']);
  });
});
