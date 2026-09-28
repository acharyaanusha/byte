import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHook } from './claude.js';
import { DEFAULT_PROXY_URL, judge } from './jev.js';
import { JudgeScheduler } from './scheduler.js';
import { applyJudgment, disconnect, initialState, markDegraded, publicState, reduceEvent, setAppearance } from './state.js';
import { loadState, Store } from './store.js';
import type { PetJudgment, PetState } from '../shared/types.js';

export interface PicoOptions {
  statePath: string;
  apiKey?: string;
  judgeImpl?: typeof judge;
  schedule?: { debounceMs: number; cooldownMs: number };
  log?: (msg: string) => void;
  /** Shared Jev proxy used when there is no personal key; undefined disables it. */
  proxyUrl?: string;
  /** Serve the built UI from this directory (the packaged app); dev uses Vite instead. */
  staticDir?: string;
}

const TRIGGERS = new Set(['command_ok', 'command_failed', 'stop', 'notify']);
const MAX_BODY = 64 * 1024;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};

export function createPico(opts: PicoOptions) {
  const log = opts.log ?? ((m: string) => console.log(`[pico] ${m}`));
  const store = new Store(opts.statePath);
  let state: PetState = loadState(opts.statePath) ?? initialState();
  let apiKey = opts.apiKey;
  const canJudge = () => !!apiKey || !!opts.proxyUrl;
  // Connection is a property of this run, not of the saved pet.
  state = canJudge() ? { ...state, connection: 'waiting' } : markDegraded(state);
  const set = (next: PetState) => { state = next; store.save(state); };

  const scheduler = new JudgeScheduler(async () => {
    const ev = state.currentTurnEvidence;
    if (!ev) return;
    // Captured now: a late reply must not touch a newer turn or newer evidence in this turn.
    const turnId = ev.turnId;
    const version = ev.version;
    if (!canJudge()) { set(markDegraded(state)); return; }
    let judgment: PetJudgment;
    try {
      judgment = await (opts.judgeImpl ?? judge)(ev, { apiKey, proxyUrl: opts.proxyUrl });
    } catch (err) {
      log(`jev failed turn=${turnId}: ${(err as Error).name}: ${(err as Error).message}`);
      set(markDegraded(state));
      return;
    }
    const { state: next, awarded, penalty, superseded } = applyJudgment(state, judgment, turnId, Date.now(), version);
    const stale = !!superseded;
    // Newer evidence arrived while Jev was thinking: judge the current snapshot next.
    if (stale && state.currentTurnEvidence?.turnId === turnId) scheduler.request();
    log(`jev turn=${turnId} v${version} activity=${judgment.activity} milestone=${judgment.milestone} p=${judgment.milestoneProbability.toFixed(2)} attention=${judgment.needsAttention.toFixed(2)} slop=${judgment.slop ?? 'none'}${judgment.slop && judgment.slop !== 'none' ? `(${(judgment.slopProbability ?? 0).toFixed(2)})` : ''} ${judgment.latencyMs ?? '?'}ms awarded=${awarded}${penalty ? ` penalty=-${penalty}` : ''}${stale ? ' (superseded, ignored)' : ''}`);
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
    if (req.method === 'POST' && url === '/appearance') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
      req.on('end', () => {
        let next: PetState | null = null;
        try { next = setAppearance(state, JSON.parse(body)); } catch { /* bad json */ }
        if (!next) return send(400, { error: 'unknown species or color' });
        set(next);
        send(200, { appearance: next.appearance });
      });
      return;
    }
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
    if (req.method === 'GET' && opts.staticDir) return serveStatic(opts.staticDir, req.url ?? '/', res);
    send(404, { error: 'not found' });
  });

  return {
    server,
    ingest,
    /** Set or clear the Jev key at runtime (the app's "Set Jev API key…" menu). */
    setApiKey: (key: string | undefined) => {
      apiKey = key || undefined;
      set(canJudge() ? { ...state, connection: 'waiting' } : markDegraded(state));
    },
    getState: () => state,
    flush: () => store.flush(),
    close: async () => { scheduler.stop(); await store.flush(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

/** PICO_JEV_PROXY (or the older BYTE_JEV_PROXY): unset → the shared proxy, "off" → none, anything else → that URL. */
export function resolveProxy(env: string | undefined): string | undefined {
  if (env === 'off') return undefined;
  return env || DEFAULT_PROXY_URL;
}

function serveStatic(dir: string, reqUrl: string, res: http.ServerResponse) {
  const rel = decodeURIComponent(reqUrl.split('?')[0]);
  const file = path.resolve(dir, '.' + (rel === '/' ? '/index.html' : rel));
  if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// Entry point: `tsx server/index.ts` (import.meta.url is empty when bundled into the app).
if (import.meta.url && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.PICO_PORT ?? process.env.BYTE_PORT ?? 4317);
  const apiKey = process.env.TYPESAFE_API_KEY || undefined;
  const proxyUrl = resolveProxy(process.env.PICO_JEV_PROXY ?? process.env.BYTE_JEV_PROXY);
  const pico = createPico({ statePath: path.join(root, '.pico', 'pet.json'), apiKey, proxyUrl });
  pico.server.listen(port, '127.0.0.1', () => {
    console.log(`[pico] listening on http://127.0.0.1:${port}  jev=${apiKey ? 'own key' : proxyUrl ? `shared proxy ${proxyUrl}` : 'OFF (degraded)'}`);
  });
}
