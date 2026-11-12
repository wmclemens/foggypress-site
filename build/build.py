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
    only copies each live book's PDF to _pdfs/<id>.pdf, for upload to R2.
"""
import argparse, datetime, html, json, os, re, shutil, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FEATURED_MAX = 3
COLLECTIONS_PER_PAGE = 25


def esc(s):
    return html.escape(str(s or ''), quote=True)


def slugify(s):
    s = s.lower().replace('&', 'and')
    s = re.sub(r"[’']", '', s)
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def sort_title(t):
    return re.sub(r'^(The|A|An) ', '', t)


def author_name(b):
    return f"{b['author_first']} {b['author_last']}".strip()


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


def fetch_downloads(code, token):
    """Total clicks per path from GoatCounter. Returns {} on any failure."""
    if not (code and token):
        return {}
    counts, after = {}, None
    try:
        for _ in range(50):
            q = {'start': '2026-01-01T00:00:00Z', 'limit': '100'}
            if after:
                q['exclude_paths'] = ','.join(after)
            url = f'https://{code}.goatcounter.com/api/v0/stats/hits?' + urllib.parse.urlencode(q)
            req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            for h in data.get('hits', []):
                counts[h['path']] = counts.get(h['path'], 0) + int(h.get('count', 0))
            if not data.get('more'):
                break
            after = [str(h['path_id']) for h in data.get('hits', [])] + (after or [])
    except Exception as e:
        print(f'warning: could not fetch download counts: {e}', file=sys.stderr)
    return counts


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
        self.today = datetime.date.today().isoformat()
        self.problems = []
        # Without a custom domain, GitHub Pages serves the site under /<repo-name>/.
        repo = os.environ.get('GITHUB_REPOSITORY', '')
        self.base = '' if os.environ.get('SITE_DOMAIN', '').strip() or not repo else '/' + repo.split('/')[-1]
        self.pdf_base = os.environ.get('PDF_BASE', '').strip().rstrip('/')

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
                    self.tags.append({'name': t, 'featured': False})
                    tag_names.add(t)
        for t in self.tags:
            t['slug'] = slugify(t['name'])
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
        navhtml = ''.join(f'<a href="/{h}/"{" aria-current=page" if current == h else ""}><span>{l}</span><span class="mono">{n}</span></a>' for h, l, n in nav)
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
<script>try{{var t=localStorage.getItem('fp-theme');if(t)document.documentElement.dataset.theme=t}}catch(e){{}}</script>
</head>
<body>
<div class="wrap shell">
  <a class="brand" href="/"><span class="n">Foggy Press</span><span class="s">Printable Books</span></a>
  <aside class="rail">
    <div><div class="eyebrow" style="margin-bottom:.6rem">List books</div><nav aria-label="Lists">{navhtml}</nav></div>
    <nav aria-label="About"><a href="/about/"{" aria-current=page" if current == 'about' else ""}><span>About Foggy Press</span><span class="mono">→</span></a></nav>
    <button class="theme" id="theme" type="button">Dark mode</button>
  </aside>
  <main>{body}</main>
  <footer class="foot mono"><span>Foggy Press · public-domain books, free to print</span><span>{len(self.live)} books</span></footer>
</div>
<script src="/assets/site.js" defer></script>
{gc}
</body>
</html>
'''
        if self.base:
            doc = re.sub(r'(href|src)="/(?!/)', lambda m: f'{m.group(1)}="{self.base}/', doc)
        dest = self.out / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(doc)

    def recs(self, books):
        out = []
        for b in books:
            tr = f" · tr. {esc(b['translator'])}" if b.get('translator') else ''
            pages = f" · {b['_pages']} pp" if b.get('_pages') else ''
            pdf = (f'<a class="act" href="{esc(self.pdf_url(b))}" data-goatcounter-click="pdf-{esc(b["id"])}" '
                   f'data-goatcounter-title="{esc(b["title"])}">Print this book</a>')
            if b.get('_html'):
                main = f'/read/{esc(b["id"])}/'
                acts = f'<a class="act" href="{main}">Read online</a>{pdf}'
            else:
                main = esc(self.pdf_url(b))
                acts = pdf
            out.append(f'''<li class="rec"><a class="main" href="{main}"><span class="t">{esc(b['title'])}</span>
<span class="a">{esc(author_name(b))}{tr}</span>{f'<span class="d">{esc(b["_desc"])}</span>' if b.get('_desc') else ''}</a>
<span class="m mono">{esc(b.get('original_date'))}{pages}</span>
<span class="acts">{acts}</span></li>''')
        return '<ul class="recs">' + ''.join(out) + '</ul>'

    def reader(self, b):
        """/read/<id>/: the book's web edition in a plain reading page, with a link to the PDF"""
        src = b['_html'].read_text(encoding='utf-8')
        m = re.search(r'<article class="book".*</article>', src, re.S)
        if not m:
            self.problems.append(f"{b['id']}: web edition has no <article>")
            return
        art = m.group(0)
        if b.get('_desc'):
            art = art.replace('</header>', f'<p class="desc">{esc(b["_desc"])}</p></header>', 1)
        dest = self.out / 'read' / b['id']
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
        click = f'data-goatcounter-click="pdf-{esc(b["id"])}" data-goatcounter-title="{esc(b["title"])}"'
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
<script>try{{var t=localStorage.getItem('fp-theme');if(t)document.documentElement.dataset.theme=t}}catch(e){{}}</script>
</head>
<body class="reading">
<nav class="readbar" aria-label="Foggy Press">
  <a class="rb-home" href="/">Foggy Press</a>
  <span class="rb-acts"><a class="rb-pdf" href="{pdf}" {click}>Print this book</a><button class="theme" id="theme" type="button">Dark mode</button></span>
