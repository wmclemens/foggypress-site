// The ask function's web side: who is asking, whether they have questions left, their past chat, saving the
// answer, thumbs up or down on an answer, and the admin Chat tab's figures. The database work is behind `Store`,
// so tests can run without Supabase (see ask_test.ts).
//
// Who may ask (17 Nov 2026):
//  - a signed-in reader (Authorization: Bearer <their Supabase token>). They passed the Turnstile check when they
//    signed in, so there is no check here; the daily limit is per account (ask_config.daily_limit).
//  - anyone else, as a guest, once the Turnstile "are you human" check passes: the page sends a Turnstile token,
//    the function checks it with Cloudflare and hands back a pass that is good for PASS_HOURS from that internet
//    address. The daily limit is per address (ask_config.guest_daily_limit, counted by a scrambled form of the
//    address), and all guests together have a daily ceiling (ask_config.guests_daily_cap) as a backstop.
//    Guest chats are kept 30 days, without any name; the page holds the chat's key.
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { answer, type Block, type Engine, type Turn, type Usage } from './answer.ts';
import { Library } from './books.ts';

export type Asker = { user: string; guest?: undefined } | { guest: string; user?: undefined };
export type Begin = { ok: boolean; why?: 'limit' | 'paused' | 'guests'; usage_id?: number; limit: number; left: number };
export type Status = { limit: number; left: number; open: boolean; guests: boolean };
export interface Store {
  user(jwt: string): Promise<string | null>;                       // the reader's id, or null
  begin(who: Asker, tz: string, place: string): Promise<Begin>;   // counts the question (schema.sql ask_begin / ask_begin_guest)
  finish(usageId: number, input: number, output: number, cost: number): Promise<void>;
  refund(usageId: number): Promise<void>;                          // nothing was spent: the question doesn't count
  chat(who: Asker, id: string, key: string): Promise<{ book_id: string; turns: Turn[] } | null>;
  newChat(who: Asker, title: string, book: string, keyHash: string): Promise<string>;
  save(who: Asker, chat: string, question: string, text: string, blocks: Block[]): Promise<number | null>;  // the answer's message id
  guestStatus(visitor: string, tz: string): Promise<Status>;
  rate(who: Asker, chat: string, key: string, message: number, rating: number, note: string): Promise<boolean>;
  report(): Promise<unknown>;                                      // the admin Chat tab (schema.sql ask_admin_report)
}

export type Config = {
  store: Store; client: Anthropic; lib: Library; engine?: Engine; origins: string[];
  // guests: both must be set, or only signed-in readers can ask (as before 17 Nov 2026)
  secret?: string;                                                  // signs the guest pass; also salts the address
  human?: (token: string, ip: string) => Promise<boolean>;          // the Turnstile check (Cloudflare siteverify)
  admin?: (githubToken: string) => Promise<boolean>;                // is this the site's owner (admin page's GitHub token)
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASS_HOURS = 6;
// guests whose browser says it is a robot are turned away before anything else (build/bots.py has the long list)
const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|scrape|curl|wget|python|httpx|aiohttp|go-http|java\/|okhttp|node-fetch|axios|headless|phantom|puppeteer|playwright|selenium|gpt|claude|anthropic|perplexity|bytespider|ccbot/i;
const PLACES = new Set(['home', 'ask', 'book', 'article']);

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(secret: string, s: string) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(s)));
}
function clientIp(req: Request) {
  return (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || '').trim();
}
const newKey = () => hex(crypto.getRandomValues(new Uint8Array(24)).buffer);

