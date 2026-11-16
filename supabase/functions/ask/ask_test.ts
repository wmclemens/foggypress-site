// Tests for the ask function without Supabase or the real model: a built site (SITE env, e.g. http://localhost:8766)
// stands in for foggypress.com, a scripted server stands in for the Messages API, and the store is in memory.
//   deno test --allow-net --allow-env --allow-read supabase/functions/ask/ask_test.ts
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { chapters, findPhrase, Library, tokens } from './books.ts';
import { toBlocks } from './answer.ts';
import { handler, type Store } from './handler.ts';

const SITE = Deno.env.get('SITE') || 'http://localhost:8766';
const eq = (a: unknown, b: unknown, what: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
};

Deno.test('chapters and phrases', () => {
  const page = '<article class="book"><header class="book-head"><h1>X</h1></header><p>Before it all.</p>' +
    '<section id="c1"><h2>Chapter 1. The <i>Start</i></h2><p>Call me Ishmael. Some years ago&mdash;never mind how long.</p></section>' +
    '<section id="c2"><h2>Two</h2><p>It’s the whale’s tale.</p></section></article>';
  const chs = chapters(page);
  eq(chs.map((c) => [c.id, c.head]), [['', 'Opening'], ['c1', 'Chapter 1. The Start'], ['c2', 'Two']], 'chapters');
  eq(findPhrase(chs[1].text, tokens('some years ago, never')).length, 1, 'phrase across a dash');
  eq(findPhrase(chs[2].text, tokens("whale's tale")).length, 1, 'possessive');
});

Deno.test('library search over the built site', async () => {
  const lib = new Library(SITE);
  const hits = await lib.phrase('call me ishmael');
  eq(hits[0]?.book.id, 'moby-dick', 'first book');
  const chs = await lib.chaptersOf(hits[0].book);
  const c = chs[hits[0].chapters[0].ci];
  eq(c.id, 'c3', 'chapter of the hit');
  const { blocks, bad } = await toBlocks(lib, 'He says so at once.\n[[quote moby-dick#c1]] Call me Ishmael. Some years ago—never mind how long precisely\n[[quote moby-dick#c3]] I am the walrus and the carpenter\n[[book moby-dick]] The whale.\n[[book not-a-book]] Gone.\n[[request Ivanhoe | Walter Scott]]');
  eq(blocks.map((b) => b.t), ['p', 'quote', 'book', 'p', 'request'], 'block kinds');
  eq(blocks[4], { t: 'request', title: 'Ivanhoe', author: 'Walter Scott' }, 'request block');
  eq(blocks[1].t === 'quote' && blocks[1].ch, 'c3', 'quote placed in its real chapter');
  eq(bad.length, 1, 'made-up quote caught');
});

// a scripted Messages API
function fakeModel(script: ((body: any) => any)[]) {
  const seen: any[] = [];
  const srv = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const body = await req.json();
    seen.push(body);
    const content = script[seen.length - 1](body);
    const stop = content.some((b: any) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    return Response.json({ id: 'msg_' + seen.length, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop,
      stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: seen.length === 1 ? 20000 : 0, cache_read_input_tokens: seen.length === 1 ? 0 : 20000 } });
  });
  return { srv, seen, url: `http://localhost:${srv.addr.port}` };
}

function memStore() {
  const s = { used: 0, limit: 3, finished: [] as number[], refunded: [] as number[], chats: new Map<string, { user: string; book: string; turns: any[] }>() };
  const store: Store = {
    user: async (jwt) => (jwt === 'good' ? 'u1' : null),
    begin: async () => (s.used >= s.limit ? { ok: false, why: 'limit', limit: s.limit, left: 0 } : { ok: true, usage_id: ++s.used, limit: s.limit, left: s.limit - s.used }),
    finish: async (id, _i, _o, cost) => { s.finished.push(cost); },
    refund: async (id) => { s.refunded.push(id); s.used--; },
    chat: async (user, id) => { const c = s.chats.get(id); return c && c.user === user ? { book_id: c.book, turns: c.turns } : null; },
    newChat: async (user, _t, book) => { const id = crypto.randomUUID(); s.chats.set(id, { user, book, turns: [] }); return id; },
    save: async (_u, chat, q, text) => { s.chats.get(chat)!.turns.push({ role: 'user', content: q }, { role: 'assistant', content: text }); },
  };
  return { s, store };
}