</nav>
{art}
<footer class="readfoot mono"><a href="/">Foggy Press</a><span>Public-domain books, free to read and print</span><a href="{pdf}" {click}>Print this book (PDF)</a></footer>
<script src="/assets/site.js" defer></script>
{gc}
</body>
</html>
'''
        if self.base:
            doc = re.sub(r'(href|src)="/(?!/)', lambda mm: f'{mm.group(1)}="{self.base}/', doc)
        (dest / 'index.html').write_text(doc, encoding='utf-8')

    def home(self):
        feat = [t for t in self.tags if t.get('featured') and self.by_tag[t['name']]][:FEATURED_MAX]
        fhtml = []
        for i, t in enumerate(feat):
            bs = sorted(self.by_tag[t['name']], key=lambda b: (-b['_downloads'], sort_title(b['title'])))
            n = len(bs)
            more = f'More: all {n} titles →' if n > 3 else 'Open collection →'
            fhtml.append(f'''<a class="ft" href="/tag/{t['slug']}/"><div class="top"><span class="mono i">{i+1:02d}</span><span class="mono c">{n} {'title' if n == 1 else 'titles'}</span></div>
<h3>{esc(t['name'])}</h3><ul>{''.join(f'<li>{esc(b["title"])}</li>' for b in bs[:3])}</ul><span class="fmore">{more}</span></a>''')
        alltags = sorted([t for t in self.tags if self.by_tag[t['name']]], key=lambda t: t['name'].lower())
        tiles = ''.join(f'''<a class="ct" href="/tag/{t['slug']}/" data-name="{esc(t['name'].lower())}" data-dl="{self.tag_dl(t['name'])}"><span class="nm">{esc(t['name'])}</span><span class="row mono"><span>{len(self.by_tag[t['name']])} {'title' if len(self.by_tag[t['name']]) == 1 else 'titles'}</span></span></a>''' for t in alltags)
        featsec = f'''<section class="sec"><div class="sec-h"><h2>Featured collections</h2><span class="eyebrow">{len(self.live)} books · free PDFs</span></div><div class="feat">{''.join(fhtml)}</div></section>''' if feat else ''
        body = f'''{featsec}
