// My Real Books: one book's photos in (its title page, the back of it, any other page that matters), the book's
// details out. Claude reads the pages and fills in a form (a tool it must call), so the answer always has the
// same fields. Nothing is guessed: a field not printed on the pages stays empty.
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';

export type Engine = { model: string; priceIn: number; priceOut: number };   // prices: dollars per million tokens
export const DEFAULT_ENGINE: Engine = { model: 'claude-haiku-5-5', priceIn: 0.10, priceOut: 0.50 };
export type Usage = { input: number; output: number; cost: number };
export type Photo = { type: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };   // base64

export type Book = {
  pages: number[];
  title: string; subtitle: string;
  author_last: string; author_first: string; other_authors: string; contributors: string;
  publisher: string; place: string; year: number | null;
  edition: string; volume: string; isbn: string; language: string;
  subjects: string[]; lc_call: string; dewey: string; tags: string[];
  inscription: string;
  unsure: string[];
};
export type Reading = { books: Book[]; not_a_book: boolean };

const TEXT_FIELDS = ['title', 'subtitle', 'author_last', 'author_first', 'other_authors', 'contributors', 'publisher', 'place',
  'edition', 'volume', 'isbn', 'language', 'lc_call', 'dewey', 'inscription'] as const;
const FIELDS = [...TEXT_FIELDS, 'year', 'subjects', 'tags'];

const RULES = `You catalogue books from photos of their opening pages, for a reader's list of the books they own. The photos are of one book: usually its title page and the back of the title page (the copyright page), sometimes a half-title or another page. Read them and call record_books once.

Rules
- Use only what is printed or written on these pages. Never fill a field from what you know about the book, except the Library of Congress class and subjects (below). Leave a field empty ("" or null or []) when the pages don't show it.
- If the photos clearly show two or more different books (different titles or authors on two title pages), record each book separately and say which photos (counted from 0) belong to it. Two volumes of one work are separate books. Otherwise record one book with every photo in it.
- If no photo shows a book's pages (a cover with no title page is fine, a photo of something else is not), set not_a_book to true and record no books.
- title: the main title, in the book's own capitalization turned into normal title case (not ALL CAPS). subtitle: the rest of the title (e.g. "The Story of San Francisco Harbor", "A Novel", "Ao Tea Roa").
- author: split the first author's name into author_last (the name to alphabetize by) and author_first (the rest). Leave out "By", honorifics and degrees ("The Hon.", "LL.D.", "U.S.N.", "K.G."); keep "Jr." in author_first. A nobleman named by title ("Viscount Grey of Fallodon"): author_last "Grey", author_first "Viscount Grey of Fallodon". No author but an editor: the editor goes in author_last/author_first and in contributors. other_authors: any further authors, as printed, in normal capitalization.
- contributors: editors, translators, illustrators, introductions, as one short line ("edited by Charles D. Ellis; introduction by Peter Grilli").
- publisher: the publisher's name as printed, in normal capitalization ("T. Nelson and Sons", "Houghton Mifflin Company"). place: the city or cities of publication ("London", "Boston"). Not the printer.
- year: the year this edition was published, as a number. Roman numerals become ordinary numbers (MDCCCLXI is 1861). Take the date on the title page; if there is none, the date of this edition or printing on the back ("First American Edition 1999", "Fourth edition 1950", the Cataloging-in-Publication date); if there is none, the latest copyright year. Never a renewal date.
- edition: the edition statement as printed, short ("First edition", "Fourth edition", "Revised and enlarged edition", "A Limited Edition", "With the author's latest additions"). volume: "Vol. I" etc. when the page says so.
- isbn: as printed, with its hyphens. language: the book's language in English ("English", "French").
- From the Library of Congress Cataloging-in-Publication block, if there is one: subjects = the numbered subject headings exactly as printed, with "--" for each dash (not "I. Title" or the person entries); lc_call = the call number (e.g. "PS3566.A559"); dewey = the Dewey number (e.g. "813.54").
- If there is no Cataloging-in-Publication block, or it has no call number or no subject headings, fill what is missing from your own judgement of the book (this is the one exception to using only what is printed): lc_call = the Library of Congress class the book would be shelved under, as its letters and, if you are confident, the class number (e.g. "PS" for an American novel, "PR" for an English one, "QK" for botany, "F868" for a history of California, "E467" for a Civil War biography); subjects = up to 3 Library of Congress subject headings in LC's own form, with "--" between the parts ("California -- History -- To 1846", "Sea stories"). Then put "lc_call" and "subjects" in unsure, so the reader knows they were judged, not read.
- tags: up to 6 short tags from the subject headings: the main heading of each, without dates or subdivisions ("Investments", "Risk management", "Japan", "Air pilots"). Empty when there are no subject headings.
- inscription: any handwriting on the pages (an owner's name, a signature, a dedication), transcribed as well as you can ("B. B. Torrey"). Empty if none.
- unsure: the names of any fields you filled but could not read with confidence (blurry, cut off, unusual type), e.g. ["year", "publisher"].`;

