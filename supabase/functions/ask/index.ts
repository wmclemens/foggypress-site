// Ask Foggy Press, as a Supabase Edge Function. Deployed by .github/workflows/ask.yml; set up in supabase/README.md.
// Secrets (Supabase sets the first three itself): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// ANTHROPIC_API_KEY. Optional: ASK_MODEL, ASK_PRICE_IN and ASK_PRICE_OUT (dollars per million tokens) to switch
// to another model; SITE_ORIGIN (default https://foggypress.com); ASK_ORIGINS (pages allowed to call it).
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { DEFAULT_ENGINE, type Turn } from './answer.ts';
import { Library } from './books.ts';
import { handler, type Store } from './handler.ts';

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
  async begin(user, tz) { return ok(await db.rpc('ask_begin', { p_user: user, p_tz: tz })); },
  async finish(id, input, output, cost) { ok(await db.rpc('ask_finish', { p_id: id, p_in: input, p_out: output, p_cost: cost })); },
  async refund(id) { ok(await db.from('ask_usage').delete().eq('id', id)); },
  async chat(user, id) {
    const c = ok(await db.from('chats').select('book_id').eq('id', id).eq('user_id', user).maybeSingle());
    if (!c) return null;
    const rows = ok(await db.from('chat_messages').select('role,content').eq('chat_id', id).order('id', { ascending: false }).limit(10)) as Turn[];
    return { book_id: c.book_id, turns: rows.reverse() };
  },
  async newChat(user, title, book) {
    const row = ok(await db.from('chats').insert({ user_id: user, title, book_id: book }).select('id').single());
    return (row as { id: string }).id;
  },
  async save(user, chat, question, text, blocks) {
    ok(await db.from('chat_messages').insert([
      { chat_id: chat, user_id: user, role: 'user', content: question, blocks: [] },
      { chat_id: chat, user_id: user, role: 'assistant', content: text.slice(0, 20000), blocks },
    ]));
    ok(await db.from('chats').update({ updated_at: new Date().toISOString() }).eq('id', chat));
  },
};

Deno.serve(handler({
  store,
  client: new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 2, timeout: 60_000 }),
  lib: new Library(site),
  engine: {
    model: env('ASK_MODEL', DEFAULT_ENGINE.model),
    priceIn: Number(env('ASK_PRICE_IN')) || DEFAULT_ENGINE.priceIn,
    priceOut: Number(env('ASK_PRICE_OUT')) || DEFAULT_ENGINE.priceOut,
  },
  origins: env('ASK_ORIGINS', `https://${dom},https://www.${dom},https://files.${dom}`).split(',').map((s) => s.trim()).filter(Boolean),
}));