export function handler(cfg: Config) {
  const guestsOn = !!(cfg.secret && cfg.human);
  async function makePass(visitor: string) {
    const exp = Math.floor(Date.now() / 1000) + PASS_HOURS * 3600;
    return `${exp}.${await hmac(cfg.secret!, `pass|${visitor}|${exp}`)}`;
  }
  async function passOk(pass: string, visitor: string) {
    const [exp, sig] = pass.split('.');
    if (!exp || !sig || +exp < Date.now() / 1000) return false;
    return sig === await hmac(cfg.secret!, `pass|${visitor}|${exp}`);
  }

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

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: 'bad' }, 400); }
    const str = (k: string, n: number) => (typeof body[k] === 'string' ? (body[k] as string).slice(0, n) : '');
    const op = str('op', 16) || 'ask';
    const tz = str('tz', 64) || 'UTC';

    // ---- the admin page's Chat tab: the site owner's GitHub token, checked with GitHub ----
    if (op === 'admin') {
      const gh = str('gh', 400);
      if (!gh || !cfg.admin || !(await cfg.admin(gh).catch(() => false))) return json({ error: 'admin' }, 403);
      try { return json(await cfg.store.report()); } catch (e) { console.error('ask admin:', e); return json({ error: 'failed' }, 500); }
    }

    // ---- who is asking ----
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const user = jwt ? await cfg.store.user(jwt).catch(() => null) : null;
    let who: Asker;
    let pass = '';
    if (user) who = { user };
    else {
      if (!guestsOn) return json({ error: 'signin' }, 401);
      if (BOT_UA.test(req.headers.get('User-Agent') || '')) return json({ error: 'signin' }, 401);
      const visitor = (await sha256(`${cfg.secret}|${clientIp(req) || 'unknown'}`)).slice(0, 32);
      who = { guest: visitor };
      if (op === 'status') {
        try { return json(await cfg.store.guestStatus(visitor, tz)); } catch { return json({ limit: 0, left: 0, open: false, guests: false }); }
      }
      // the human check: a pass from earlier, or a fresh Turnstile token
      const p = str('pass', 200), ts = str('ts', 4096);
      if (p && await passOk(p, visitor)) pass = p;
      else if (ts && await cfg.human!(ts, clientIp(req)).catch(() => false)) pass = await makePass(visitor);
      else return json({ error: 'check' }, 403);
    }
    if (op === 'status') return json({ error: 'bad' }, 400);   // signed-in readers read ask_status() directly

    const chatId = UUID.test(str('chat_id', 36)) ? str('chat_id', 36) : '';
    const chatKey = /^[0-9a-f]{48}$/.test(str('chat_key', 48)) ? str('chat_key', 48) : '';

    // ---- thumbs up or down on an answer ----
    if (op === 'rate') {
      const mid = Number(body.message_id), rating = Number(body.rating);
      if (!chatId || !Number.isInteger(mid) || mid <= 0 || ![1, -1, 0].includes(rating)) return json({ error: 'bad' }, 400);
      const ok = await cfg.store.rate(who, chatId, chatKey, mid, rating, str('note', 500).trim()).catch((e) => { console.error('ask rate:', e); return false; });
      return ok ? json({ ok: true, pass: pass || undefined }) : json({ error: 'failed' }, 404);
    }
    if (op !== 'ask') return json({ error: 'bad' }, 400);

    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > 1000) return json({ error: 'bad' }, 400);
    const lang = str('lang', 8);
    const bookId = str('book_id', 120);
    // a Britannica article page: kept with the chat as "eb:<slug>"
    const articleId = str('article_id', 116) ? 'eb:' + str('article_id', 116) : '';
    const place = PLACES.has(str('place', 16)) ? str('place', 16) : articleId ? 'article' : bookId ? 'book' : 'ask';

    const begin = await cfg.store.begin(who, tz, place);
    if (!begin.ok) return json({ error: begin.why, limit: begin.limit, left: 0, pass: pass || undefined }, 429);
    const usageId = begin.usage_id!;
    const usage: Usage = { input: 0, output: 0, cost: 0 };
    try {
      let turns: Turn[] = [], chatBook = articleId || bookId, chat = chatId, key = chatKey;
      if (chat) {
        const c = await cfg.store.chat(who, chat, key);
        if (c) { turns = c.turns; chatBook = chatBook || c.book_id; } else chat = '';
      }
      const isArt = chatBook.startsWith('eb:');
      const book = chatBook && !isArt ? await cfg.lib.book(chatBook) : undefined;
      const article = isArt ? await cfg.lib.article(chatBook.slice(3)).catch(() => undefined) : undefined;
      const out = await answer({ client: cfg.client, lib: cfg.lib, engine: cfg.engine, history: turns, question, book, article, lang, usage });
      await cfg.store.finish(usageId, usage.input, usage.output, Number(usage.cost.toFixed(6)));
      if (!chat) {
        key = who.guest ? newKey() : '';
        chat = await cfg.store.newChat(who, question.replace(/\s+/g, ' ').slice(0, 120), article ? 'eb:' + article.id : book ? book.id : '', key ? await sha256(key) : '');
      }
      const mid = await cfg.store.save(who, chat, question, out.text, out.blocks);
      return json({ chat_id: chat, chat_key: key || undefined, message_id: mid ?? undefined, blocks: out.blocks, limit: begin.limit, left: begin.left, pass: pass || undefined });
    } catch (e) {
      console.error('ask:', e);
      const spent = usage.input > 0;
      await (spent ? cfg.store.finish(usageId, usage.input, usage.output, Number(usage.cost.toFixed(6))) : cfg.store.refund(usageId)).catch(() => {});
      const busy = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;
      return json({ error: busy ? 'busy' : 'failed', limit: begin.limit, left: begin.left + (spent ? 0 : 1), pass: pass || undefined }, busy ? 503 : 500);
    }
  };
}
