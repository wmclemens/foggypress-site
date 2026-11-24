// deno test --allow-net --allow-env --allow-read supabase/functions/scan/scan_test.ts
// The scan function with a stand-in database and a stand-in Claude: no network, no Supabase.
import { assert, assertEquals } from 'jsr:@std/assert@1';
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { handler, type Store } from './handler.ts';
import { roman, tidy } from './read.ts';

const JPEG = btoa('\xff\xd8\xff\xe0' + 'x'.repeat(200));
const PNG = btoa('\x89PNG\r\n\x1a\n' + 'x'.repeat(200));
const NOT_IMAGE = btoa('<html>hello</html>');

function fakeStore(left = 5) {
  const log: string[] = [];
  const store: Store = {
    async user(jwt) { return jwt === 'good' ? 'u1' : null; },
    async begin(_u, _tz, pages) { log.push('begin ' + pages); return left > 0 ? { ok: true, usage_id: 7, limit: 300, left: --left } : { ok: false, why: 'limit', limit: 300, left: 0 }; },
    async finish(id, i, o, c) { log.push(`finish ${id} ${i} ${o} ${c}`); },
    async refund(id) { log.push('refund ' + id); },
  };
  return { store, log };
}
// a stand-in for the Claude client: answers with the given form, or throws
function fakeClient(form: unknown, fail?: Error) {
  const seen: unknown[] = [];
  const client = {
    messages: {
      async create(req: unknown) {
        seen.push(req);
        if (fail) throw fail;
        return { usage: { input_tokens: 3000, output_tokens: 300 }, content: [{ type: 'tool_use', id: 't', name: 'record_books', input: form }] };
      },
    },
  } as unknown as Anthropic;
  return { client, seen };
}
const post = (body: unknown, jwt = 'good') => new Request('https://x/functions/v1/scan', {
  method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json', Origin: 'https://foggypress.com' }, body: JSON.stringify(body),
});
const ORIGINS = ['https://foggypress.com'];

const MAURY = { pages: [0], title: 'The Physical Geography of the Sea', author_last: 'Maury', author_first: 'M. F.', publisher: 'T. Nelson and Sons',
  place: 'London', year: 'MDCCCLXI', edition: "With the author's latest additions", subjects: [], tags: [] };

Deno.test('needs a signed-in reader', async () => {
  const { store, log } = fakeStore(); const { client } = fakeClient({ not_a_book: false, books: [MAURY] });
  const r = await handler({ store, client, origins: ORIGINS })(post({ photos: [JPEG] }, 'bad'));
  assertEquals(r.status, 401); assertEquals(log, []);
});

Deno.test('refuses things that are not photos, and too many photos, before counting a scan', async () => {
  const { store, log } = fakeStore(); const { client, seen } = fakeClient({ not_a_book: false, books: [MAURY] });
  const h = handler({ store, client, origins: ORIGINS });
  assertEquals((await h(post({ photos: [NOT_IMAGE] }))).status, 415);
  assertEquals((await h(post({ photos: [JPEG, JPEG, JPEG, JPEG, JPEG] }))).status, 400);
  assertEquals((await h(post({ photos: [] }))).status, 400);
  assertEquals((await h(post({ photos: [btoa('\xff\xd8\xff' + 'x'.repeat(2_100_000))] }))).status, 413);
  assertEquals(log, []); assertEquals(seen.length, 0);
});

Deno.test('reads a book: Roman numeral year becomes a number, the scan is counted with its cost', async () => {
  const { store, log } = fakeStore(); const { client, seen } = fakeClient({ not_a_book: false, books: [MAURY] });
  const r = await handler({ store, client, origins: ORIGINS })(post({ photos: ['data:image/jpeg;base64,' + JPEG, PNG], tz: 'America/Los_Angeles' }));
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(j.books.length, 1);
  assertEquals(j.books[0].year, 1861);
  assertEquals(j.books[0].pages, [0, 1]);        // one book has every photo
  assertEquals(j.left, 4);
  assertEquals(log, ['begin 2', 'finish 7 3000 300 0.00045']);
  // the model got both photos, typed by their bytes, and had to fill in the form
  // deno-lint-ignore no-explicit-any
  const req = seen[0] as any;
  assertEquals(req.tool_choice, { type: 'tool', name: 'record_books' });
  assertEquals(req.messages[0].content.filter((c: { type: string }) => c.type === 'image').map((c: { source: { media_type: string } }) => c.source.media_type), ['image/jpeg', 'image/png']);
});

Deno.test('the daily limit answers 429 without asking the model', async () => {
  const { store } = fakeStore(0); const { client, seen } = fakeClient({ not_a_book: false, books: [MAURY] });
  const r = await handler({ store, client, origins: ORIGINS })(post({ photos: [JPEG] }));
  assertEquals(r.status, 429); assertEquals((await r.json()).error, 'limit'); assertEquals(seen.length, 0);
});

Deno.test('a failed call before the model answered is refunded', async () => {
  const { store, log } = fakeStore(); const { client } = fakeClient(null, new Error('boom'));
  const r = await handler({ store, client, origins: ORIGINS })(post({ photos: [JPEG] }));
  assertEquals(r.status, 500); assertEquals(log, ['begin 1', 'refund 7']);
});

Deno.test('tidy: two books in one stack keep their own photos; junk is cleaned', () => {
  const r = tidy({ not_a_book: false, books: [
    { ...MAURY, pages: [0, 9], year: 1861.4, tags: ['Oceanography', 'Oceanography', ''], unsure: ['year', 'nonsense'] },
    { pages: [1], title: 'Wind, Sand and Stars', author_last: 'Saint-Exupéry', author_first: 'Antoine de', publisher: 'Harcourt Brace', place: '', year: 1992,
      subjects: ['Air pilots--France--Biography.'], tags: ['Air pilots'], isbn: '0-15-197087-4' },
    { pages: [1], title: '', author_last: 'Nobody' },
  ] }, 2);
  assertEquals(r.books.length, 2);
  assertEquals(r.books[0].pages, [0]);
  assertEquals(r.books[0].year, 1861);
  assertEquals(r.books[0].tags, ['Oceanography']);
  assertEquals(r.books[0].unsure, ['year']);
  assertEquals(r.books[1].pages, [1]);
  assertEquals(r.not_a_book, false);
});

Deno.test('tidy: nothing readable is "not a book"; years must be years', () => {
  assertEquals(tidy({ not_a_book: true, books: [] }, 1), { books: [], not_a_book: true });
  assertEquals(tidy(null, 1).not_a_book, true);
  assertEquals(tidy({ books: [{ title: 'X', year: 'about 1900' }] }, 1).books[0].year, null);
  assertEquals(tidy({ books: [{ title: 'X', year: 3000 }] }, 1).books[0].year, null);
  assertEquals(roman('MCMXXV'), 1925); assertEquals(roman('MDCCCLXI'), 1861); assertEquals(roman('1925'), null);
  assert(tidy({ books: [{ title: 'X'.repeat(900) }] }, 1).books[0].title.length <= 300);
});
