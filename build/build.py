#!/usr/bin/env python3
"""Build the Foggy Press website.

Reads catalog/books.json and catalog/tags.json, copies the PDF of every live
book out of a checkout of the private foggy-press-files repo, makes its
read-online page from the web edition beside the PDF (output/html/, made by
pipeline/web/ in that repo), and writes a static site to _site/.

A book is live when its foggy_press_date is set, is today or earlier, and its
PDF exists in the files checkout.

Usage:
  python build/build.py --files ../foggy-press-files [--out _site]
Environment (all optional):
  GOATCOUNTER_CODE   e.g. "foggypress"; adds the download counter script
  GOATCOUNTER_TOKEN  API token; pulls download counts for the Popular sort
  SITE_DOMAIN        e.g. "foggypress.com"; writes the CNAME file. Without it, a
                     GitHub Actions build prefixes links with /<repo-name>/.
  PDF_BASE           e.g. "https://files.foggypress.com"; PDFs are served from
                     there (Cloudflare R2) instead of being copied into the site
                     under /pdf/. Without it, the site keeps its own copies.

  python build/build.py --files ../foggy-press-files --stage-pdfs _pdfs
    only copies each live book's PDF to _pdfs/<id>.pdf and makes its EPUB at
    _pdfs/epub/<id>.epub (from the web edition, see epub.py), for upload to R2.
"""
import argparse, datetime, html, json, os, re, shutil, sys, urllib.parse, urllib.request
from pathlib import Path

import britannica
import epub
import report
import search_index

ROOT = Path(__file__).resolve().parent.parent
FEATURED_MAX = 3
# Display levels of a tag (catalog/tags.json "level"): 1 Featured (home page top, at most FEATURED_MAX),
# 2 Main (the home page's collection tiles), 3 and deeper only on the By tag page, in search and by link.
LEVEL_NAMES = {1: 'Featured', 2: 'Main collections', 3: 'Other collections'}


def tag_level(t):
    """a tag's display level; older tag files only say featured true/false"""
    try:
        return max(1, int(t['level']))
    except (KeyError, TypeError, ValueError):
        return 1 if t.get('featured') else 2


LANG_PICK = ('<label class="langpick"><span class="vh" data-t>Language</span>'
             '<select aria-label="Language" data-t-attr="aria-label"><option value="en">English</option></select></label>')


def tn(key, n, text=None, m=None):
    """a counted phrase the language menu translates (assets/i18n.js): key such as {n} books"""
    shown = text if text is not None else key.replace('{n}', str(n)).replace('{m}', str(m))
    return f'<span data-t="{esc(key)}" data-n="{n}"{f' data-m="{m}"' if m is not None else ''}>{esc(shown)}</span>'


def level_name(n):
    return LEVEL_NAMES.get(n, f'Level {n} collections')
COLLECTIONS_PER_PAGE = 25


def esc(s):
    return html.escape(str(s or ''), quote=True)


def slugify(s):
    s = s.lower().replace('&', 'and')
    s = re.sub(r"[’']", '', s)
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def sort_title(t):
    return re.sub(r'^(The|A|An) ', '', t)


def nat(s):
    """Natural sort key: case-insensitive, numbers compare as numbers ("Volume 2" before "Volume 10")."""
    return [int(p) if i % 2 else p for i, p in enumerate(re.split(r'(\d+)', s.lower()))]


def title_key(t):
    return nat(sort_title(t))


def author_name(b):
    """'Jane Austen'. Co-authors are kept in the first-name field ('Mark and Charles Dudley Warner' + 'Twain'):
    the last name goes after the first author's own first name -> 'Mark Twain and Charles Dudley Warner'.
    A lone second first name ('Jacob and Wilhelm' + 'Grimm') shares the last name and stays as it is."""
    first, last = b['author_first'] or '', b['author_last'] or ''
    head, sep, rest = first.partition(' and ')
    if sep and last and len(rest.split()) > 1:
        return f"{head} {last} and {rest}".strip()
    return f"{first} {last}".strip()


def pdf_repo_path(link):
    """'https://github.com/o/r/blob/main/books/x/y.pdf' -> 'books/x/y.pdf'"""
    m = re.search(r'/blob/[^/]+/(.+)$', link or '')
    return urllib.parse.unquote(m.group(1)) if m else None


def readme_description(path):
    """the one-sentence description under "## Description" in the book's README (Will edits it there)"""
    try:
        text = path.read_text(encoding='utf-8')
    except OSError:
        return ''
    m = re.search(r'^## Description[ \t]*\n(.*?)(?=^#|\Z)', text, re.S | re.M)
    if not m:
        return ''
    body = re.sub(r'<!--.*?-->', '', m.group(1), flags=re.S)
    return ' '.join(body.split())


def pdf_pages(path):
    try:
        from pypdf import PdfReader
        return len(PdfReader(str(path)).pages)
    except Exception:
        return None


def _gc_get(url, token, tries=5):
    """One GoatCounter API call, tried again on failure: GoatCounter now and then answers a good
    request with a 404 or 5xx for a minute or so (17 Nov 2026: four nightly builds lost every count to
    one such 404, while the same request worked minutes earlier and later)."""
    import time
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            body = ''
            try:
                body = e.read()[:200].decode('utf-8', 'replace')     # HTTPError: say what GoatCounter said
            except Exception:
                pass
            print(f'warning: GoatCounter try {i + 1} of {tries}: {e} {body}'.rstrip(), file=sys.stderr)
            if i == tries - 1:
                raise
            time.sleep(min(10 * 2 ** i, 60))


def fetch_downloads(code, token):
    """Total clicks per path from GoatCounter. Returns None if the counts could not be fetched
    (the caller then keeps the last published counts rather than showing zeros)."""
    if not (code and token):
        return {}
    counts, after = {}, None
    end = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:00:00Z')
    try:
        for _ in range(50):
            q = {'start': '2026-01-01T00:00:00Z', 'end': end, 'limit': '100'}
            if after:
                q['exclude_paths'] = ','.join(after)
            data = _gc_get(f'https://{code}.goatcounter.com/api/v0/stats/hits?' + urllib.parse.urlencode(q), token)
            hits = data.get('hits') or []
            for h in hits:
                k = h['path'].split('?')[0]     # a read page opened from search arrives as /read/<id>/index.html?q=...
                counts[k] = counts.get(k, 0) + int(h.get('count', 0))
            if not data.get('more') or not hits:
                break
            after = [str(h['path_id']) for h in hits] + (after or [])
    except Exception as e:
        print(f'warning: could not fetch download counts: {e}', file=sys.stderr)
        return None
    print(f'GoatCounter: counts for {len(counts)} pages and clicks', file=sys.stderr)
    return counts


