"""The 1911 Encyclopædia Britannica on foggypress.com: one read-online page per article.

Articles are made in foggy-press-files by pipeline/britannica/ and live under
books/1911Britannica/volume-NN/output/html/ (articles/<slug>.html, img/, index.json).
This module turns them into (plus EPUB and Kindle downloads: stage_epubs() at the end):

  /britannica/                 the work's front page: about, find an article, the volumes
  /britannica/volume-N/        every article in volume N, A to Z
  /britannica/<slug>/          one article, in the Foggy Press reading page, printable
  /britannica/img/             pictures
  /britannica/titles.json      [slug, title, volume, page] for "find an article"
  /britannica/search/          full-text index of the articles (same format as search_index.py,
                               one row per article)

When the site's files are on Cloudflare R2 (PDF_BASE set), the article pages, pictures, titles.json and
the search index go there too, under files.foggypress.com/britannica/ (staged by stage(), uploaded by
build.yml with the read-online pages), and only the front and volume pages stay on GitHub Pages:
all 29 volumes come to about 1 GB, the whole Pages limit.

Nothing is built unless catalog/reference.json has "britannica": {"live": true}, or the
environment sets BRITANNICA=1 (for a preview build). "listed": false keeps it out of the left rail.
"""
import html
import json
import os
import re
import shutil
from pathlib import Path

import search_index

TITLE = 'Encyclopædia Britannica (1911)'
LONG_TITLE = 'Encyclopædia Britannica, Eleventh Edition (1911)'
VOLUMES = 29
SUPPLEMENT = (30, 31, 32)  # the three 1922 volumes that, with the 29, made the Twelfth Edition
SUP_TITLE = 'Encyclopædia Britannica (1922 supplement)'


def vol_title(v):
    return SUP_TITLE if v['n'] in SUPPLEMENT else TITLE


def esc(s):
    return html.escape(str(s or ''), quote=True)


def _conf():
    p = Path(__file__).resolve().parent.parent / 'catalog' / 'reference.json'
    try:
        return json.loads(p.read_text()).get('britannica', {})
    except (OSError, ValueError):
        return {}


def enabled(site=None):
    return os.environ.get('BRITANNICA', '').strip() == '1' or bool(_conf().get('live'))


def listed(site=None):
    return enabled() and _conf().get('listed', True) is not False


def data_base(site):
    """where the article pages and their data are: R2 when the site's files are there, else the site itself"""
    return f'{site.pdf_base}/britannica/' if site.pdf_base else '/britannica/'


def art_url(site, slug, extra=''):
    return f'{site.pdf_base}/britannica/{slug}/index.html{extra}' if site.pdf_base else f'/britannica/{slug}/{extra}'


def load(files):
    vols = []
    for d in sorted((Path(files) / 'books' / '1911Britannica').glob('volume-*/output/html')):
        ip = d / 'index.json'
        if not ip.exists():
            continue
        data = json.loads(ip.read_text(encoding='utf-8'))
        vols.append({'n': int(data['volume']), 'dir': d, 'articles': data['articles'], 'edition': int(data.get('edition', 1911))})
    return sorted(vols, key=lambda v: v['n'])


def group_key(title):
    """the first two letters, accents dropped ("Ælfric" and "Aelia" both go under "Ae")"""
    import unicodedata
    t = title.replace('Æ', 'Ae').replace('æ', 'ae').replace('Œ', 'Oe').replace('œ', 'oe')
    t = ''.join(c for c in unicodedata.normalize('NFKD', t) if not unicodedata.combining(c))
    t = re.sub(r"[^A-Za-z]", '', t)
    return (t[:2] or '?').capitalize()


def build(site):
    """the front and volume pages, and (when the site keeps its own files) the articles themselves"""
    if not enabled(site):
        return
    vols = load(site.files)
    if not vols:
        return
    if not site.pdf_base:
        stage(site, site.out, vols)
    else:
        search_data(site, site.out, vols)
    front_page(site, vols)
    for v in vols:
        volume_page(site, v)


