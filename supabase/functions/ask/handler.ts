// The ask function's web side: who is asking, whether they have questions left, their past chat, and saving
// the answer. The database work is behind `Store`, so tests can run without Supabase (see tests/ask_test.ts).
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { answer, type Block, type Engine, type Turn, type Usage } from './answer.ts';
import { Library } from './books.ts';

export type Begin = { ok: boolean; why?: 'limit' | 'paused'; usage_id?: number; limit: number; left: number };
export interface Store {
  user(jwt: string): Promise<string | null>;                       // the reader's id, or null
  begin(user: string, tz: string): Promise<Begin>;                // counts the question (supabase/schema.sql ask_begin)
  finish(usageId: number, input: number, output: number, cost: number): Promise<void>;
  refund(usageId: number): Promise<void>;                          // nothing was spent: the question doesn't count
  chat(user: string, id: string): Promise<{ book_id: string; turns: Turn[] } | null>;
  newChat(user: string, title: string, book: string): Promise<string>;
  save(user: string, chat: string, question: string, text: string, blocks: Block[]): Promise<void>;
}

export type Config = { store: Store; client: Anthropic; lib: Library; engine?: Engine; origins: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function handler(cfg: Config) {
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

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const user = jwt ? await cfg.store.user(jwt).catch(() => null) : null;
    if (!user) return json({ error: 'signin' }, 401);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: 'bad' }, 400); }
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > 1000) return json({ error: 'bad' }, 400);
    const tz = typeof body.tz === 'string' ? body.tz.slice(0, 64) : 'UTC';
    const lang = typeof body.lang === 'string' ? body.lang.slice(0, 8) : '';
    const chatId = typeof body.chat_id === 'string' && UUID.test(body.chat_id) ? body.chat_id : '';
    const bookId = typeof body.book_id === 'string' ? body.book_id.slice(0, 120) : '';

    const begin = await cfg.store.begin(user, tz);
    if (!begin.ok) return json({ error: begin.why, limit: begin.limit, left: 0 }, 429);
    const usageId = begin.usage_id!;
    const usage: Usage = { input: 0, output: 0, cost: 0 };
    try {
      let turns: Turn[] = [], chatBook = bookId, chat = chatId;
      if (chat) {
        const c = await cfg.store.chat(user, chat);
        if (c) { turns = c.turns; chatBook = chatBook || c.book_id; } else chat = '';
      }
      const book = chatBook ? await cfg.lib.book(chatBook) : undefined;
      const out = await answer({ client: cfg.client, lib: cfg.lib, engine: cfg.engine, history: turns, question, book, lang, usage });
      await cfg.store.finish(usageId, usage.input, usage.output, Number(usage.cost.toFixed(6)));
      if (!chat) chat = await cfg.store.newChat(user, question.replace(/\s+/g, ' ').slice(0, 120), book ? book.id : '');
      await cfg.store.save(user, chat, question, out.text, out.blocks);
      return json({ chat_id: chat, blocks: out.blocks, limit: begin.limit, left: begin.left });
    } catch (e) {
      console.error('ask:', e);
      const spent = usage.input > 0;
      await (spent ? cfg.store.finish(usageId, usage.input, usage.output, Number(usage.cost.toFixed(6))) : cfg.store.refund(usageId)).catch(() => {});
      const busy = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;
      return json({ error: busy ? 'busy' : 'failed', limit: begin.limit, left: begin.left + (spent ? 0 : 1) }, busy ? 503 : 500);
    }
  };
}
