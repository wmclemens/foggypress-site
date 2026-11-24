// My Real Books' scanner, as a Supabase Edge Function: reads a book's title page photos with Claude.
// Deployed by .github/workflows/ask.yml beside the ask function; set up in supabase/README.md ("My Real Books").
// Secrets (Supabase sets the first three itself): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// ANTHROPIC_API_KEY (shared with ask). Optional: SCAN_MODEL, SCAN_PRICE_IN and SCAN_PRICE_OUT (dollars per million
// tokens), SITE_ORIGIN (default https://foggypress.com).
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { DEFAULT_ENGINE } from './read.ts';
import { type Begin, handler, type Store } from './handler.ts';

const env = (k: string, d = '') => (Deno.env.get(k) || d).trim();
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const site = env('SITE_ORIGIN', 'https://foggypress.com');
const dom = new URL(site).hostname.replace(/^www\./, '');
const ok = <T>(r: { data: T; error: unknown }): T => { if (r.error) throw r.error; return r.data; };

const store: Store = {
  async user(jwt) {
    const r = await db.auth.getUser(jwt);
    return r.data.user ? r.data.user.id : null;
  },
  async begin(user, tz, pages) { return ok(await db.rpc('scan_begin', { p_user: user, p_tz: tz, p_pages: pages })) as Begin; },
  async finish(id, input, output, cost) { ok(await db.rpc('scan_finish', { p_id: id, p_in: input, p_out: output, p_cost: cost })); },
  async refund(id) { ok(await db.from('scan_usage').delete().eq('id', id)); },
};

Deno.serve(handler({
  store,
  client: new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 2, timeout: 60_000 }),
  engine: {
    model: env('SCAN_MODEL', DEFAULT_ENGINE.model),
    priceIn: Number(env('SCAN_PRICE_IN')) || DEFAULT_ENGINE.priceIn,
    priceOut: Number(env('SCAN_PRICE_OUT')) || DEFAULT_ENGINE.priceOut,
  },
  origins: [`https://${dom}`, `https://www.${dom}`],
}));
