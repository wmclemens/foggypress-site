"""Library of Congress classification for the catalog.

Every book record carries:
  "lcc":         its one LC class code, as Gutenberg's catalog gives it ("PS", "QK", "E151", "F850.5")
  "lc_subjects": its LC subject headings ("Whaling -- Fiction", "Sea stories")
  "gutenberg":   the Project Gutenberg ebook number it was made from, when there is one

The site groups books by LC main class (the home page tiles), then by subclass (one per book), and makes a
subject page for every heading, and every level of a heading ("Whaling", "Whaling -- Fiction"), shared by
SUBJECT_MIN or more live books. Names come from catalog/lcc.json.

Command line (run from the repo root):
  python build/lc.py refresh --catalog pg_catalog.csv [--files ../foggy-press-files] [--apply]
      compare every record with Gutenberg's current catalog (gutenberg.org/cache/epub/feeds/pg_catalog.csv)
      and list what differs; --apply also fills records that have no LC data yet (it never overwrites a
      record's existing LC data: change those by hand or in admin)
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUBJECT_MIN = 3
TABLE = json.loads((ROOT / 'catalog/lcc.json').read_text(encoding='utf-8'))
CLASSES, SUBCLASSES = TABLE['classes'], TABLE['subclasses']
# national literatures: a book Gutenberg files under both PZ (juvenile fiction) and one of these goes under the literature
LITERATURES = {'PA', 'PG', 'PJ', 'PK', 'PL', 'PQ', 'PR', 'PS', 'PT'}


def subclass(code):
    """an LC code (PR, E151, F850.5, D501, QH301) -> its key in catalog/lcc.json, or '' when unknown"""
    m = re.match(r'\s*([A-Z]+)\s*([\d.]*)', code or '')
    if not m:
        return ''
    letters, num = m.group(1), m.group(2)
    try:
        n = float(num) if num else None
    except ValueError:
        n = None
    if letters == 'E':
        return 'E-AM' if n is not None and n < 151 else 'E-US'
    if letters == 'F':
        if n is None or n < 1000:
            return 'F-US'
        return 'F-CA' if n < 1200 else 'F-MX' if n < 1400 else 'F-LA'
    if letters in SUBCLASSES:
        return letters
    return letters[0] if letters[0] in SUBCLASSES else ''


def class_name(key):
    """the main class (home tile) name of a subclass key"""
    return CLASSES.get(SUBCLASSES[key]['class'], '') if key in SUBCLASSES else ''


def pick(codes):
    """one code from Gutenberg's list: the national literature when PZ is paired with one, else the first known"""
    codes = [c.strip() for c in codes if c.strip() and subclass(c)]
    if not codes:
        return ''
    keys = [subclass(c) for c in codes]
    if 'PZ' in keys:
        for c, k in zip(codes, keys):
            if k in LITERATURES:
                return c
    return codes[0]


def levels(heading):
    """'A -- B -- C' -> ['A', 'A -- B', 'A -- B -- C']"""
    parts = [p.strip() for p in heading.split('--') if p.strip()]
    return [' -- '.join(parts[:k]) for k in range(1, len(parts) + 1)]


def readme_gutenberg(readme):
    """the first Project Gutenberg ebook number a book's README names, or ''"""
    try:
        t = Path(readme).read_text(encoding='utf-8')
    except OSError:
        return ''
    m = re.search(r'(?:Gutenberg (?:eBook )?#|gutenberg\.org/ebooks/)(\d{1,6})', t)
    return m.group(1) if m else ''


def load_pg(path):
    """Gutenberg's pg_catalog.csv -> {ebook number: (codes, subject headings)}"""
    out = {}
    with open(path, encoding='utf-8', newline='') as f:
        for r in csv.DictReader(f):
            codes = [c.strip() for c in (r.get('LoCC') or '').split(';') if c.strip()]
            subs = [s.strip() for s in (r.get('Subjects') or '').split(';') if s.strip()]
            out[r['Text#']] = (codes, subs)
    return out


def from_gutenberg(pg, gid):
    """{"lcc", "lc_subjects"} for a Gutenberg book, or None"""
    if not gid or gid not in pg:
        return None
    codes, subs = pg[gid]
    code = pick(codes)
    return {'lcc': code, 'lc_subjects': subs} if code else None


def _refresh(argv):
    import argparse
    ap = argparse.ArgumentParser(prog='lc.py refresh')
    ap.add_argument('--catalog', required=True, help="Gutenberg's pg_catalog.csv")
    ap.add_argument('--files', help='checkout of foggy-press-files (with the library books), to find Gutenberg numbers in READMEs')
    ap.add_argument('--apply', action='store_true', help='fill records that have no LC data yet')
    a = ap.parse_args(argv)
    pg = load_pg(a.catalog)
    path = ROOT / 'catalog/books.json'
    books = json.loads(path.read_text(encoding='utf-8'))
    filled, differ, missing = [], [], []
    for b in books:
        gid = b.get('gutenberg') or ''
        if not gid and a.files and b.get('github_dir'):
            m = re.search(r'/tree/main/(.+)$', b['github_dir'])
            gid = readme_gutenberg(Path(a.files) / m.group(1) / 'README.md') if m else ''
        g = from_gutenberg(pg, gid)
        if not b.get('lcc'):
            if g:
                filled.append(b['id'])
                if a.apply:
                    b.update(g)
                    b['gutenberg'] = gid
            else:
                missing.append(b['id'])
        elif g and (subclass(g['lcc']) != subclass(b['lcc']) or g['lc_subjects'] != b.get('lc_subjects')):
            differ.append(f"{b['id']}: here {b['lcc']} {b.get('lc_subjects')} | Gutenberg {g['lcc']} {g['lc_subjects']}")
        if b.get('lcc') and not subclass(b['lcc']):
            differ.append(f"{b['id']}: code {b['lcc']} is not in catalog/lcc.json")
    print(f'{len(filled)} records without LC data that Gutenberg can fill' + (' (filled)' if a.apply else ''))
    print(f'{len(missing)} records without LC data and no Gutenberg match: ' + ', '.join(missing))
    print(f'{len(differ)} records that differ from Gutenberg now:')
    for d in differ:
        print('  ' + d)
    if a.apply and filled:
        path.write_text(json.dumps(books, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    if sys.argv[1:2] == ['refresh']:
        _refresh(sys.argv[2:])
    else:
        print(__doc__)
