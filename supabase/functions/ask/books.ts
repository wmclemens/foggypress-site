// The Foggy Press library as the ask function sees it: the catalog, the full-text index and the read-online
// pages, all fetched from the public site (the same files the site's own search uses; see build/search_index.py).

export type Book = {
  id: string; t: string; a: string; al?: string; tr?: string; d?: string; desc?: string; tg?: string[];
  pdf?: string; read?: boolean; rd?: string; epub?: string; ch?: [string, string][];
};
export type Chapter = { id: string; head: string; text: string };
export type Hit = { book: Book; chapters: { ci: number; n: number }[]; n: number };

// keep in step with STOP in build/search_index.py
const STOP = new Set(('a about after all also an and any are as at be been but by can could did do does for from had has have he her ' +
  'him his how i if in into is it its may me more most my no not now of on one only or our out over she so some such than that the ' +
  'their them then there these they this those to up upon us was we were what when where which who whom why will with would you your').split(' '));

// the index's folding (build/search_index.py fold)
export function fold(s: string): string {
  s = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’‘]/g, "'").replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss');
  return s.replace(/'s\b/g, '').replace(/'/g, '');
}
export function tokens(s: string): string[] { return fold(s).match(/[a-z0-9]+/g) || []; }
const indexed = (w: string) => w.length > 1 && !STOP.has(w);

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };
function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function plain(fragment: string): string { return unescape(fragment.replace(/<[^>]+>/g, ' ')); }
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

// the chapters of a read-online page, cut exactly as build/search_index.py chapters() cuts them, so that
// chapter numbers in the index match
export function chapters(page: string): Chapter[] {
  const m = page.match(/<article class="book"[\s\S]*<\/article>/);
  let art = m ? m[0] : page;
  art = art.replace(/<details class="toc">[\s\S]*?<\/details>/g, '').replace(/<header class="book-head">[\s\S]*?<\/header>/, '');
  const out: Chapter[] = [];
  const first = art.indexOf('<section id=');
  const lead = plain(first >= 0 ? art.slice(0, first) : art);
  if (tokens(lead).some(indexed)) out.push({ id: '', head: 'Opening', text: squash(lead) });
  const rx = /<section id="([^"]+)"[^>]*>([\s\S]*?)(?=<section id=|<\/article>)/g;
  let s: RegExpExecArray | null;
  while ((s = rx.exec(art))) {
    const h = s[2].match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    out.push({ id: s[1], head: h ? squash(plain(h[1])) : '', text: squash(plain(s[2])) });
  }
  return out;
}