<section class="sec"><div class="sec-h"><h2>All collections</h2>
<div class="sortbar"><span class="eyebrow">Sort by</span><div class="seg" role="group" aria-label="Sort collections"><button type="button" data-sort="tag" aria-pressed="true">Tag</button><button type="button" data-sort="popular" aria-pressed="false">Popular</button></div></div></div>
<div class="grid" id="colls" data-page="{COLLECTIONS_PER_PAGE}">{tiles}</div>
<div class="morebar"><span class="mono" id="shown">{len(alltags)} collections</span><button class="btn ghost sm" id="more" type="button" hidden>More collections</button></div>
</section>'''
        self.page('index.html', 'Foggy Press · Printable Books', body, 'home')

    def lists(self):
        by_author = sorted(self.live, key=lambda b: (b['author_last'].lower(), b['author_first'].lower(), sort_title(b['title'])))
        parts, cur = [], None
        for b in by_author:
            letter = (b['author_last'] or b['title'])[0].upper()
            if letter != cur:
                parts.append(f'<div class="letter">{esc(letter)}</div>')
                cur = letter
            parts.append(self.recs([b]))
        self.page('authors/index.html', 'By author · Foggy Press', f'''<div class="ph"><span class="crumb"><a href="/">Home</a> / List</span><h1>By author</h1><p class="sub">{len(self.live)} books, A to Z by the author’s last name. Read any book online, or print it from its PDF.</p></div>{''.join(parts)}''', 'authors')
        by_title = sorted(self.live, key=lambda b: sort_title(b['title']).lower())
        self.page('titles/index.html', 'By title · Foggy Press', f'''<div class="ph"><span class="crumb"><a href="/">Home</a> / List</span><h1>By title</h1><p class="sub">{len(self.live)} books, A to Z, ignoring “The”, “A” and “An”. Read any book online, or print it from its PDF.</p></div>{self.recs(by_title)}''', 'titles')
        ts = sorted([t for t in self.tags if self.by_tag[t['name']]], key=lambda t: t['name'].lower())
        links = ''.join(f'<a href="/tag/{t["slug"]}/"><span>{esc(t["name"])}</span><span class="mono">{len(self.by_tag[t["name"]])}</span></a>' for t in ts)
        self.page('tags/index.html', 'By tag · Foggy Press', f'''<div class="ph"><span class="crumb"><a href="/">Home</a> / List</span><h1>By tag</h1><p class="sub">Every tag is a collection. {len(ts)} tags.</p></div><div class="taglist">{links}</div>''', 'tags')
        for t in ts:
            bs = sorted(self.by_tag[t['name']], key=lambda b: (b['author_last'].lower(), sort_title(b['title'])))
            n = len(bs)
            self.page(f'tag/{t["slug"]}/index.html', f'{t["name"]} · Foggy Press', f'''<div class="ph"><span class="crumb"><a href="/">Home</a> / <a href="/tags/">Collections</a></span><h1>{esc(t['name'])}</h1><p class="sub">{n} {'book' if n == 1 else 'books'}{' · Featured collection' if t.get('featured') else ''}</p></div>{self.recs(bs)}''', '')

    def about(self):
        src = ROOT / 'content/about.md'
        text = src.read_text() if src.exists() else ''
        try:
            import markdown
            body = markdown.markdown(text)
        except Exception:
            body = ''.join(f'<p>{esc(p)}</p>' for p in text.split('\n\n') if p.strip())
        self.page('about/index.html', 'About · Foggy Press', f'<div class="ph"><span class="crumb"><a href="/">Home</a></span><h1>About Foggy Press</h1></div><div class="prose">{body}</div>{self.contact_form()}', 'about')

    def contact_form(self):
        """Feedback form. Messages are delivered by Web3Forms to the email address its access key was made for;
        the address never appears in the page. hCaptcha supplies the 'I am not a robot' check."""
        key = os.environ.get('WEB3FORMS_KEY', '').strip()
        off = '' if key else ' disabled'
        note = '' if key else '<p class="formnote" id="cf-status">The form will open shortly.</p>'
        return f'''<section class="contact" aria-labelledby="cf-h">
<h2 id="cf-h">Please send us questions or feedback!</h2>
<form id="contact" class="cform" data-key="{esc(key)}" novalidate>
  <div class="fld"><label for="cf-name">Your name</label><input id="cf-name" name="name" type="text" autocomplete="name" required{off}></div>
  <div class="fld"><label for="cf-email">Your email</label><input id="cf-email" name="email" type="email" autocomplete="email" required{off}></div>
  <div class="fld"><label for="cf-msg">Message</label><textarea id="cf-msg" name="message" rows="6" required{off}></textarea></div>
  <input type="checkbox" name="botcheck" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
  <div class="h-captcha" data-captcha="true" data-sitekey="50b2fe65-b00b-4b9e-ad62-3ba471098be2"></div>
  <div class="cf-row"><button class="btn" type="submit"{off}>Send message</button></div>
  {note or '<p class="formnote" id="cf-status" role="status"></p>'}