def stage(site, root, vols=None):
    """article pages and pictures under root/britannica/ (R2, or the site; on the site, the search data too)"""
    if not enabled(site):
        return 0
    vols = vols if vols is not None else load(site.files)
    if not vols:
        return 0
    out = Path(root) / 'britannica'
    out.mkdir(parents=True, exist_ok=True)
    remote = Path(root) != Path(site.out)
    allarts = [(v, a) for v in vols for a in v['articles']]
    for v in vols:
        src = v['dir'] / 'img'
        if src.is_dir():
            shutil.copytree(src, out / 'img', dirs_exist_ok=True)
    for i, (v, a) in enumerate(allarts):
        art = (v['dir'] / 'articles' / f"{a['slug']}.html").read_text(encoding='utf-8')
        prev_a = allarts[i - 1] if i > 0 else None
        next_a = allarts[i + 1] if i + 1 < len(allarts) else None
        article_page(site, out, v, a, art, prev_a, next_a, remote)
    if not remote:
        search_data(site, root, vols)
    print(f'Britannica: {len(allarts)} article pages in {len(vols)} volume(s).')
    return len(allarts)


def search_data(site, root, vols):
    """titles.json and the article search index, always on the site itself: the front page reads them,
    and fetching them from files.foggypress.com depends on R2's cross-site (CORS) rule, which failed on
    16 Nov 2026. About 8 MB a volume."""
    out = Path(root) / 'britannica'
    out.mkdir(parents=True, exist_ok=True)
    allarts = [(v, a) for v in vols for a in v['articles']]
    rows = [({'id': a['slug'], 't': a['title'], 'v': v['n'], 'p': a['page']},
             (v['dir'] / 'articles' / f"{a['slug']}.html").read_text(encoding='utf-8')) for v, a in allarts]
    (out / 'titles.json').write_text(json.dumps([[a['slug'], a['title'], v['n'], a['page']] for v, a in allarts if not a.get('front')],
                                                ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    nw, ns = search_index.write_index(out / 'search', rows)
    # for Ask Foggy Press (supabase/functions/ask/books.ts): where the article pages are and which volumes are in.
    # Rebuilt from whatever volumes are there, so a new volume reaches Ask with the next build.
    page = (f'{site.pdf_base}/britannica/{{slug}}/index.html' if site.pdf_base
            else f'{site.site_origin() or ""}{site.base}/britannica/{{slug}}/')
    (out / 'ask.json').write_text(json.dumps({'page': page, 'volumes': [v['n'] for v in vols], 'articles': len(rows)}), encoding='utf-8')
    print(f'Britannica search: {len(allarts)} articles, {nw} words in {ns} files.')


def front_page(site, vols):
    have = {v['n']: v for v in vols}
    vl, sl = [], []
    for n in list(range(1, VOLUMES + 1)) + list(SUPPLEMENT):
        v = have.get(n)
        if v:
            arts = [a for a in v['articles'] if not a.get('front')]
            span = f"{arts[0]['title']} to {arts[-1]['title']}" if arts else ''
            if not arts:  # Volume 29: the index, contents and contributors
                arts, span = v['articles'], 'Index, classified contents and contributors'
            (sl if n in SUPPLEMENT else vl).append(f'<li class="rec"><a class="main" href="/britannica/volume-{n}/"><span class="t">Volume {n}</span>'
                      f'<span class="a">{esc(span)}</span></a><span class="m mono">{len(arts):,} articles</span></li>')
    n_arts = sum(1 for v in vols for a in v['articles'] if not a.get('front'))
    n1911 = sum(1 for v in vols if v['n'] <= VOLUMES)
    soon = '' if n1911 == VOLUMES else ('<p class="sub">Only Volume 1 is here so far. The other 28 are on the way.</p>' if len(vols) == 1
            else f'<p class="sub">{n1911} of the {VOLUMES} volumes are here so far. The rest are on the way.</p>')
    sup = ''
    if sl:
        sup = ('<section class="sec"><div class="sec-h"><h2>The 1922 supplement</h2><span class="eyebrow">Volumes 30–32</span></div>'
               '<p class="sub">Three new volumes published in 1922 on the years 1910 to 1921, the World War above all. With the 29 they made the Twelfth Edition.</p>'
               f'<ul class="recs">{"".join(sl)}</ul></section>')
    body = f'''<link rel="stylesheet" href="/assets/britannica.css"><div class="ph"><span class="crumb"><a href="/">Home</a> / Reference</span><h1>{esc(TITLE)}</h1>
<p class="sub">The Eleventh Edition of the Britannica, published 1910–1911 in 29 volumes, often called the last great encyclopaedia of the age of scholarship. Every article is its own page, ready to read or print.</p></div>
<section class="eb-find" role="search">
  <label class="eyebrow" for="ebq">Find an article</label>
  <div class="sbox"><input id="ebq" data-base="{esc(data_base(site))}" data-search="/britannica/" type="search" placeholder="Article title, or any word in the articles" autocomplete="off" enterkeyhint="search"></div>
  <div id="eb-results" aria-live="polite"></div>
</section>
<section class="sec"><div class="sec-h"><h2>Volumes</h2><span class="eyebrow">{n_arts:,} articles</span></div>{soon}<ul class="recs">{''.join(vl)}</ul></section>{sup}
<section class="sec prose eb-note"><h2>About this edition</h2>
<p>The text is the volunteer transcription at Wikisource, proofread against scans of the 1911 printing, newly set by Foggy Press. Each article keeps its original volume and page numbers, and the initials of its contributor where the original gives them.</p>
<p>Wikisource has transcribed only about half of the 1922 supplement so far. The other half here was read by machine from scans of the 1922 printing at archive.org and has not been corrected, and each of those articles says so at the top.</p>
<p>These articles are more than a century old. Science, geography and history have moved on, and some articles, particularly on race, religion and colonial peoples, reflect views that were common in 1911 and are offensive today. They are kept as written, as a historical record.</p></section>
<script src="/assets/britannica.js" defer></script>'''
    site.page('britannica/index.html', f'{TITLE} · Foggy Press', body, 'britannica',
              'The 1911 Encyclopædia Britannica, every article free to read and print, from Foggy Press.')


def volume_page(site, v):
    arts = [a for a in v['articles'] if not a.get('front')]
    front = [a for a in v['articles'] if a.get('front')]
    groups, order = {}, []
    for a in arts:  # the volume's own (printed) order
        k = group_key(a['title'])
        if k not in groups:
            groups[k] = []
            order.append(k)
        groups[k].append(a)
    jump = ''.join(f'<a href="#g-{esc(k)}">{esc(k)}</a>' for k in order)
    def li(a):
        return f'<li><a href="{esc(art_url(site, a["slug"]))}">{esc(a["title"])}</a><span class="mono">{esc(a["page"])}</span></li>'
    parts = []
    if front:
        parts.append('<div class="letter">Front matter</div><ul class="eb-list">' + ''.join(li(a) for a in front) + '</ul>')
    for k in order:
        parts.append(f'<div class="letter" id="g-{esc(k)}">{esc(k)}</div><ul class="eb-list">' + ''.join(li(a) for a in groups[k]) + '</ul>')
    first, last = (arts[0]['title'], arts[-1]['title']) if arts else ('', '')
    dl = ''
    if site.pdf_base:   # the whole volume as one e-book (stage_epubs; Kindle file by kindle.py once converted)
        vid = vol_id(v['n'])
        tt = f'data-goatcounter-title="Britannica volume {v["n"]}"'
        kin = (f' · <a href="{esc(vol_kindle_url(site, v["n"]))}" download rel="nofollow" data-goatcounter-click="kindle-{vid}" {tt} '
               f'title="For Kindle: download it in the Kindle’s web browser, or copy it over USB">Kindle</a>') if vid in site.kindle else ''
        dl = (f'<p class="eb-dl mono">The whole volume as an e-book: <a href="{esc(vol_epub_url(site, v["n"]))}" download rel="nofollow" '
              f'data-goatcounter-click="epub-{vid}" {tt} title="For e-readers: Kindle, Apple Books, Kobo">EPUB</a>{kin}</p>')
    body = f'''<link rel="stylesheet" href="/assets/britannica.css"><div class="ph"><span class="crumb"><a href="/">Home</a> / <a href="/britannica/">{esc(TITLE)}</a></span><h1>Volume {v["n"]}</h1>
<p class="sub">{"The 1922 supplement. " if v["n"] in SUPPLEMENT else ""}{esc(first)} to {esc(last)} · {len(arts):,} articles, in the order they are printed. The number beside each is its page in the volume.</p></div>
{dl}<nav class="eb-jump mono" aria-label="Jump to">{jump}</nav>{''.join(parts)}'''
    site.page(f'britannica/volume-{v["n"]}/index.html', f'Volume {v["n"]} · {vol_title(v)} · Foggy Press', body, 'britannica')


def article_page(site, out, v, a, art, prev_a, next_a, remote=False):
    T = vol_title(v)
    year = '1922' if v['n'] in SUPPLEMENT else '1911'
    gc = ''
    if site.gc_code:
        gc = f'<script data-goatcounter="https://{esc(site.gc_code)}.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>'
    # the running head when printed, in the house style: work · Foggy Press on the left, page and article on the right
    pg = f"Volume {v['n']}, page {a['page']}" if a['page'] else f"Volume {v['n']}"
    head = (f'<div class="eb-runhead" aria-hidden="true"><span>{esc(T)} · Foggy Press</span>'
            f'<span>{esc(pg)}, {esc(a["title"])}</span></div>')
    art = art.replace('<article class="book eb"', head + '<article class="book eb"', 1)
    # a picture whose file isn't there yet (still being fetched from Wikimedia) is left out until it is
    imgdir = v['dir'] / 'img'
    art = re.sub(r'<img [^>]*src="\.\./img/([^"]+)"[^>]*/?>', lambda m: m.group(0) if (imgdir / m.group(1)).exists() else '', art)
    def link(x, rel):
        if not x:
            return '<span></span>'
        xv, xa = x
        arrow = '←' if rel == 'prev' else '→'
        lab = f'{arrow} {esc(xa["title"])}' if rel == 'prev' else f'{esc(xa["title"])} {arrow}'
        return f'<a rel="{rel}" href="../{esc(xa["slug"])}/{"index.html" if remote else ""}">{lab}</a>'
    nav = f'<nav class="eb-nav" aria-label="Neighbouring articles">{link(prev_a, "prev")}<a class="up" href="/britannica/volume-{v["n"]}/">Volume {v["n"]}</a>{link(next_a, "next")}</nav>'
    if a.get('ocr'):
        src = f'<p class="eb-src mono">Text: read by machine from a <a href="{esc(a["source"])}">scan</a> of the 1922 printing, uncorrected.</p>'
    else:
        src = f'<p class="eb-src mono">Text: <a href="{esc(a["source"])}">Wikisource</a> transcription of the {year} printing.</p>'
    epub_a = ''
    if remote and site.pdf_base:   # this article as a small e-book (stage_epubs); a Kindle takes it through Send to Kindle
        epub_a = (f'<a class="rb-pdf" href="{esc(art_epub_url(site, a["slug"]))}" download rel="nofollow" '
                  f'data-goatcounter-click="epub-eb-{esc(a["slug"])}" data-goatcounter-title="{esc(a["title"])}" '
                  f'title="This article as an e-book. For a Kindle, send it with Amazon’s Send to Kindle">EPUB</a>')
    ask_btn = ('<button class="rb-ask" id="rbask" type="button" aria-expanded="false" aria-controls="askdrawer" hidden>'
               'Ask about this article</button>') if site.ask else ''
    desc = f'{a["title"]}: the article from the {year} Encyclopædia Britannica, {pg.lower()}. Free to read and print.'
    doc = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(a['title'])} · {esc(T)} · Foggy Press</title>
<meta name="description" content="{esc(desc)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/style.css">
<link rel="stylesheet" href="/assets/book.css">
<link rel="stylesheet" href="/assets/britannica.css">
{site.account_head()}
<script>try{{var t=localStorage.getItem('fp-theme');if(t)document.documentElement.dataset.theme=t}}catch(e){{}}
/* e-ink readers (the Kindle browser): class "kindle" turns on the Kindle layer in style.css */
try{{var mm=window.matchMedia;if(/Kindle/i.test(navigator.userAgent)||(mm&&(mm('(monochrome)').matches||mm('(update: slow)').matches)))document.documentElement.className+=' kindle'}}catch(e){{}}</script>
</head>
<body class="reading eb-page" data-article="{esc(a['slug'])}" data-title="{esc(a['title'])}">
<div class="readtop">
<nav class="readbar" aria-label="Foggy Press">
  <a class="rb-home" href="/">Foggy Press</a>
  <span class="rb-acts">{ask_btn}<a class="rb-pdf" href="/britannica/">Britannica<span class="wide"> 1911</span></a>{epub_a}<button class="rb-pdf rb-print" type="button" onclick="window.print()">Print<span class="wide"> this article</span></button><button class="theme" id="theme" type="button">Dark mode</button></span>
</nav>
<div class="bsearch" role="search">
  <div class="in">
    <label class="fld" for="find"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <input id="find" type="search" placeholder="Find in this article" autocomplete="off" enterkeyhint="search" aria-describedby="find-count"></label>
    <span class="cnt" id="find-count" aria-live="polite"></span>
    <span class="nav"><button type="button" id="find-prev" aria-label="Previous match" disabled>↑</button><button type="button" id="find-next" aria-label="Next match" disabled>↓</button></span>
    <button type="button" class="lst" id="find-all" aria-expanded="false" aria-controls="find-hits" disabled>All</button>
  </div>
  <div class="hits" id="find-hits" hidden><ol></ol></div>
</div>
</div>
{art}
{nav}
{src}
<footer class="readfoot mono"><a href="/">Foggy Press</a><span>Public-domain books, free to read and print</span><a href="/britannica/">{esc(T)}</a></footer>
<script src="/assets/site.js" defer></script>
<script src="/assets/search.js" defer></script>
{site.account_script()}
{gc}
</body>
</html>
'''
    if remote:  # on files.foggypress.com: R2 has no folder index pages, and the site's own files are on foggypress.com
        doc = re.sub(r'href="\.\./([^"/]+)/(#[^"]*)?"', lambda mm: f'href="../{mm.group(1)}/index.html{mm.group(2) or ""}"', doc)
    prefix = site.site_origin() if remote else site.base
    if prefix:
        doc = re.sub(r'(href|src)="/(?!/)', lambda mm: f'{mm.group(1)}="{prefix}/', doc)
    d = out / a['slug']
    d.mkdir(parents=True, exist_ok=True)
    (d / 'index.html').write_text(doc, encoding='utf-8')


# ---- downloads (22 Nov 2026, Will's "option 2"): one EPUB + one Kindle file per volume, one EPUB per article.
# The volume EPUBs are staged with the books' EPUBs (as epub/britannica-volume-N.epub), so build/kindle.py makes
# their Kindle files like any book's; article EPUBs go to britannica/epub/<slug>.epub. No Kindle file per article:
# Amazon's Send to Kindle takes an EPUB.

def vol_id(n):
    return f'britannica-volume-{n}'


def vol_epub_url(site, n):
    return f'{site.pdf_base}/epub/{vol_id(n)}.epub'


def vol_kindle_url(site, n):
    return f'{site.pdf_base}/kindle/{vol_id(n)}.azw3'


def art_epub_url(site, slug):
    return f'{site.pdf_base}/britannica/epub/{slug}.epub'


def _article_html(v, a):
    return (v['dir'] / 'articles' / f"{a['slug']}.html").read_text(encoding='utf-8')


def _links(site, art, local=None, prefix=''):
    """links that leave the article: another article is its page on the web (or, in a volume EPUB, its place
    in the book when it is in the same volume); site links get the site's address; in-article ids get prefix"""
    origin = site.site_origin() or 'https://foggypress.com'

    def other(m):
        slug, frag = m.group(1), m.group(2) or ''
        if local is not None and slug in local:
            return f'href="#a-{slug}"'
        return f'href="{esc(art_url(site, slug))}"'
    art = re.sub(r'href="\.\./([^"/#]+)/(#[^"]*)?"', other, art)
    art = re.sub(r'href="/(?!/)', f'href="{origin}/', art)
    if prefix:
        art = re.sub(r'(\sid=")([^"]+)"', lambda m: f'{m.group(1)}{prefix}{m.group(2)}"', art)
        art = re.sub(r'href="#(?!a-)([^"]+)"', lambda m: f'href="#{prefix}{m.group(1)}"', art)
    return art


def _body(art):
    """the article's text without its <article> and <header> wrapper"""
    art = re.sub(r'^\s*<article[^>]*>', '', art.strip())
    art = re.sub(r'</article>\s*$', '', art)
    return re.sub(r'<header class="book-head">.*?</header>', '', art, count=1, flags=re.S)


def stage_epubs(site, book_epubs, art_epubs, vols=None):
    """volume EPUBs into book_epubs/ (beside the books', so they get Kindle files), article EPUBs into
    art_epubs/. Returns (volumes, articles) made. EPUBs are byte-identical when nothing changed."""
    import epub
    if not enabled(site) or not site.pdf_base:
        return 0, 0
    vols = vols if vols is not None else load(site.files)
    book_epubs, art_epubs = Path(book_epubs), Path(art_epubs)
    nv = na = 0
    for v in vols:
        T = vol_title(v)
        year = '1922' if v['n'] in SUPPLEMENT else '1911'
        anchor = v['dir'] / 'articles' / 'x.html'   # pictures are found relative to the articles folder
        local = {a['slug'] for a in v['articles']}
        secs = []
        for a in v['articles']:
            try:
                art = _article_html(v, a)
            except OSError:
                continue
            m = re.search(r'<p class="byline">(.*?)</p>', art, re.S)
            # the article on its own
            one = (f'<article class="book"><header class="book-head"><h1>{esc(a["title"])}</h1>'
                   f'<p class="byline">{m.group(1) if m else esc(T)}</p></header>'
                   f'<section><h2>{esc(a["title"])}</h2>{_body(_links(site, art))}</section></article>')
            meta = {'id': f'eb-{a["slug"]}', 'title': f'{a["title"]} ({T})', 'author': a.get('author') or '',
                    'date': '2026-11-22', 'lang': 'en',
                    'description': f'The article “{a["title"]}” from the {year} Encyclopædia Britannica, volume {v["n"]}.'}
            try:
                if epub.make_epub(anchor, art_epubs / f'{a["slug"]}.epub', meta, None, text=one):
                    na += 1
            except Exception as e:
                site.problems.append(f'britannica {a["slug"]}: EPUB not made ({e})')
            # its chapter in the volume
            by = f'<p class="eb-by"><i>{esc(a["author"])}</i></p>' if a.get('author') else ''
            secs.append(f'<section id="a-{esc(a["slug"])}"><h2>{esc(a["title"])}</h2>'
                        f'{_body(_links(site, art, local, a["slug"] + "-"))}{by}</section>')
        arts = [a for a in v['articles'] if not a.get('front')]
        span = f'{arts[0]["title"]} to {arts[-1]["title"]}' if arts else 'Index and contributors'
        book = (f'<article class="book"><header class="book-head"><h1>{esc(T)}, Volume {v["n"]}</h1>'
                f'<p class="byline">{esc(span)}</p></header>{"".join(secs)}</article>')
        meta = {'id': vol_id(v['n']), 'title': f'{T}, Volume {v["n"]}', 'author': 'Encyclopædia Britannica',
                'date': '2026-11-22', 'lang': 'en',
                'description': f'Volume {v["n"]} of the {year} Encyclopædia Britannica: {span}, {len(arts):,} articles.'}
        try:
            if epub.make_epub(anchor, book_epubs / f'{vol_id(v["n"])}.epub', meta, None, text=book):
                nv += 1
        except Exception as e:
            site.problems.append(f'britannica volume {v["n"]}: EPUB not made ({e})')
    print(f'Britannica EPUBs: {nv} volumes, {na} articles.')
    return nv, na