Deno.test('a question end to end', async () => {
  const model = fakeModel([
    () => [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu1', name: 'search_text', input: { phrase: 'driving off the spleen' } }],
    (b) => {
      const res = b.messages.at(-1).content[0];
      if (res.type !== 'tool_result' || !String(res.content).includes('moby-dick')) throw new Error('tool result missing');
      return [{ type: 'text', text: 'At the very start.\n[[quote moby-dick#c3]] It is a way I have of driving off the spleen, and regulating the circulation.\n[[quote moby-dick#c3]] Whales are fish, said nobody here.\n[[book moby-dick]] Melville\'s novel.' }];
    },
    (b) => {
      if (!String(b.messages.at(-1).content).includes('not word for word')) throw new Error('no quote check');
      return [{ type: 'text', text: 'At the very start.\n[[quote moby-dick#c3]] It is a way I have of driving off the spleen, and regulating the circulation.\n[[book moby-dick]] Melville\'s novel.' }];
    },
    (b) => {
      // second question in the same chat: the first answer is in the history, the system prompt is the same
      eq(b.messages.length, 3, 'history sent');
      return [{ type: 'text', text: 'It is the first chapter, *Loomings*.' }];
    },
  ]);
  const { s, store } = memStore();
  const client = new Anthropic({ apiKey: 'test', baseURL: model.url, maxRetries: 0 });
  const h = handler({ store, client, lib: new Library(SITE), origins: ['https://foggypress.com'] });
  const post = (body: unknown, jwt = 'good') => h(new Request('http://x/ask', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt, Origin: 'https://foggypress.com' }, body: JSON.stringify(body) }));

  eq((await post({ question: 'hi' }, 'bad')).status, 401, 'signed out');
  const r1 = await post({ question: 'Where does Ishmael say why he goes to sea?', tz: 'America/New_York' });
  const j1 = await r1.json();
  eq(r1.status, 200, 'status');
  eq(r1.headers.get('Access-Control-Allow-Origin'), 'https://foggypress.com', 'cors');
  eq(j1.blocks.map((b: any) => b.t), ['p', 'quote', 'book'], 'blocks');
  eq(j1.blocks[1].head, 'Chapter 1. Loomings', 'quote heading');
  eq(j1.left, 2, 'questions left');
  const sys = model.seen[0].system[0];
  if (!sys.cache_control || !sys.text.includes('moby-dick | Moby-Dick')) throw new Error('catalog not in cached instructions');
  eq(model.seen[0].model, 'claude-haiku-5-5', 'model');
  if ('temperature' in model.seen[0]) throw new Error('sampling parameter sent');
  // cost: 1st call 1000 in + 20000 cache write + 100 out; 2nd and 3rd 1000 in + 20000 cache read + 100 out
  const want = ((1000 * 0.1 + 20000 * 0.1 * 1.25 + 100 * 0.5) + 2 * (1000 * 0.1 + 20000 * 0.01 + 100 * 0.5)) / 1e6;
  eq(Math.abs(s.finished[0] - want) < 1e-9, true, `cost ${s.finished[0]} vs ${want}`);

  const r2 = await post({ question: 'Which chapter is that?', chat_id: j1.chat_id });
  eq((await r2.json()).chat_id, j1.chat_id, 'same chat');
  eq(model.seen[3].system[0].text, sys.text, 'instructions unchanged (cache prefix)');

  const r3 = await post({ question: 'one more' });   // the script has run out: the model call fails before anything is billed
  eq([r3.status, s.refunded.length], [503, 1], 'a failed call says busy and is refunded');
  s.used = s.limit;
  const r4 = await post({ question: 'and another' });
  eq([r4.status, (await r4.json()).error], [429, 'limit'], 'daily limit');
  await model.srv.shutdown();
});