// the folded text of s, with at[i] = where folded character i came from (assets/search.js foldMap)
function foldMap(s: string): { f: string; at: number[] } {
  let f = '';
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/['’‘]/.test(c)) {
      if (/s/i.test(s[i + 1] || '') && !/[a-z0-9]/i.test(s[i + 2] || '')) i++;
      continue;
    }
    let g = c.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (c === 'æ' || c === 'Æ') g = 'ae'; else if (c === 'œ' || c === 'Œ') g = 'oe'; else if (c === 'ß') g = 'ss';
    else if (g.length !== 1) g = ' ';
    for (const k of g) { f += k; at.push(i); }
  }
  at.push(s.length);
  return { f, at };
}
const rxEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// [start, end] in s of each place the words stand together, in order, with only spaces or punctuation between
export function findPhrase(s: string, toks: string[], max = 50): [number, number][] {
  if (!toks.length) return [];
  const fm = foldMap(s), out: [number, number][] = [];
  const rx = new RegExp('(?:^|[^a-z0-9])(' + toks.map(rxEsc).join('[^a-z0-9]+') + ')(?![a-z0-9])', 'g');
  let m: RegExpExecArray | null;
  while ((m = rx.exec(fm.f)) && out.length < max) {
    const a = m.index + m[0].length - m[1].length, z = a + m[1].length;
    out.push([fm.at[a], fm.at[z - 1] + 1]);
    if (rx.lastIndex === m.index) rx.lastIndex++;
  }
  return out;
}
// a passage around [a, z]: whole sentences where they fit, about `room` characters either side
export function around(s: string, a: number, z: number, room = 260): string {
  let st = Math.max(0, a - room), en = Math.min(s.length, z + room);
  const back = s.slice(st, a).search(/[.!?;]["”’)]?\s+[^.!?;]*$/);
  if (back >= 0 && st > 0) st += back + s.slice(st + back).search(/\s/) + 1;
  const fwd = s.slice(z, en).search(/[.!?]["”’)]?(\s|$)/);
  if (fwd >= 0) en = z + fwd + 1 + (/["”’)]/.test(s[z + fwd + 1] || '') ? 1 : 0);
  return (st > 0 ? '… ' : '') + s.slice(st, en).trim() + (en < s.length ? ' …' : '');
}

type Cached<T> = { at: number; v: Promise<T> };
const TTL = 10 * 60 * 1000;

export class Library {
  private cat?: Cached<Book[]>;
  private keys?: Cached<Set<string>>;
  private files = new Map<string, Promise<{ u: Uint8Array; at: Map<string, [number, number]> }>>();
  private pages = new Map<string, Promise<Chapter[]>>();

  constructor(public site: string, private get: typeof fetch = fetch) {
    this.site = site.replace(/\/$/, '');
  }

  private async json<T>(path: string): Promise<T> {
    const r = await this.get(this.site + path);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return await r.json() as T;
  }

  catalog(): Promise<Book[]> {
    if (!this.cat || Date.now() - this.cat.at > TTL) {
      const v = this.json<Book[]>('/search/books.json');
      v.catch(() => { this.cat = undefined; });
      this.cat = { at: Date.now(), v };
      this.files.clear();   // a new catalog means a new index: book numbers may have moved
      this.keys = undefined;
    }
    return this.cat.v;
  }
  async book(id: string): Promise<Book | undefined> { return (await this.catalog()).find((b) => b.id === id); }

  // the catalog as lines for the model's instructions
  async catalogText(): Promise<string> {
    const rows = await this.catalog();
    return rows.map((b) => [b.id, b.t, b.a + (b.tr ? ` (tr. ${b.tr})` : ''), b.d || '', (b.tg || []).join(', '), b.desc || '']
      .map((x) => String(x).replace(/\s*\|\s*/g, ' / ')).join(' | ')).join('\n');
  }

  // ---- the full-text index (format: build/search_index.py)
  private keySet(): Promise<Set<string>> {
    if (!this.keys || Date.now() - this.keys.at > TTL) {
      const v = this.json<string[]>('/search/p.json').then((ks) => new Set(ks));
      v.catch(() => { this.keys = undefined; });
      this.keys = { at: Date.now(), v };
    }
    return this.keys.v;
  }
  private file(key: string) {
    let f = this.files.get(key);
    if (!f) {
      f = this.get(`${this.site}/search/p/${key}.bin`).then(async (r) => {
        if (!r.ok) throw new Error(`index ${key}: ${r.status}`);
        const u = new Uint8Array(await r.arrayBuffer()), at = new Map<string, [number, number]>();
        let i = 0;
        while (i < u.length) {
          let w = '';
          while (u[i]) w += String.fromCharCode(u[i++]);
          i++;
          let n = 0, s = 0, c: number;
          do { c = u[i++]; n += (c & 127) * 2 ** s; s += 7; } while (c & 128);
          at.set(w, [i, i + n]); i += n;
        }
        return { u, at };
      });
      f.catch(() => this.files.delete(key));
      this.files.set(key, f);
    }
    return f;
  }
  // where a word sits: book number -> chapter number -> positions
  private async places(w: string): Promise<Map<number, Map<number, number[]>>> {
    const set = await this.keySet(), out = new Map<number, Map<number, number[]>>();
    let key: string | null = set.has(w + '-') ? w + '-' : null;
    for (let n = w.length; !key && n >= 2; n--) if (set.has(w.slice(0, n))) key = w.slice(0, n);
    if (!key) return out;
    const f = await this.file(key), span = f.at.get(w);
    if (!span) return out;
    const u = f.u;
    let i = span[0];
    const num = () => { let n = 0, s = 0, c: number; do { c = u[i++]; n += (c & 127) * 2 ** s; s += 7; } while (c & 128); return n; };
    const nb = num();
    let bk = 0;
    for (let x = 0; x < nb; x++) {
      bk += num();
      const nc = num(), b = new Map<number, number[]>();
      out.set(bk, b);
      let ch = 0;
      for (let y = 0; y < nc; y++) {
        ch += num();
        const np = num(), ps: number[] = new Array(np);
        let pos = 0;
        for (let z = 0; z < np; z++) { pos += num(); ps[z] = pos; }
        b.set(ch, ps);
      }
    }
    return out;
  }

  // books and chapters where the words stand together as a phrase (a single word also matches its plurals),
  // most matches first
  async phrase(text: string, onlyBook?: string): Promise<Hit[]> {
    const toks = tokens(text), cat = await this.catalog();
    const idx = toks.map((w, k) => (indexed(w) ? k : -1)).filter((k) => k >= 0);
    if (!idx.length) return [];
    const per = new Map<number, Map<number, number>>();
    if (idx.length === 1) {
      const w = toks[idx[0]], vs = [w, w + 's', w + 'es'];
      if (w.length > 3 && w.endsWith('s')) vs.push(w.slice(0, -1));
      for (const pl of await Promise.all(vs.map((v) => this.places(v)))) {
        for (const [bk, chs] of pl) {
          const b = per.get(bk) || new Map<number, number>();
          per.set(bk, b);
          for (const [c, ps] of chs) b.set(c, (b.get(c) || 0) + ps.length);
        }
      }
    } else {
      const all = await Promise.all(idx.map((k) => this.places(toks[k])));
      for (const [bk, chs0] of all[0]) {
        if (!all.every((pl) => pl.has(bk))) continue;
        for (const [c, ps0] of chs0) {
          if (!all.every((pl) => pl.get(bk)!.has(c))) continue;
          const sets = all.slice(1).map((pl, j) => ({ off: idx[j + 1] - idx[0], s: new Set(pl.get(bk)!.get(c)!) }));
          let n = 0;
          for (const p of ps0) if (sets.every((s) => s.s.has(p + s.off))) n++;
          if (n) {
            const b = per.get(bk) || new Map<number, number>();
            per.set(bk, b);
            b.set(c, n);
          }
        }
      }
    }
    const hits: Hit[] = [];
    for (const [bk, chs] of per) {
      const book = cat[bk];
      if (!book || (onlyBook && book.id !== onlyBook)) continue;
      const list = [...chs].map(([ci, n]) => ({ ci, n }));
      hits.push({ book, chapters: list, n: list.reduce((s, c) => s + c.n, 0) });
    }
    return hits.sort((a, b) => b.n - a.n);
  }

  // ---- read-online pages
  pageUrl(b: Book): string {
    const rd = b.rd || `/read/${encodeURIComponent(b.id)}/`;
    return /^https?:/.test(rd) ? rd : this.site + rd;
  }
  chaptersOf(b: Book): Promise<Chapter[]> {
    let p = this.pages.get(b.id);
    if (!p) {
      p = this.get(this.pageUrl(b)).then(async (r) => {
        if (!r.ok) throw new Error(`${b.id} page: ${r.status}`);
        return chapters(await r.text());
      });
      p.catch(() => this.pages.delete(b.id));
      if (this.pages.size > 12) this.pages.delete(this.pages.keys().next().value!);
      this.pages.set(b.id, p);
    }
    return p;
  }
}