const str = { type: 'string' } as const;
const TOOL: Anthropic.Tool = {
  name: 'record_books',
  description: 'Record the books shown in the photos.',
  input_schema: {
    type: 'object',
    properties: {
      not_a_book: { type: 'boolean', description: 'True when no photo shows the pages of a book.' },
      books: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pages: { type: 'array', items: { type: 'integer' }, description: 'The photos (from 0) that show this book.' },
            title: str, subtitle: str, author_last: str, author_first: str, other_authors: str, contributors: str,
            publisher: str, place: str, year: { type: ['integer', 'null'] }, edition: str, volume: str, isbn: str, language: str,
            subjects: { type: 'array', items: str }, lc_call: str, dewey: str, tags: { type: 'array', items: str },
            inscription: str, unsure: { type: 'array', items: str },
          },
          required: ['pages', 'title', 'author_last', 'author_first', 'publisher', 'place', 'year'],
        },
      },
    },
    required: ['not_a_book', 'books'],
  },
};

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const list = (v: unknown, each: number, most: number) =>
  Array.isArray(v) ? [...new Set(v.map((x) => clip(x, each)).filter(Boolean))].slice(0, most) : [];
// a year written as Roman numerals, in case one comes back as text
export function roman(s: string): number | null {
  const v: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const t = s.toUpperCase().replace(/[^IVXLCDM]/g, '');
  if (!t || t !== s.toUpperCase().replace(/[\s.]/g, '')) return null;
  let n = 0;
  for (let i = 0; i < t.length; i++) n += v[t[i]] < (v[t[i + 1]] || 0) ? -v[t[i]] : v[t[i]];
  return n;
}
function year(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number') n = Math.round(v);
  else if (typeof v === 'string') n = /^\d{4}$/.test(v.trim()) ? Number(v.trim()) : roman(v);
  return n && n >= 1000 && n <= new Date().getFullYear() + 1 ? n : null;
}

// the model's form, tidied: lengths capped to what the database takes, pages that exist, a year that is a year
export function tidy(raw: unknown, photos: number): Reading {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const books = (Array.isArray(r.books) ? r.books : []).slice(0, 4).map((x) => {
    const b = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of TEXT_FIELDS) out[k] = clip(b[k], k === 'contributors' ? 1000 : k === 'volume' ? 100 : k === 'isbn' ? 40 : 300);
    out.year = year(b.year);
    out.subjects = list(b.subjects, 200, 30);
    out.tags = list(b.tags, 60, 6);
    const pages = Array.isArray(b.pages) ? b.pages.filter((p) => Number.isInteger(p) && p >= 0 && p < photos) : [];
    out.pages = pages.length ? [...new Set(pages as number[])] : [];
    out.unsure = list(b.unsure, 30, 20).filter((f) => FIELDS.includes(f) || f === 'author');
    return out as Book;
  }).filter((b) => b.title);
  // one book: it has every photo
  if (books.length === 1) books[0].pages = [...Array(photos).keys()];
  return { books, not_a_book: books.length === 0 };
}

export async function read(opts: { client: Anthropic; engine?: Engine; photos: Photo[]; usage: Usage }): Promise<Reading> {
  const engine = opts.engine || DEFAULT_ENGINE;
  const content: Anthropic.ContentBlockParam[] = [];
  opts.photos.forEach((p, i) => {
    content.push({ type: 'text', text: `Photo ${i}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: p.type, data: p.data } });
  });
  content.push({ type: 'text', text: 'Record the book (or books) in these photos.' });
  const msg = await opts.client.messages.create({
    model: engine.model,
    max_tokens: 1500,
    system: RULES,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content }],
  });
  opts.usage.input += msg.usage.input_tokens;
  opts.usage.output += msg.usage.output_tokens;
  opts.usage.cost = (opts.usage.input * engine.priceIn + opts.usage.output * engine.priceOut) / 1e6;
  const call = msg.content.find((c) => c.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
  return tidy(call ? call.input : null, opts.photos.length);
}