def last_published_counts(domain):
    """{book id: (downloads, views)} from the live site's admin/stats.json, for when GoatCounter can't be reached."""
    if not domain:
        return {}
    try:
        req = urllib.request.Request(f'https://{domain}/admin/stats.json', headers={'User-Agent': 'FoggyPress-site-build/1.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            books = json.load(r).get('books') or {}
        return {k: (int(v.get('downloads') or 0), int(v.get('views') or 0)) for k, v in books.items()}
    except Exception as e:
        print(f'warning: could not read the last published counts either: {e}', file=sys.stderr)
        return {}


def fmt_dl(n):
    return f'↓ {n:,}'



def web_picture(src, dst, longest=900):
    """a read-online picture: the print copies run to 2000+ px and over 1 MB each, which pushed the
    Pages site past its size limit (10 Nov 2026); here they are cut to screen size"""
    try:
        from PIL import Image
        im = Image.open(src)
        im.load()
    except Exception:
        shutil.copyfile(src, dst)
        return
    if max(im.size) > longest:
        im.thumbnail((longest, longest))
    ext = dst.suffix.lower()
    if ext in ('.jpg', '.jpeg'):
        im.convert('L').save(dst, quality=65, optimize=True, progressive=True)     # house style: pictures are grayscale
    elif ext == '.png':
        (im.convert('LA') if 'A' in im.mode or 'transparency' in im.info else im.convert('L')).save(dst, optimize=True)
    else:
        shutil.copyfile(src, dst)
    if dst.stat().st_size > src.stat().st_size:
        shutil.copyfile(src, dst)

class Site:
    def __init__(self, files_dir, out):
        self.files = Path(files_dir)
        self.out = Path(out)
        self.books = json.loads((ROOT / 'catalog/books.json').read_text())
        self.tags = json.loads((ROOT / 'catalog/tags.json').read_text())
        self.gc_code = os.environ.get('GOATCOUNTER_CODE', '').strip()
        self.downloads = fetch_downloads(self.gc_code, os.environ.get('GOATCOUNTER_TOKEN', '').strip())
        # GoatCounter unreachable: keep the counts the site last published instead of zeros
        self.prev_counts = last_published_counts(os.environ.get('SITE_DOMAIN', '').strip()) if self.downloads is None else {}
        if self.downloads is None:
            print(f'Using last published counts for {len(self.prev_counts)} books', file=sys.stderr)
            self.downloads = {}
        self.today = datetime.date.today().isoformat()
        self.problems = []
        # Without a custom domain, GitHub Pages serves the site under /<repo-name>/.
        repo = os.environ.get('GITHUB_REPOSITORY', '')
        self.base = '' if os.environ.get('SITE_DOMAIN', '').strip() or not repo else '/' + repo.split('/')[-1]
        self.pdf_base = os.environ.get('PDF_BASE', '').strip().rstrip('/')
        # reader accounts (assets/account.js, supabase/schema.sql): on only when the Supabase project is set
        self.sb_url = os.environ.get('SUPABASE_URL', '').strip().rstrip('/')
        self.sb_key = os.environ.get('SUPABASE_ANON_KEY', '').strip()
        self.accounts = bool(self.sb_url and self.sb_key)
        # Ask Foggy Press (assets/ask.js, supabase/functions/ask): needs accounts, and ASK_ON once the function is deployed
        self.ask = self.accounts and os.environ.get('ASK_ON', '').strip().lower() in ('1', 'true', 'yes', 'on')

    def account_head(self):
        if not self.accounts:
            return ''
        ts = os.environ.get('TURNSTILE_SITE_KEY', '').strip()
        meta = f'<meta name="fp-account" content="{esc(self.sb_url)}|{esc(self.sb_key)}|{esc(ts)}">'
        if self.ask:
            meta += f'<meta name="fp-ask" content="{esc(self.sb_url)}/functions/v1/ask">'
        return meta

    def reference_nav(self, current):
        """'Reference' in the left rail, once the 1911 Britannica is on the site (see britannica.py)"""
        if not britannica.listed():
            return ''
        return (f'<div><div class="eyebrow" style="margin-bottom:.6rem" data-t>Reference</div><nav aria-label="Reference">'
                f'<a href="/britannica/"{" aria-current=page" if current == "britannica" else ""}><span>Britannica 1911</span><span class="mono">→</span></a></nav></div>')

    def account_script(self):
        return ('<script src="/assets/account.js" defer></script>' if self.accounts else '') + \
            ('<script src="/assets/ask.js" defer></script>' if self.ask else '')

    def ask_rail(self, current):
        """the Ask section of the left rail, under Search"""
        if not self.ask:
            return ''
        on = ' aria-current=page' if current == 'ask' else ''
        return (f'<div class="askrail"><div class="eyebrow" style="margin-bottom:.6rem" data-t>Ask</div><nav aria-label="Ask">'
                f'<a href="/ask/"{on}><span><span data-t>Ask about the books</span><span class="newtag" data-t>New</span></span><span class="mono">→</span></a>'
                f'<a href="/ask/#past"><span data-t>Past chats</span><span class="mono">→</span></a></nav></div>')

    def epub_url(self, b):
        """the book's EPUB (made from its web edition): beside the PDFs in R2, or under /epub/ in the site"""
        name = f"{urllib.parse.quote(b['id'])}.epub"
        return f'{self.pdf_base}/epub/{name}' if self.pdf_base else f'/epub/{name}'

    def pdf_url(self, b):
        """Where visitors get a book's PDF: R2 (files.foggypress.com) when PDF_BASE is set, else the site's own /pdf/ copy."""
        name = f"{urllib.parse.quote(b['id'])}.pdf"
        return f'{self.pdf_base}/{name}' if self.pdf_base else f'/pdf/{name}'

    # ---- data ----
    def prepare(self):
        tag_names = {t['name'] for t in self.tags}
        for b in self.books:
            for t in b.get('tags', []):
                if t not in tag_names:  # a tag typed into a record but missing from the tag file
                    self.tags.append({'name': t, 'level': 3})
                    tag_names.add(t)
        for t in self.tags:
            t['slug'] = slugify(t['name'])
            t['_level'] = tag_level(t)
        self.live = []
        for b in self.books:
            rel = pdf_repo_path(b.get('github_pdf'))
            src = self.files / rel if rel else None
            b['_src'] = src
            # the web edition: books/<author>/<title>/output/html/<title>.html
            hp = src.parent / 'html' / (src.parent.parent.name + '.html') if src else None
            b['_html'] = hp if hp and hp.exists() else None
            b['_desc'] = readme_description(src.parent.parent / 'README.md') if src else ''
            b['_downloads'] = self.downloads.get(f"pdf-{b['id']}", 0)
            # visits to the read-online page (GoatCounter records it as an ordinary page view)
            b['_views'] = sum(self.downloads.get(f"/read/{b['id']}{t}", 0) for t in ('/', '', '/index.html'))
            if b['id'] in self.prev_counts:
                b['_downloads'], b['_views'] = self.prev_counts[b['id']]
            if src and src.exists():
                b['_mb'] = round(src.stat().st_size / 1e6, 2)
                b['_pages'] = pdf_pages(src)
            else:
                b['_mb'] = b['_pages'] = None
                if b.get('foggy_press_date'):
                    self.problems.append(f"{b['id']}: PDF not found ({rel})")
            d = b.get('foggy_press_date') or ''
            if d and d <= self.today and b['_mb'] is not None:
                self.live.append(b)
        self.by_tag = {t['name']: [b for b in self.live if t['name'] in b.get('tags', [])] for t in self.tags}

    def tag_dl(self, name):
        return sum(b['_downloads'] for b in self.by_tag[name])

    # ---- html ----
    def page(self, path, title, body, current='', description=''):
        gc = ''
        if self.gc_code:
            gc = f'<script data-goatcounter="https://{esc(self.gc_code)}.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>'
        nav = [('authors', 'By author', len(self.live)), ('titles', 'By title', len(self.live)),
               ('tags', 'By tag', sum(1 for t in self.tags if self.by_tag[t['name']]))]
        navhtml = ''.join(f'<a href="/{h}/"{" aria-current=page" if current == h else ""}><span data-t>{l}</span><span class="mono">{n}</span></a>' for h, l, n in nav)
        doc = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description or 'Foggy Press: public-domain books, newly set and free to print.')}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/style.css">
{self.account_head()}
<script>try{{var t=localStorage.getItem('fp-theme');if(t)document.documentElement.dataset.theme=t}}catch(e){{}}</script>
</head>
<body>
<div class="wrap shell">
  <a class="brand" href="/"><span class="n">Foggy Press</span><span class="s" data-t>Printable Books</span></a>
  {self.search_box('qm', 'srch msrch')}
  {'<div class="mask"><a href="/ask/" data-t>Ask about the books</a></div>' if self.ask and current not in ('ask', 'home') else ''}
  <aside class="rail">
    {self.search_box('q', 'srch')}
    {self.ask_rail(current)}
    {'<div class="railhist" id="railhist" hidden></div>' if self.accounts else ''}
    <div><div class="eyebrow" style="margin-bottom:.6rem" data-t>List books</div><nav aria-label="Lists">{navhtml}</nav></div>
    {self.reference_nav(current)}<nav aria-label="About">{f'<a href="/account/"{" aria-current=page" if current == "account" else ""}><span data-t>My books</span><span class="mono">→</span></a><a href="/request/"{" aria-current=page" if current == "request" else ""}><span data-t>Request a book</span><span class="mono">→</span></a>' if self.accounts else ''}<a href="/about/"{" aria-current=page" if current == 'about' else ""}><span data-t>About Foggy Press</span><span class="mono">→</span></a></nav>
    <div class="rail-end"><button class="theme" id="theme" type="button">Dark mode</button>{LANG_PICK}</div>
  </aside>
  <main>{body}</main>