Deno.test('the 1911 Britannica', async () => {
  const lib = new Library(SITE);
  const ref = await lib.reference();
  eq(ref?.volumes, [1], 'volumes from ask.json');
  eq((await lib.articleTitles('alhambra'))[0]?.id, 'alhambra-the', 'title search ("Alhambra, The")');
  const hits = await lib.articlePhrase('flanked by thirteen towers');
  eq(hits[0]?.art.id, 'alhambra-the', 'text search');
  const a = (await lib.article('alhambra-the'))!;
  eq((await lib.articleUrl(a)).endsWith('/britannica/alhambra-the/'), true, 'article url');
  const { blocks, bad } = await toBlocks(lib, 'From 1911:\n[[article alhambra-the]] The palace at Granada.\n[[aquote alhambra-the#]] It is enclosed by a strongly fortified wall, which is flanked by thirteen towers.\n[[aquote alhambra-the#]] A palace made of cheese.\n[[article not-an-article]] Gone.');
  eq(blocks.map((b) => b.t), ['p', 'article', 'aquote', 'p'], 'block kinds');
  eq(bad.length, 1, 'made-up article quote caught');
  const q = blocks[2] as any;
  eq([q.title, q.url.endsWith('/britannica/alhambra-the/')], ['Alhambra, The', true], 'article quote');

  // a question asked from the article page: the reference tools are offered, the article is named, the chat remembers it
  const model = fakeModel([
    (b) => {
      if (!b.tools.some((t: any) => t.name === 'read_article')) throw new Error('reference tools missing');
      if (!b.system[0].text.includes('volume 1 of 29 (1,699 articles)')) throw new Error('volumes not in rules');
      if (!String(b.messages.at(-1).content).includes('slug alhambra-the')) throw new Error('article not named');
      return [{ type: 'tool_use', id: 't1', name: 'read_article', input: { slug: 'alhambra-the' } }];
    },
    (b) => {
      const res = String(b.messages.at(-1).content[0].content);
      if (!res.includes('flanked by thirteen towers') || !res.includes('part 1 of')) throw new Error('article text missing: ' + res.slice(0, 200));
      return [{ type: 'text', text: 'A walled hilltop palace.\n[[aquote alhambra-the#]] flanked by thirteen towers' }];
    },
    (b) => {
      if (!String(b.messages.at(-1).content).includes('slug alhambra-the')) throw new Error('article lost in follow-up');
      return [{ type: 'tool_use', id: 't2', name: 'search_britannica', input: { phrase: 'Alhambra' } }];
    },
    (b) => {
      const res = String(b.messages.at(-1).content[0].content);
      if (!res.includes('Articles titled "Alhambra"') || !res.includes('slug alhambra-the')) throw new Error('search result: ' + res.slice(0, 300));
      return [{ type: 'text', text: 'Done.' }];
    },
  ]);
  const { s, store } = memStore();
  const client = new Anthropic({ apiKey: 'test', baseURL: model.url, maxRetries: 0 });
  const h = handler({ store, client, lib, origins: ['https://foggypress.com'] });
  const post = (body: unknown) => h(new Request('http://x/ask', { method: 'POST', headers: { Authorization: 'Bearer good' }, body: JSON.stringify(body) }));
  const j1 = await (await post({ question: 'Sum up this article', article_id: 'alhambra-the' })).json();
  eq(j1.blocks.map((b: any) => b.t), ['p', 'aquote'], 'answer blocks');
  eq(s.chats.get(j1.chat_id)!.book, 'eb:alhambra-the', 'chat keeps the article');
  const j2 = await (await post({ question: 'Any others?', chat_id: j1.chat_id })).json();
  eq(j2.blocks[0].text, 'Done.', 'follow-up');
  await model.srv.shutdown();
});
