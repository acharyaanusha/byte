import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHook } from './claude.js';
import { judge } from './jev.js';
import { JudgeScheduler } from './scheduler.js';
import { applyJudgment, disconnect, initialState, markDegraded, publicState, reduceEvent } from './state.js';
import { loadState, Store } from './store.js';
import type { PetJudgment, PetState } from '../shared/types.js';

export interface ByteOptions {
  statePath: string;
  apiKey?: string;
  judgeImpl?: typeof judge;
  schedule?: { debounceMs: number; cooldownMs: number };
  log?: (msg: string) => void;
}

const TRIGGERS = new Set(['command_ok', 'command_failed', 'stop', 'notify']);
const MAX_BODY = 64 * 1024;

export function createByte(opts: ByteOptions) {
  const log = opts.log ?? ((m: string) => console.log(`[byte] ${m}`));
  const store = new Store(opts.statePath);
  let state: PetState = loadState(opts.statePath) ?? initialState();
  // Connection is a property of this run, not of the saved pet.
  state = opts.apiKey ? { ...state, connection: 'waiting' } : markDegraded(state);
  const set = (next: PetState) => { state = next; store.save(state); };

  const scheduler = new JudgeScheduler(async () => {
    const ev = state.currentTurnEvidence;
    if (!ev) return;
    // Captured now: a late reply must not touch a newer turn or newer evidence in this turn.
    const turnId = ev.turnId;
    const version = ev.version;
    if (!opts.apiKey) { set(markDegraded(state)); return; }
    let judgment: PetJudgment;
    try {
      judgment = await (opts.judgeImpl ?? judge)(ev, { apiKey: opts.apiKey });
    } catch (err) {
      log(`jev failed turn=${turnId}: ${(err as Error).name}: ${(err as Error).message}`);
      set(markDegraded(state));
      return;
    }
    const { state: next, awarded, superseded } = applyJudgment(state, judgment, turnId, Date.now(), version);
    const stale = !!superseded;
    // Newer evidence arrived while Jev was thinking: judge the current snapshot next.
    if (stale && state.currentTurnEvidence?.turnId === turnId) scheduler.request();
    log(`jev turn=${turnId} v${version} activity=${judgment.activity} milestone=${judgment.milestone} p=${judgment.milestoneProbability.toFixed(2)} attention=${judgment.needsAttention.toFixed(2)} ${judgment.latencyMs ?? '?'}ms awarded=${awarded}${stale ? ' (superseded, ignored)' : ''}`);
    set(next);
  }, opts.schedule);

  function ingest(raw: unknown) {
    const event = normalizeHook(raw);
    if (!event) return 'ignored';
    if (!event.turnId && event.kind !== 'prompt' && event.kind !== 'session_start') {
      event.turnId = state.currentTurnEvidence?.turnId ?? null;
    }
    const { state: next, outcome } = reduceEvent(state, event);
    if (outcome === 'duplicate') return outcome;
    set(next);
    log(`event ${event.id} kind=${event.kind}${event.check ? ` check="${event.check}" pass=${event.checkPassed}` : ''} ${outcome}`);
    if (outcome === 'applied' && TRIGGERS.has(event.kind)) scheduler.request();
    return outcome;
  }

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const url = (req.url ?? '/').replace(/^\/api/, '');
    if (req.method === 'GET' && url === '/state') return send(200, publicState(state, Date.now()));
    if (req.method === 'POST' && url === '/disconnect') { set(disconnect(state)); return send(200, { ok: true }); }
    if (req.method === 'POST' && url === '/events') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
      req.on('end', () => {
        let raw: unknown;
        try { raw = JSON.parse(body); } catch { return send(400, { error: 'bad json' }); }
        // Acknowledge first; Jev runs later on the scheduler.
        const outcome = ingest(raw);
        send(202, { outcome });
      });
      return;
    }
    send(404, { error: 'not found' });
  });

  return {
    server,
    ingest,
    getState: () => state,
    flush: () => store.flush(),
    close: async () => { scheduler.stop(); await store.flush(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

// Entry point: `tsx server/index.ts`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.BYTE_PORT ?? 4317);
  const apiKey = process.env.TYPESAFE_API_KEY || undefined;
  const byte = createByte({ statePath: path.join(root, '.byte', 'pet.json'), apiKey });
  byte.server.listen(port, '127.0.0.1', () => {
    console.log(`[byte] listening on http://127.0.0.1:${port}  jev=${apiKey ? 'configured' : 'NO KEY (degraded)'}`);
  });
}