</div>
<footer class="wrap foot mono"><span data-t>Foggy Press · public-domain books, free to print</span>{'<a href="/privacy/" data-t>Privacy</a>' if self.accounts else ''}{tn('{n} books', len(self.live))}</footer>
<script src="/assets/i18n.js"></script>
<script src="/assets/site.js" defer></script>
{'<script src="/assets/search.js" defer></script>' if current == 'search' else ''}
{self.account_script()}
{'<script src="/assets/request.js" defer></script>' if current == 'request' else ''}
{gc}
</body>
</html>
'''
        if self.base:
            doc = re.sub(r'(href|src|action)="/(?!/)', lambda m: f'{m.group(1)}="{self.base}/', doc)
        dest = self.out / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(doc)

    @staticmethod
    def search_box(iid, cls):
        """the site search box: in the left rail, and (phones only, where the rail drops below the page) under the name"""
        return (f'<form class="{cls}" role="search" action="/search/" method="get"><label class="eyebrow" for="{iid}" data-t>Search</label>'
                f'<div class="sbox"><input id="{iid}" name="q" type="search" placeholder="Title, author or any word" data-t-attr="placeholder" autocomplete="off" enterkeyhint="search">'
                f'<button type="submit" aria-label="Search" data-t-attr="aria-label">→</button></div></form>')

    def _search_rows(self):
        """(book record, article html) for the search index, one book at a time: holding every book's
        text at once took several GB once the catalog passed ~3,000 books (19 Nov 2026)"""
        for b in self.live:
            art = None
            if b.get('_html'):
                m = re.search(r'<article class="book".*</article>', b['_html'].read_text(encoding='utf-8'), re.S)
                art = m.group(0) if m else None
            pdf = self.pdf_url(b)
            if pdf.startswith('/'):
                pdf = self.base + pdf
            yield (({'id': b['id'], 't': b['title'], 'a': author_name(b), 'al': b['author_last'], 'af': b['author_first'], 'tr': b.get('translator') or '',
                          'd': b.get('original_date') or '', 'desc': b.get('_desc') or '', 'tg': b.get('tags', []), 'pdf': pdf, 'read': bool(art), **({'rd': self.read_url(b) if self.pdf_base else self.base + self.read_url(b)} if art else {}),
                          **({'epub': self.epub_url(b) if self.pdf_base else self.base + self.epub_url(b)} if art else {})}, art))

    def search(self):
        """/search/ page plus the index it reads (search/books.json, search/p.json, search/p/*.bin): see search_index.py"""
        nw, ns = search_index.write_index(self.out / 'search', self._search_rows())
        tags = [{'n': t['name'], 's': t['slug'], 'c': len(self.by_tag[t['name']])} for t in sorted(self.tags, key=lambda t: nat(t['name'])) if self.by_tag[t['name']]]
        (self.out / 'search' / 'tags.json').write_text(json.dumps(tags, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f'Search index: {nw} words in {ns} files.')
        self.page('search/index.html', 'Search · Foggy Press',
                  '<div id="search-results"><div class="ph"><span class="crumb"><a href="/" data-t>Home</a> / <span data-t>Search</span></span><h1 data-t>Search</h1>'
                  '<noscript><p class="sub">Search needs JavaScript. You can still <a href="/authors/" style="color:var(--accent)">list books by author</a>.</p></noscript></div></div>',
                  'search', 'Search Foggy Press books by title, author, or any word inside them.')

    def epub_link(self, b, cls):
        return (f'<a class="{cls}" href="{esc(self.epub_url(b))}" download rel="nofollow" data-goatcounter-click="epub-{esc(b["id"])}" '
                f'data-goatcounter-title="{esc(b["title"])}" title="For e-readers: Kindle, Apple Books, Kobo" data-t-attr="title">EPUB</a>')

    def recs(self, books, sortable=False):
        """book rows; sortable adds the keys the tag pages' sort buttons use (assets/site.js)"""
        out = []
        for b in books:
            tr = f" · <span data-t>tr.</span> {esc(b['translator'])}" if b.get('translator') else ''
            pages = f" · {tn('{n} pp', b['_pages'])}" if b.get('_pages') else ''
            pdf = (f'<a class="act" href="{esc(self.pdf_url(b))}" rel="nofollow" data-goatcounter-click="pdf-{esc(b["id"])}" '
                   f'data-goatcounter-title="{esc(b["title"])}" data-t>Print this book</a>')
            if b.get('_html'):
                main = esc(self.read_url(b))
                acts = f'<a class="act" href="{main}" data-t>Read online</a>{pdf}{self.epub_link(b, "act")}'
            else:
                main = esc(self.pdf_url(b))
                acts = pdf
            sk = f' data-au="{esc(b["author_last"].lower())} {esc(b["author_first"].lower())}" data-ti="{esc(sort_title(b["title"]).lower())}" data-pop="{b["_downloads"] + b["_views"]}"' if sortable else ''
            out.append(f'''<li class="rec" data-id="{esc(b['id'])}"{sk}><a class="main" href="{main}"><span class="t">{esc(b['title'])}</span>
