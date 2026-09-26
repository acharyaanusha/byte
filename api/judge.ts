/** Vercel entry for POST /api/judge: Byte's shared Jev proxy (see proxy/handler.ts). */
import { handleJudge } from '../proxy/handler.js';

export const POST = (request: Request) => handleJudge(request);
