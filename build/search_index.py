"""Full-text search index for foggypress.com (no server, no outside tools).

For every live book with a web edition, the text of each chapter (each <section> of
the read-online page) is split into words, and the index records where every word sits,
so that a search of several words can find them as an exact phrase. It is written as
small files under search/, so a search downloads only the files for the words it asks about:

  search/books.json     one row per live book: id, title, author, translator, date,
                        description, tags, whether it reads online, and its chapter
                        list ([section id, heading], in reading order)
  search/p.json         the list of index file keys
  search/p/<key>.bin    the words starting with <key>. A key is two letters or longer,
                        as long as it takes to keep a file under SPLIT_AT bytes; a key
                        ending in "-" holds just that one word (too common to share).

Each .bin file is a run of word records, read by assets/search.js:
  word (ASCII bytes), a 0 byte, the record's length in bytes, then the record:
  number of books; for each book: book (gap from the last book in this record; the first
  is its place in books.json), number of chapters; for each chapter: chapter (gap from the
  last, the first is its place in the book's chapter list), number of places, then the
  places: the word's position counting every word of the chapter from 0 (stop words
  included), the first in full and the rest as gaps from the one before.
All numbers are unsigned varints (7 bits a byte, low bits first, high bit = more to come).

Words are folded the same way assets/search.js folds a query: lower case, accents
dropped, possessive 's dropped, other apostrophes removed. Very common words
("the", "and", ...) are not indexed but still count as positions, so a phrase with
them in it ("call of the wild") is found by its other words standing the right distance
apart; a search made only of them finds titles and authors.
"""
import html
import json
import re
import unicodedata
from collections import defaultdict

# common English words not worth indexing (search.js keeps the same list)
STOP = set('''a about after all also an and any are as at be been but by can could did do does for from had has have he her
him his how i if in into is it its may me more most my no not now of on one only or our out over she so some such than that the
their them then there these they this those to up upon us was we were what when where which who whom why will with would you your
'''.split())

SPLIT_AT = 256_000
_TAG = re.compile(r'<[^>]+>')
_SEC = re.compile(r'<section id="([^"]+)"[^>]*>(.*?)(?=<section id=|</article>)', re.S)
_H2 = re.compile(r'<h2[^>]*>(.*?)</h2>', re.S)


def fold(s):
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace('’', "'").replace('‘', "'").replace('æ', 'ae').replace('œ', 'oe').replace('ß', 'ss')
    s = re.sub(r"'s\b", '', s)
    return s.replace("'", '')


def tokens(text):
    """every word, stop words included, in order (search.js splits a query the same way)"""
    return re.findall(r'[a-z0-9]+', fold(text))


def indexed(w):
    return len(w) > 1 and w not in STOP


def words(text):
    return [w for w in tokens(text) if indexed(w)]


def varint(n, out):
    while n >= 128:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)


def plain(fragment):
    return html.unescape(_TAG.sub(' ', fragment))


def chapters(article):
    """[(section id, heading, text)] of a web edition's <article>; text before the first section counts as 'Opening'"""
    art = re.sub(r'<details class="toc">.*?</details>', '', article, flags=re.S)
    art = re.sub(r'<header class="book-head">.*?</header>', '', art, count=1, flags=re.S)
    out = []
    first = art.find('<section id=')
    lead = plain(art[:first] if first >= 0 else art)
    if words(lead):
        out.append(('', 'Opening', lead))
    for m in _SEC.finditer(art):
        h = _H2.search(m.group(2))
        head = ' '.join(plain(h.group(1)).split()) if h else ''
        out.append((m.group(1), head, plain(m.group(2))))
    return out


def write_index(out_dir, rows):
    """rows: [(book record for books.json, article html or None)]; writes out_dir/books.json, p.json and p/*.bin"""
    out_dir.mkdir(parents=True, exist_ok=True)
    pdir = out_dir / 'p'
    pdir.mkdir(exist_ok=True)
    books = []
    places = defaultdict(list)  # word -> [(book, chapter, [positions])], in book then chapter order
    for bi, (rec, article) in enumerate(rows):
        secs = chapters(article) if article else []
        books.append(dict(rec, ch=[[sid, head] for sid, head, _ in secs]))
        for ci, (_, _, text) in enumerate(secs):
            at = defaultdict(list)
            for i, w in enumerate(tokens(text)):
                if indexed(w):
                    at[w].append(i)
            for w, ps in at.items():
                places[w].append((bi, ci, ps))

    def record(w):
        body = bytearray()
        by_book = []
        for bi, ci, ps in places[w]:
            if not by_book or by_book[-1][0] != bi:
                by_book.append((bi, []))
            by_book[-1][1].append((ci, ps))
        varint(len(by_book), body)
        last_b = 0
        for bi, chs in by_book:
            varint(bi - last_b, body)
            last_b = bi
            varint(len(chs), body)
            last_c = 0
            for ci, ps in chs:
                varint(ci - last_c, body)
                last_c = ci
                varint(len(ps), body)
                last_p = 0
                for p in ps:
                    varint(p - last_p, body)
                    last_p = p
        head = bytearray(w.encode('ascii') + b'\0')
        varint(len(body), head)
        return bytes(head + body)

    recs = {w: record(w) for w in places}
    keys = []

    def put(key, ws):
        (pdir / f'{key}.bin').write_bytes(b''.join(recs[w] for w in sorted(ws)))
        keys.append(key)

    def place(key, ws):
        # one file for this start if it is small enough, else one file per next letter
        if sum(len(recs[w]) for w in ws) <= SPLIT_AT or all(w == key for w in ws):
            put(key, ws)
            return
        kids = defaultdict(list)
        for w in ws:
            if w == key:
                put(key + '-', [w])
            else:
                kids[w[:len(key) + 1]].append(w)
        for k, kw in kids.items():
            place(k, kw)

    first = defaultdict(list)
    for w in recs:
        first[w[:2]].append(w)
    for k, ws in first.items():
        place(k, ws)
    (out_dir / 'p.json').write_text(json.dumps(sorted(keys), separators=(',', ':')), encoding='utf-8')
    (out_dir / 'books.json').write_text(json.dumps(books, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    return len(recs), len(keys)
