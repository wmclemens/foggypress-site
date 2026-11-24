// The scan function's web side: who is scanning, whether they have scans left, the photos' size, and the answer.
// The database work is behind `Store`, so tests run without Supabase (scan_test.ts). Photos are never stored: they
// are read from the request, sent to the model, and dropped when the request ends.
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { type Engine, type Photo, read, type Reading, type Usage } from './read.ts';

export type Begin = { ok: boolean; why?: 'limit' | 'minute' | 'paused'; usage_id?: number; limit: number; left: number | null; unlimited?: boolean };
export interface Store {
  user(jwt: string): Promise<string | null>;                                   // the reader's id, or null
  begin(user: string, tz: string, pages: number): Promise<Begin>;              // schema.sql scan_begin
  finish(usageId: number, input: number, output: number, cost: number): Promise<void>;
  refund(usageId: number): Promise<void>;                                      // nothing was spent: the scan doesn't count
}
export type Config = { store: Store; client: Anthropic; engine?: Engine; origins: string[]; reader?: typeof read };

export const MAX_PHOTOS = 4;
export const MAX_PHOTO_BYTES = 2_000_000;     // each photo after decoding; the page sends about 300 KB
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// what a photo really is, from its first bytes (not what the page says it is)
function sniff(b64: string): Photo['type'] | null {
  let head: string;
  try { head = atob(b64.slice(0, 16)); } catch { return null; }
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('\x89PNG')) return 'image/png';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function handler(cfg: Config) {
  const reader = cfg.reader || read;
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('Origin') || '';
    const cors: Record<string, string> = {
      'Access-Control-Allow-Origin': cfg.origins.includes(origin) ? origin : cfg.origins[0] || '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin',
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    if (Number(req.headers.get('Content-Length') || 0) > MAX_PHOTOS * MAX_PHOTO_BYTES * 1.4 + 10_000) return json({ error: 'size' }, 413);

    // only signed-in readers (they passed the Turnstile check when they signed in)
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const user = jwt ? await cfg.store.user(jwt).catch(() => null) : null;
    if (!user) return json({ error: 'signin' }, 401);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: 'bad' }, 400); }
    const tz = typeof body.tz === 'string' ? body.tz.slice(0, 64) : 'UTC';
    const raw = Array.isArray(body.photos) ? body.photos : [];
    if (!raw.length || raw.length > MAX_PHOTOS) return json({ error: 'bad' }, 400);
    const photos: Photo[] = [];
    for (const p of raw) {
      const data = typeof p === 'string' ? p.replace(/^data:[^,]*,/, '') : '';
      const type = sniff(data);
      if (!type || !TYPES.has(type)) return json({ error: 'type' }, 415);
      if (data.length * 0.75 > MAX_PHOTO_BYTES) return json({ error: 'size' }, 413);
      photos.push({ type, data });
    }

    const begin = await cfg.store.begin(user, tz, photos.length);
    if (!begin.ok) return json({ error: begin.why, limit: begin.limit, left: 0 }, 429);
    const usageId = begin.usage_id!;
    const usage: Usage = { input: 0, output: 0, cost: 0 };
    try {
      const out: Reading = await reader({ client: cfg.client, engine: cfg.engine, photos, usage });
      await cfg.store.finish(usageId, usage.input, usage.output, Number(usage.cost.toFixed(6)));
      return json({ ...out, limit: begin.limit, left: begin.left, unlimited: !!begin.unlimited });
    } catch (e) {
      console.error('scan:', e);
      const spent = usage.input > 0;
      await (spent ? cfg.store.finish(usageId, usage.input, usage.output, Number(usage.cost.toFixed(6))) : cfg.store.refund(usageId)).catch(() => {});
      const busy = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;
      return json({ error: busy ? 'busy' : 'failed' }, busy ? 503 : 500);
    }
  };
}