<span class="a">{esc(author_name(b))}{tr}</span>{f'<span class="d">{esc(b["_desc"])}</span>' if b.get('_desc') else ''}</a>
<span class="m mono">{esc(b.get('original_date'))}{pages}</span>
<span class="acts">{acts}</span></li>''')
        return '<ul class="recs">' + ''.join(out) + '</ul>'

    def read_url(self, b, extra=''):
        """where a book's read-online page is: beside the PDFs in R2 when they are there (the pages and their
        pictures are most of the site's size, and GitHub Pages stops at 1 GB), else /read/<id>/ in the site"""
        if self.pdf_base:
            return f"{self.pdf_base}/read/{urllib.parse.quote(b['id'])}/index.html{extra}"
        return f"/read/{urllib.parse.quote(b['id'])}/{extra}"

    def site_origin(self):
        dom = os.environ.get('SITE_DOMAIN', '').strip()
        return f'https://{dom}' if dom else ''

    def reader(self, b, root=None):
        """read/<id>/index.html: the book's web edition in a plain reading page, with a link to the PDF.
        root: where to write it (default: the site). A page written for R2 links the site's own files
        (styles, scripts, home page) by full address, since it is served from files.foggypress.com."""
        src = b['_html'].read_text(encoding='utf-8')
        m = re.search(r'<article class="book".*</article>', src, re.S)
        if not m:
            self.problems.append(f"{b['id']}: web edition has no <article>")
            return
        art = m.group(0)
        if b.get('_desc'):
            art = art.replace('</header>', f'<p class="desc">{esc(b["_desc"])}</p></header>', 1)
        dest = Path(root or self.out) / 'read' / b['id']
        dest.mkdir(parents=True, exist_ok=True)

        def pic(mm):
            # pictures are copied beside the page, under img/
            p = (b['_html'].parent / urllib.parse.unquote(mm.group(1))).resolve()
            if not p.is_file():
                self.problems.append(f"{b['id']}: picture missing ({mm.group(1)})")
                return mm.group(0)
            (dest / 'img').mkdir(exist_ok=True)
            web_picture(p, dest / 'img' / p.name)
            return f'src="img/{urllib.parse.quote(p.name)}"'
        art = re.sub(r'src="(?!https?:|/)([^"]+)"', pic, art)
        gc = ''
        if self.gc_code:
            gc = f'<script data-goatcounter="https://{esc(self.gc_code)}.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>'
        pdf = esc(self.pdf_url(b))
        click = f'rel="nofollow" data-goatcounter-click="pdf-{esc(b["id"])}" data-goatcounter-title="{esc(b["title"])}"'
        doc = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(b['title'])} · Read online · Foggy Press</title>
<meta name="description" content="{esc(b.get('_desc')) or 'Read ' + esc(b['title']) + ' online, free, from Foggy Press.'}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/style.css">
<link rel="stylesheet" href="/assets/book.css">
{self.account_head()}
<script>try{{var t=localStorage.getItem('fp-theme');if(t)document.documentElement.dataset.theme=t}}catch(e){{}}</script>
</head>
<body class="reading" data-book="{esc(b['id'])}">
<div class="readtop">
<nav class="readbar" aria-label="Foggy Press">
  <a class="rb-home" href="/">Foggy Press</a>
  <span class="rb-acts">{'<button class="rb-ask" id="rbask" type="button" aria-expanded="false" aria-controls="askdrawer" hidden data-t>Ask about this book</button>' if self.ask and self.accounts else ''}<a class="rb-pdf" href="{pdf}" {click} data-t>Print this book</a>{self.epub_link(b, 'rb-pdf')}<details class="rb-menu"><summary aria-label="Display: dark mode and language" data-t-attr="aria-label">Aa</summary><div class="rb-pop"><button class="theme" id="theme" type="button">Dark mode</button>{LANG_PICK}</div></details></span>
</nav>
<div class="bsearch" role="search">
  <div class="in">
    <label class="fld" for="find"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <input id="find" type="search" placeholder="Find in this book" data-t-attr="placeholder" autocomplete="off" enterkeyhint="search" aria-describedby="find-count"></label>
    <span class="cnt" id="find-count" aria-live="polite"></span>
    <span class="nav"><button type="button" id="find-prev" aria-label="Previous match" data-t-attr="aria-label" disabled>↑</button><button type="button" id="find-next" aria-label="Next match" data-t-attr="aria-label" disabled>↓</button></span>
    <button type="button" class="lst" id="find-all" aria-expanded="false" aria-controls="find-hits" disabled>All</button>
  </div>
  <div class="hits" id="find-hits" hidden><ol></ol></div>
</div>
</div>
{art}
<footer class="readfoot mono"><a href="/">Foggy Press</a><span data-t>Public-domain books, free to read and print</span><span><a href="{pdf}" {click} data-t>Print this book (PDF)</a> · {self.epub_link(b, '')}</span></footer>
<script src="/assets/i18n.js"></script>
<script src="/assets/site.js" defer></script>
<script src="/assets/search.js" defer></script>
{self.account_script()}
{gc}
</body>
</html>
'''
        prefix = self.site_origin() if root else self.base
        if prefix:
            doc = re.sub(r'(href|src)="/(?!/)', lambda mm: f'{mm.group(1)}="{prefix}/', doc)
        (dest / 'index.html').write_text(doc, encoding='utf-8')

    def read_redirect(self, b):
        """the old address /read/<id>/ on the site, kept for bookmarks and search engines: it sends readers on to
        the page in R2, keeping a search (?q=) and a chapter (#c12)"""
        to = self.read_url(b)
        dest = self.out / 'read' / b['id']
        dest.mkdir(parents=True, exist_ok=True)
        (dest / 'index.html').write_text(f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>{esc(b['title'])} · Foggy Press</title><link rel="canonical" href="{esc(to)}"><meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url={esc(to)}">
<script>location.replace({json.dumps(to)} + location.search + location.hash)</script></head>
<body><p><a href="{esc(to)}">{esc(b['title'])}: read online</a></p></body></html>
''', encoding='utf-8')

    def stage_read(self, root):
        """every read-online page and its pictures under root/read/, for the R2 upload"""
        for b in self.live:
            if b.get('_html'):
                self.reader(b, root)

    def home(self):
        feat = [t for t in self.tags if t['_level'] == 1 and self.by_tag[t['name']]][:FEATURED_MAX]
        fhtml = []
        for i, t in enumerate(feat):
            bs = sorted(self.by_tag[t['name']], key=lambda b: (-b['_downloads'], title_key(b['title'])))
            n = len(bs)
            more = tn('More: all {n} titles →', n) if n > 3 else '<span data-t>Open collection →</span>'
            fhtml.append(f'''<a class="ft" href="/tag/{t['slug']}/"><div class="top"><span class="mono i">{i+1:02d}</span><span class="mono c">{tn('{n} title' if n == 1 else '{n} titles', n)}</span></div>
<h3>{esc(t['name'])}</h3><ul>{''.join(f'<li>{esc(b["title"])}</li>' for b in bs[:3])}</ul><span class="fmore">{more}</span></a>''')
        alltags = sorted([t for t in self.tags if t['_level'] == 2 and self.by_tag[t['name']]], key=lambda t: nat(t['name']))
        nall = len([t for t in self.tags if self.by_tag[t['name']]])
        tiles = ''.join(f'''<a class="ct" href="/tag/{t['slug']}/" data-name="{esc(t['name'].lower())}" data-dl="{self.tag_dl(t['name'])}"><span class="nm">{esc(t['name'])}</span><span class="row mono">{tn('{n} title' if len(self.by_tag[t['name']]) == 1 else '{n} titles', len(self.by_tag[t['name']]))}</span></a>''' for t in alltags)
        featsec = f'''<section class="sec"><div class="sec-h"><h2 data-t>Featured collections</h2><span class="eyebrow">{tn('{n} books · free PDFs', len(self.live))}</span></div><div class="feat">{''.join(fhtml)}</div></section>''' if feat else ''
        # Ask Foggy Press at the top (assets/ask.js draws it); a signed-in reader's history is in the left rail
        ask = ('<section class="sec homeask" id="ask" data-home><div class="sec-h"><h2 data-t>Ask Foggy Press</h2></div>'
               '<noscript><p class="sub" data-t>Ask needs JavaScript.</p></noscript></section>') if self.ask else ''
        body = f'''{ask}{featsec}
<section class="sec"><div class="sec-h"><h2 data-t>Collections</h2>
<div class="sortbar"><span class="eyebrow" data-t>Sort by</span><div class="seg" role="group" aria-label="Sort collections" data-t-attr="aria-label"><button type="button" data-sort="tag" aria-pressed="true" data-t>Tag</button><button type="button" data-sort="popular" aria-pressed="false" data-t>Popular</button></div></div></div>
<div class="grid" id="colls" data-page="{COLLECTIONS_PER_PAGE}">{tiles}</div>
<div class="morebar"><span class="mono" id="shown">{len(alltags)} collections</span><button class="btn ghost sm" id="more" type="button" hidden data-t>More collections</button><a class="allc" href="/tags/">{tn('All {n} collections →', nall)}</a></div>
</section>'''
        self.page('index.html', 'Foggy Press · Printable Books', body, 'home')

    def lists(self):
        by_author = sorted(self.live, key=lambda b: (nat(b['author_last']), nat(b['author_first']), title_key(b['title'])))
        # one folded group per author ("Jane Austen · 10 books"); a click opens that author's titles (assets/site.js)
        parts, cur, groups = [], None, []
        for b in by_author:
            key = (b['author_last'], b['author_first'])
            if groups and groups[-1][0] == key:
                groups[-1][1].append(b)
            else:
                groups.append((key, [b]))
        used = set()
        for (last, first), bs in groups:
            letter = (last or bs[0]['title'])[0].upper()
            if letter != cur:
                parts.append(f'<div class="letter">{esc(letter)}</div>')
                cur = letter
            aid = slugify(f'{last} {first}') or 'author'
            while aid in used:
                aid += '-x'
            used.add(aid)
            name = author_name(bs[0]) or '—'
            parts.append(f'<details class="augrp" id="{esc(aid)}"><summary><span class="n">{esc(name)}</span>'
                         f'<span class="c mono">{tn("{n} book" if len(bs) == 1 else "{n} books", len(bs))}</span></summary>{self.recs(bs)}</details>')
        tools = ('<div class="aubar"><span class="mono">' + tn('{n} authors', len(groups)) + '</span>'
                 '<button type="button" class="chip" id="au-all" data-t>Expand all</button></div>')
        self.page('authors/index.html', 'By author · Foggy Press', f'''<div class="ph"><span class="crumb"><a href="/" data-t>Home</a> / <span data-t>List</span></span><h1 data-t>By author</h1><p class="sub">{tn('{n} books, A to Z by the author’s last name. Read any book online, or print it from its PDF.', len(self.live))}</p></div>{tools}{''.join(parts)}''', 'authors')
        by_title = sorted(self.live, key=lambda b: title_key(b['title']))
        self.page('titles/index.html', 'By title · Foggy Press', f'''<div class="ph"><span class="crumb"><a href="/" data-t>Home</a> / <span data-t>List</span></span><h1 data-t>By title</h1><p class="sub">{tn('{n} books, A to Z, ignoring “The”, “A” and “An”. Read any book online, or print it from its PDF.', len(self.live))}</p></div>{self.recs(by_title)}''', 'titles')
        ts = sorted([t for t in self.tags if self.by_tag[t['name']]], key=lambda t: nat(t['name']))
        groups = []
        for lv in sorted({t['_level'] for t in ts}):
            links = ''.join(f'<a href="/tag/{t["slug"]}/"><span>{esc(t["name"])}</span><span class="mono">{len(self.by_tag[t["name"]])}</span></a>' for t in ts if t['_level'] == lv)
            groups.append(f'<section class="tagsec"><h2 class="eyebrow">{tn('Level {n} collections', lv, level_name(lv)) if lv > 3 else f'<span data-t>{esc(level_name(lv))}</span>'}</h2><div class="taglist">{links}</div></section>')
        self.page('tags/index.html', 'By tag · Foggy Press', f'''<div class="ph"><span class="crumb"><a href="/" data-t>Home</a> / <span data-t>List</span></span><h1 data-t>By tag</h1><p class="sub">{tn('Every tag is a collection. {n} tags.', len(ts))}</p></div>{''.join(groups)}''', 'tags')
        for t in ts:
            bs = sorted(self.by_tag[t['name']], key=lambda b: (nat(b['author_last']), title_key(b['title'])))
            n = len(bs)
            self.page(f'tag/{t["slug"]}/index.html', f'{t["name"]} · Foggy Press', f'''<div class="ph"><span class="crumb"><a href="/" data-t>Home</a> / <a href="/tags/" data-t>Collections</a></span><h1>{esc(t['name'])}</h1><p class="sub">{tn('{n} book' if n == 1 else '{n} books', n)}{' · <span data-t>Featured collection</span>' if t['_level'] == 1 else ''}</p></div>{self.book_sortbar() if n > 1 else ''}{self.recs(bs, sortable=True)}''', '')

    @staticmethod
    def book_sortbar():
        return ('<div class="sortbar booksort"><span class="eyebrow" data-t>Sort by</span><div class="seg" role="group" aria-label="Sort books" data-t-attr="aria-label">'
                '<button type="button" data-bsort="author" aria-pressed="true" data-t>Author</button><button type="button" data-bsort="title" aria-pressed="false" data-t>Title</button>'
                '<button type="button" data-bsort="popular" aria-pressed="false" data-t>Popular</button></div></div>')

    def about(self):
        src = ROOT / 'content/about.md'
        text = src.read_text() if src.exists() else ''
        try:
            import markdown
            body = markdown.markdown(text)
        except Exception:
            body = ''.join(f'<p>{esc(p)}</p>' for p in text.split('\n\n') if p.strip())
        self.page('about/index.html', 'About · Foggy Press', f'<div class="ph"><span class="crumb"><a href="/" data-t>Home</a></span><h1 data-t>About Foggy Press</h1></div><div class="prose" data-t-html="about">{body}</div>{self.contact_form()}', 'about')

    def contact_form(self):
        """Feedback form. Messages are delivered by Web3Forms to the email address its access key was made for;
        the address never appears in the page. hCaptcha supplies the 'I am not a robot' check."""
        key = os.environ.get('WEB3FORMS_KEY', '').strip()
        off = '' if key else ' disabled'
        note = '' if key else '<p class="formnote" id="cf-status" data-t>The form will open shortly.</p>'
        return f'''<section class="contact" aria-labelledby="cf-h">
<h2 id="cf-h" data-t>Please send us questions or feedback!</h2>
<form id="contact" class="cform" data-key="{esc(key)}" novalidate>
  <div class="fld"><label for="cf-name" data-t>Your name</label><input id="cf-name" name="name" type="text" autocomplete="name" required{off}></div>
  <div class="fld"><label for="cf-email" data-t>Your email</label><input id="cf-email" name="email" type="email" autocomplete="email" required{off}></div>
  <div class="fld"><label for="cf-msg" data-t>Message</label><textarea id="cf-msg" name="message" rows="6" required{off}></textarea></div>
  <input type="checkbox" name="botcheck" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
  <div class="h-captcha" data-captcha="true" data-sitekey="50b2fe65-b00b-4b9e-ad62-3ba471098be2"></div>
  <div class="cf-row"><button class="btn" type="submit"{off} data-t>Send message</button></div>
  {note or '<p class="formnote" id="cf-status" role="status"></p>'}
</form></section>
{'<script src="https://js.hcaptcha.com/1/api.js" async defer></script>' if key else ''}'''


    def account_pages(self):
        """My books (/account/), a reading list (/list/?id=) and the Privacy page; drawn by assets/account.js"""
        if not self.accounts:
            return
        nojs = '<noscript><p class="sub" data-t>Accounts need JavaScript.</p></noscript>'
        self.page('account/index.html', 'My books · Foggy Press', f'<div id="acct"><div class="ph"><h1 data-t>My books</h1>{nojs}</div></div>', 'account',
                  'Your saved books, reading lists and history on Foggy Press.')
        self.page('request/index.html', 'Request a book · Foggy Press', f'<div id="request"><div class="ph"><h1 data-t>Request a book</h1>{nojs}</div></div>', 'request',
                  'Ask Foggy Press to add a public-domain book from its approved sources.')
        self.page('list/index.html', 'Reading list · Foggy Press', f'<div id="list"><div class="ph"><h1 data-t>Reading list</h1>{nojs}</div></div>', 'account')
        src = ROOT / 'content/privacy.md'
        text = src.read_text() if src.exists() else ''
        try:
            import markdown
            body = markdown.markdown(text)
        except Exception:
            body = ''.join(f'<p>{esc(p)}</p>' for p in text.split('\n\n') if p.strip())
        self.page('privacy/index.html', 'Privacy · Foggy Press', f'<div class="ph"><span class="crumb"><a href="/" data-t>Home</a></span><h1 data-t>Privacy</h1></div><div class="prose" data-t-html="privacy">{body}</div>', 'privacy',
                  'What Foggy Press keeps about readers, and how to download or delete it.')

    def ask_page(self):
        """/ask/: Ask Foggy Press, drawn by assets/ask.js"""
        if not self.ask:
            return
        self.page('ask/index.html', 'Ask Foggy Press', '<div id="ask" class="ask"><div class="ask-h"><h1 data-t>Ask Foggy Press</h1></div>'
                  '<noscript><p class="sub" data-t>Ask needs JavaScript.</p></noscript></div>', 'ask',
                  'Ask for a book recommendation, an explanation of a book, or help finding a passage in the Foggy Press books.')

    def not_found(self):
        self.page('404.html', 'Not found · Foggy Press', '<div class="ph"><h1 data-t>Not found</h1><p class="sub"><span data-t>That page isn’t here.</span> <a href="/" style="color:var(--accent)" data-t>Go to the home page</a></p></div>')

    def copy_assets(self):
        for d in ('assets', 'admin'):
            shutil.copytree(ROOT / d, self.out / d, dirs_exist_ok=True)
        # stamp the admin page's script and styles with the build time, so browsers fetch the new ones after each build
        v = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M')
        ai = self.out / 'admin' / 'index.html'
        ai.write_text(re.sub(r'(href|src)="((?:\.\./assets/style|admin)\.(?:css|js))"', lambda m: f'{m.group(1)}="{m.group(2)}?v={v}"', ai.read_text()))
        if not self.pdf_base:  # with PDF_BASE set, the PDFs and EPUBs live in R2 and stay out of the Pages site (1 GB cap)
            self.stage_pdfs(self.out / 'pdf')
            self.stage_epubs(self.out / 'epub')
        css = self.files / 'pipeline' / 'web' / 'book.css'
        if css.exists():
            shutil.copyfile(css, self.out / 'assets' / 'book.css')
        for b in self.live:
            if b.get('_html'):
                if self.pdf_base:
                    self.read_redirect(b)
                else:
                    self.reader(b)
        (self.out / 'robots.txt').write_text('User-agent: *\nDisallow: /admin/\n')
        dom = os.environ.get('SITE_DOMAIN', '').strip()
        if dom:
            (self.out / 'CNAME').write_text(dom + '\n')
        (self.out / '.nojekyll').write_text('')

    def translations(self):
        """assets/i18n/<code>.json for the language menu (assets/i18n.js), from build/i18n/<code>.txt:
        one translation per line in the order of build/i18n/_keys.txt, then whole pages: "@about <hash>" and the
        About page in Markdown, "@privacy <hash>" and the Privacy page. A page's text is used only while <hash>
        matches content/<name>.md (the first 10 characters of its SHA-1), so an edited page shows in English
        until it is translated again."""
        import hashlib
        src = ROOT / 'build' / 'i18n'
        keys = (src / '_keys.txt').read_text(encoding='utf-8').splitlines()
        out = self.out / 'assets' / 'i18n'
        out.mkdir(parents=True, exist_ok=True)

        def page_hash(name):
            md = ROOT / 'content' / f'{name}.md'
            return hashlib.sha1(md.read_bytes()).hexdigest()[:10] if md.exists() else None

        for f in sorted(src.glob('[a-z]*.txt')):
            lines = f.read_text(encoding='utf-8').split('\n')
            cut = next((i for i, l in enumerate(lines) if l.startswith('@')), len(lines))
            phrases = [l.strip() for l in lines[:cut]]
            while phrases and not phrases[-1]:
                phrases.pop()
            if len(phrases) != len(keys):
                self.problems.append(f'{f.name}: {len(phrases)} phrases for {len(keys)} keys; language left out')
                continue
            d = {}
            for k, v in zip(keys, phrases):
                for ph in re.findall(r'\{\w+\}', k):
                    singular = ph == '{n}' and not re.search(r's\b', k.split('{n}', 1)[1][:12])   # "{n} book": "one book" may drop the number
                    if ph not in v and not singular:
                        self.problems.append(f'{f.name}: "{v}" is missing {ph}')
                d[k] = v
            # whole pages after the phrases: "@about <hash>", "@privacy <hash>", each followed by its Markdown
            starts = [i for i in range(cut, len(lines)) if lines[i].startswith('@')]
            for n, i in enumerate(starts):
                head = lines[i][1:].split()
                name, h = head[0], (head[1] if len(head) > 1 else '')
                if h != page_hash(name):
                    continue   # the English page changed since this translation: show it in English
                body = '\n'.join(lines[i + 1:starts[n + 1] if n + 1 < len(starts) else len(lines)])
                try:
                    import markdown
                    d['@' + name] = markdown.markdown(body)
                except Exception:
                    d['@' + name] = ''.join(f'<p>{esc(p)}</p>' for p in body.split('\n\n') if p.strip())
            (out / f'{f.stem}.json').write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

    def admin_data(self):
        """Facts the admin pages show beside the catalog: page counts, sizes, downloads, and PDFs not yet in the catalog."""
        known = {pdf_repo_path(b.get('github_pdf')) for b in self.books}
        try:      # PDFs merged in from the second repo (see build.yml)
            lib = set((self.files / '.library-pdfs').read_text(encoding='utf-8').split('\n'))
        except OSError:
            lib = set()
        unlisted = []
        for p in sorted(self.files.glob('books/*/*/output/*.pdf')):
            rel = p.relative_to(self.files).as_posix()
            if rel in known:
                continue
            repo = 'foggy-press-library' if rel in lib else 'foggy-press-files'
            m = re.match(r'(.+?): (.+)\. Foggy Press, \d{4}\.pdf$', p.name)
            last, first = '', ''
            if m and ', ' in m.group(1):
                last, first = m.group(1).split(', ', 1)
            elif m:
                last = m.group(1)
            unlisted.append({'id': p.parent.parent.name, 'author_last': last, 'author_first': first,
                             'title': m.group(2) if m else p.stem,
                             'github_dir': 'https://github.com/wmclemens/%s/tree/main/' % repo + urllib.parse.quote(p.parent.parent.relative_to(self.files).as_posix()),
                             'github_pdf': 'https://github.com/wmclemens/%s/blob/main/' % repo + urllib.parse.quote(rel)})
        stats = {b['id']: {'pages': b['_pages'], 'mb': b['_mb'], 'downloads': b['_downloads'], 'views': b['_views'], 'live': b in self.live} for b in self.books}
        (self.out / 'admin').mkdir(parents=True, exist_ok=True)
        rep = report.build_report(self.gc_code, os.environ.get('GOATCOUNTER_TOKEN', '').strip(),
                                  os.environ.get('CLOUDFLARE_API_TOKEN', '').strip(), os.environ.get('CLOUDFLARE_ZONE_ID', '').strip(),
                                  self.sb_url if self.accounts else '', self.sb_key)
        saved = (rep.get('accounts') or {}).pop('saved', {})
        for bid, st in stats.items():
            if self.accounts:
                st['saved'] = saved.get(bid, 0)
        (self.out / 'admin/report.json').write_text(json.dumps(rep, ensure_ascii=False), encoding='utf-8')
        (self.out / 'admin/stats.json').write_text(json.dumps({'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'books': stats, 'unlisted': unlisted, 'problems': self.problems,
                                                               # the admin Chat tab asks the ask function for its figures
                                                               'ask': f'{self.sb_url}/functions/v1/ask' if self.ask else '', 'ask_key': self.sb_key if self.ask else ''}, ensure_ascii=False))

    def stage_pdfs(self, dest):
        dest = Path(dest)
        dest.mkdir(parents=True, exist_ok=True)
        for b in self.live:
            dst = dest / f"{b['id']}.pdf"
            try:  # a hard link where it can: a full copy of every PDF used several GB of the runner's disk
                if dst.exists():
                    dst.unlink()
                os.link(b['_src'], dst)
            except OSError:
                shutil.copyfile(b['_src'], dst)

    def stage_epubs(self, dest):
        """an EPUB for every live book with a web edition (epub.py); unchanged books give identical files"""
        dest = Path(dest)
        dest.mkdir(parents=True, exist_ok=True)
        n = 0
        for b in self.live:
            if not b.get('_html'):
                continue
            meta = {'id': b['id'], 'title': b['title'], 'author': author_name(b), 'date': b.get('foggy_press_date') or '',
                    'description': b.get('_desc') or '', 'lang': 'en'}
            try:
                if epub.make_epub(b['_html'], dest / f"{b['id']}.epub", meta, web_picture):
                    n += 1
            except Exception as e:  # one bad book must not stop the site
                self.problems.append(f"{b['id']}: EPUB not made ({e})")
        return n

    def build(self):
        if self.out.exists():
            shutil.rmtree(self.out)
        self.out.mkdir(parents=True)
        self.prepare()
        self.copy_assets()
        self.home(); self.lists(); self.about(); self.account_pages(); self.ask_page(); self.not_found(); self.search(); self.translations()
        britannica.build(self)
        self.admin_data()
        print(f'Built {len(self.live)} live books of {len(self.books)} records, {len(self.tags)} tags.')
        for p in self.problems:
            print('warning:', p, file=sys.stderr)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', required=True, help='checkout of foggy-press-files')
    ap.add_argument('--out', default=str(ROOT / '_site'))
    ap.add_argument('--stage-pdfs', metavar='DIR', help='only copy live PDFs to DIR/<id>.pdf (for the R2 upload) and stop')
    a = ap.parse_args()
    site = Site(a.files, a.out)
    if a.stage_pdfs:
        site.prepare()
        site.stage_pdfs(a.stage_pdfs)
        ne = site.stage_epubs(Path(a.stage_pdfs) / 'epub')
        if site.pdf_base:
            # files.foggypress.com: crawlers may read the read-online pages but not fetch the downloads,
            # which Cloudflare refuses to bots anyway (build/cloudflare_rules.py)
            (Path(a.stage_pdfs) / 'robots.txt').write_text('User-agent: *\nDisallow: /*.pdf$\nDisallow: /epub/\nAllow: /\n')
            site.stage_read(a.stage_pdfs)
            britannica.stage(site, a.stage_pdfs)
        print(f'Staged {len(site.live)} PDFs and {ne} EPUBs in {a.stage_pdfs}.')
        for p in site.problems:
            print('warning:', p, file=sys.stderr)
    else:
        site.build()
