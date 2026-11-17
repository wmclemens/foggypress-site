// Ask Foggy Press, as a Supabase Edge Function. Deployed by .github/workflows/ask.yml; set up in supabase/README.md.
// Secrets (Supabase sets the first three itself): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// ANTHROPIC_API_KEY. TURNSTILE_SECRET_KEY lets people ask without an account (after the Turnstile check).
// ADMIN_GITHUB_LOGINS (default wmclemens): whose GitHub token opens the admin Chat tab. Optional: ASK_MODEL,
// ASK_PRICE_IN and ASK_PRICE_OUT (dollars per million tokens) to switch to another model; SITE_ORIGIN (default https://foggypress.com); ASK_ORIGINS (pages allowed to call it).
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { DEFAULT_ENGINE, type Turn } from './answer.ts';
import { Library } from './books.ts';
import { type Asker, type Begin, handler, sha256, type Status, type Store } from './handler.ts';

const env = (k: string, d = '') => (Deno.env.get(k) || d).trim();
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const site = env('SITE_ORIGIN', 'https://foggypress.com');
const dom = new URL(site).hostname.replace(/^www\./, '');

const ok = <T>(r: { data: T; error: unknown }): T => { if (r.error) throw r.error; return r.data; };

// guests' chats are matched by the hash of the key the page holds; readers' by their account
// (a query builder must not be returned from an async function: awaiting it would run it)
async function own(who: Asker, key: string) {
  const h = who.guest ? (key ? await sha256(key) : '-') : '';
  // deno-lint-ignore no-explicit-any
  return (q: any) => (who.user ? q.eq('user_id', who.user) : q.is('user_id', null).eq('guest_key', h));
}

const store: Store = {
  async user(jwt) {
    const r = await db.auth.getUser(jwt);
    return r.data.user ? r.data.user.id : null;
  },
  async begin(who, tz, place) {
    const b = who.user
      ? ok(await db.rpc('ask_begin', { p_user: who.user, p_tz: tz }))
      : ok(await db.rpc('ask_begin_guest', { p_visitor: who.guest, p_tz: tz, p_place: place }));
    // where it was asked (home page, Ask page, a book, an article), for the admin Chat tab
    if (who.user && (b as Begin).usage_id) await db.from('ask_usage').update({ place }).eq('id', (b as Begin).usage_id).then(() => {}, () => {});
    return b as Begin;
  },
  async finish(id, input, output, cost) { ok(await db.rpc('ask_finish', { p_id: id, p_in: input, p_out: output, p_cost: cost })); },
  async refund(id) { ok(await db.from('ask_usage').delete().eq('id', id)); },
  async chat(who, id, key) {
    if (who.guest && !key) return null;
    const mine = await own(who, key);
    const c = ok(await mine(db.from('chats').select('book_id').eq('id', id)).maybeSingle());
    if (!c) return null;
    const rows = ok(await db.from('chat_messages').select('role,content').eq('chat_id', id).order('id', { ascending: false }).limit(10)) as Turn[];
    return { book_id: (c as { book_id: string }).book_id, turns: rows.reverse() };
  },
  async newChat(who, title, book, keyHash) {
    // (guest_key only for guests, so readers' chats still save before schema.sql's 17 Nov additions are run)
    const row = ok(await db.from('chats').insert(who.user ? { user_id: who.user, title, book_id: book } : { user_id: null, guest_key: keyHash, title, book_id: book }).select('id').single());
    return (row as { id: string }).id;
  },
  async save(who, chat, question, text, blocks) {
    const u = who.user ?? null;
    const rows = ok(await db.from('chat_messages').insert([
      { chat_id: chat, user_id: u, role: 'user', content: question, blocks: [] },
      { chat_id: chat, user_id: u, role: 'assistant', content: text.slice(0, 20000), blocks },
    ]).select('id,role')) as { id: number; role: string }[];
    ok(await db.from('chats').update({ updated_at: new Date().toISOString() }).eq('id', chat));
    return rows.find((r) => r.role === 'assistant')?.id ?? null;
  },
  async guestStatus(visitor, tz) { return ok(await db.rpc('ask_guest_status', { p_visitor: visitor, p_tz: tz })) as Status; },
  async rate(who, chat, key, message, rating, note) {
    const mine = await own(who, key);
    const c = ok(await mine(db.from('chats').select('id').eq('id', chat)).maybeSingle());
    if (!c) return false;
    const rows = ok(await db.from('chat_messages').update(rating ? { rating, rating_note: rating < 0 ? note : '', rated_at: new Date().toISOString() } : { rating: null, rating_note: '', rated_at: null })
      .eq('id', message).eq('chat_id', chat).eq('role', 'assistant').select('id')) as unknown[];
    return rows.length === 1;
  },
  async report() { return ok(await db.rpc('ask_admin_report')); },
};

// Turnstile: Cloudflare says whether the token came from a person on one of our pages
const TS_SECRET = env('TURNSTILE_SECRET_KEY');
async function human(token: string, ip: string) {
  const form = new FormData();
  form.set('secret', TS_SECRET); form.set('response', token);
  if (ip) form.set('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const j = await r.json();
  return !!j.success && (!j.hostname || j.hostname === dom || String(j.hostname).endsWith('.' + dom) || j.hostname === 'localhost');
}

// the admin page signs in with a GitHub token; it must belong to one of these GitHub accounts
const ADMINS = env('ADMIN_GITHUB_LOGINS', 'wmclemens').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const adminSeen = new Map<string, number>();
async function admin(gh: string) {
  const k = await sha256(gh);
  if ((adminSeen.get(k) || 0) > Date.now()) return true;
  const r = await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + gh, 'User-Agent': 'foggypress-ask', Accept: 'application/vnd.github+json' } });
  if (!r.ok) return false;
  const login = String((await r.json()).login || '').toLowerCase();
  if (!ADMINS.includes(login)) return false;
  adminSeen.set(k, Date.now() + 10 * 60_000);
  return true;
}

Deno.serve(handler({
  store,
  client: new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 2, timeout: 60_000 }),
  lib: new Library(site),
  engine: {
    model: env('ASK_MODEL', DEFAULT_ENGINE.model),
    priceIn: Number(env('ASK_PRICE_IN')) || DEFAULT_ENGINE.priceIn,
    priceOut: Number(env('ASK_PRICE_OUT')) || DEFAULT_ENGINE.priceOut,
  },
  // guests (no account) can ask once the Turnstile secret is set; the service key signs their passes
  secret: TS_SECRET ? env('SUPABASE_SERVICE_ROLE_KEY') + '|' + TS_SECRET : undefined,
  human: TS_SECRET ? human : undefined,
  admin,
  origins: env('ASK_ORIGINS', `https://${dom},https://www.${dom},https://files.${dom}`).split(',').map((s) => s.trim()).filter(Boolean),
}));
