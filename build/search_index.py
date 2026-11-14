"""Full-text search index for foggypress.com (no server, no outside tools).

For every live book with a web edition, the text of each chapter (each <section> of
the read-online page) is split into words. The index is written as small JSON files
under search/, so a search downloads only the files for the words it asks about:

  search/books.json     one row per live book: id, title, author, translator, date,
                        description, tags, whether it reads online, and its chapter
                        list ([section id, heading], in reading order)
  search/w/<xx>.json    every word starting with the two letters <xx> (or, where that
                        file would be big, with the three letters <xxy>; search/split.json
                        lists the two-letter starts that are split that way):
                        {word: [[book, mentions, chapter, n, chapter, n, ...], ...]}
                        book and chapter are positions in books.json

Words are folded the same way assets/search.js folds a query: lower case, accents
dropped, possessive 's dropped, other apostrophes removed. Very common words
("the", "and", ...) are left out; a search for only those finds titles and authors.
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

SPLIT_AT = 200_000
_TAG = re.compile(r'<[^>]+>')
_SEC = re.compile(r'<section id="([^"]+)"[^>]*>(.*?)(?=<section id=|</article>)', re.S)
_H2 = re.compile(r'<h2[^>]*>(.*?)</h2>', re.S)


def fold(s):
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace('’', "'").replace('‘', "'").replace('æ', 'ae').replace('œ', 'oe').replace('ß', 'ss')
    s = re.sub(r"'s\b", '', s)
    return s.replace("'", '')


def words(text):
    return [w for w in re.findall(r'[a-z0-9]+', fold(text)) if len(w) > 1 and w not in STOP]


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
    """rows: [(book record for books.json, article html or None)]; writes out_dir/books.json and out_dir/w/*.json"""
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'w').mkdir(exist_ok=True)
    books = []
    index = defaultdict(list)  # word -> [[book, total, ch, n, ...]]
    for bi, (rec, article) in enumerate(rows):
        secs = chapters(article) if article else []
        rec = dict(rec, ch=[[sid, head] for sid, head, _ in secs])
        books.append(rec)
        counts = defaultdict(lambda: defaultdict(int))  # word -> chapter -> n
        for ci, (_, _, text) in enumerate(secs):
            for w in words(text):
                counts[w][ci] += 1
        for w, per in counts.items():
            row = [bi, sum(per.values())]
            for ci in sorted(per):
                row += [ci, per[ci]]
            index[w].append(row)
    # two-letter files, split into three-letter files where one would pass SPLIT_AT bytes
    two = defaultdict(dict)
    for w, rows_ in index.items():
        two[w[:2]][w] = rows_
    shards, split = {}, []
    for key, data in two.items():
        if len(json.dumps(data, separators=(',', ':'))) > SPLIT_AT:
            split.append(key)
            for w, rows_ in data.items():
                shards.setdefault(w[:3], {})[w] = rows_
        else:
            shards[key] = data
    for key, data in shards.items():
        (out_dir / 'w' / f'{key}.json').write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    (out_dir / 'split.json').write_text(json.dumps(sorted(split)), encoding='utf-8')
    (out_dir / 'books.json').write_text(json.dumps(books, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    return len(index), len(shards)