</form></section>
{'<script src="https://js.hcaptcha.com/1/api.js" async defer></script>' if key else ''}'''


    def not_found(self):
        self.page('404.html', 'Not found · Foggy Press', '<div class="ph"><h1>Not found</h1><p class="sub">That page isn’t here. <a href="/" style="color:var(--accent)">Go to the home page</a>.</p></div>')

    def copy_assets(self):
        for d in ('assets', 'admin'):
            shutil.copytree(ROOT / d, self.out / d, dirs_exist_ok=True)
        # stamp the admin page's script and styles with the build time, so browsers fetch the new ones after each build
        v = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M')
        ai = self.out / 'admin' / 'index.html'
        ai.write_text(re.sub(r'(href|src)="((?:\.\./assets/style|admin)\.(?:css|js))"', lambda m: f'{m.group(1)}="{m.group(2)}?v={v}"', ai.read_text()))
        if not self.pdf_base:  # with PDF_BASE set, the PDFs live in R2 and stay out of the Pages site (1 GB cap)
            self.stage_pdfs(self.out / 'pdf')
        css = self.files / 'pipeline' / 'web' / 'book.css'
        if css.exists():
            shutil.copyfile(css, self.out / 'assets' / 'book.css')
        for b in self.live:
            if b.get('_html'):
                self.reader(b)
        (self.out / 'robots.txt').write_text('User-agent: *\nDisallow: /admin/\n')
        dom = os.environ.get('SITE_DOMAIN', '').strip()
        if dom:
            (self.out / 'CNAME').write_text(dom + '\n')
        (self.out / '.nojekyll').write_text('')

    def admin_data(self):
        """Facts the admin pages show beside the catalog: page counts, sizes, downloads, and PDFs not yet in the catalog."""
        known = {pdf_repo_path(b.get('github_pdf')) for b in self.books}
        unlisted = []
        for p in sorted(self.files.glob('books/*/*/output/*.pdf')):
            rel = p.relative_to(self.files).as_posix()
            if rel in known:
                continue
            m = re.match(r'(.+?): (.+)\. Foggy Press, \d{4}\.pdf$', p.name)
            last, first = '', ''
            if m and ', ' in m.group(1):
                last, first = m.group(1).split(', ', 1)
            elif m:
                last = m.group(1)
            unlisted.append({'id': p.parent.parent.name, 'author_last': last, 'author_first': first,
                             'title': m.group(2) if m else p.stem,
                             'github_dir': 'https://github.com/wmclemens/foggy-press-files/tree/main/' + urllib.parse.quote(p.parent.parent.relative_to(self.files).as_posix()),
                             'github_pdf': 'https://github.com/wmclemens/foggy-press-files/blob/main/' + urllib.parse.quote(rel)})
        stats = {b['id']: {'pages': b['_pages'], 'mb': b['_mb'], 'downloads': b['_downloads'], 'views': b['_views'], 'live': b in self.live} for b in self.books}
        (self.out / 'admin').mkdir(parents=True, exist_ok=True)
        (self.out / 'admin/stats.json').write_text(json.dumps({'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'books': stats, 'unlisted': unlisted, 'problems': self.problems}, ensure_ascii=False))

    def stage_pdfs(self, dest):
        dest = Path(dest)
        dest.mkdir(parents=True, exist_ok=True)
        for b in self.live:
            shutil.copyfile(b['_src'], dest / f"{b['id']}.pdf")

    def build(self):
        if self.out.exists():
            shutil.rmtree(self.out)
        self.out.mkdir(parents=True)
        self.prepare()
        self.copy_assets()
        self.home(); self.lists(); self.about(); self.not_found()
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
        print(f'Staged {len(site.live)} PDFs in {a.stage_pdfs}.')
    else:
        site.build()
