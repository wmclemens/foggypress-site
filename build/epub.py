"""EPUB editions for foggypress.com, made from each book's web edition (output/html/).

make_epub(html_path, dest, meta) writes one EPUB 3 file:
  - a title page from the web edition's <header class="book-head">
  - one XHTML file per chapter (each top-level <section> of the <article>), plus the
    text before the first section, if any
  - the pictures, cut to screen size and grayscale the same way as the read-online pages
  - a table of contents (nav.xhtml, and toc.ncx for older readers)
Links inside the book (contents, footnotes) are pointed at the chapter file that holds
their target. The zip is written with fixed dates, so an unchanged book gives a
byte-identical file and the R2 upload (rclone --checksum) skips it.

Needs only the standard library, plus Pillow for the pictures (as build.py already does).
"""
import html
import io
import re
import urllib.parse
import zipfile
from html.parser import HTMLParser
from pathlib import Path

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
DROP_ATTRS = {'loading', 'decoding'}
MATHML = 'http://www.w3.org/1998/Math/MathML'
MEDIA = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp'}
FIXED = (2026, 1, 1, 0, 0, 0)

CSS = """body{margin:0 5%;font-family:serif;line-height:1.5}
p{margin:0;text-indent:1.4em}
h1+p,h2+p,h3+p,hr+p,blockquote+p,.verse+p,.center+p,figure+p,p:first-child,.title p{text-indent:0}
h1,h2,h3{font-family:sans-serif;font-weight:bold;line-height:1.25;page-break-after:avoid}
h1{font-size:1.6em;margin:2em 0 .6em}
h2{font-size:1.25em;margin:1.5em 0 1em}
h2.part{font-size:1.5em;text-align:center;margin-top:3em}
h3{font-size:1em;margin:1.4em 0 .5em}
blockquote{margin:.8em 0 .8em 1.4em;font-size:.95em}
.verse p,.verse{text-indent:0}
.center{text-align:center;text-indent:0}
hr{border:0;border-top:1px solid #999;width:30%;margin:1.5em auto}
figure{margin:1em 0;text-align:center;page-break-inside:avoid}
figure img,img{max-width:100%;height:auto}
figcaption{font-size:.85em;font-style:italic;margin-top:.3em}
table{border-collapse:collapse;margin:1em auto;font-size:.9em}
td,th{padding:.15em .4em;vertical-align:top}
sup{font-size:.7em;line-height:0}
.title{text-align:center;margin-top:20%}
.title h1{font-size:2em;margin-bottom:1em}
.title .byline{font-family:sans-serif;font-size:1em;color:#555}
.title .imprint{margin-top:4em;font-family:sans-serif;font-size:.9em;letter-spacing:.08em;text-transform:uppercase}
"""


class _Tree(HTMLParser):
    """a forgiving HTML to element-tree reader: [tag, attrs, children] lists and text strings"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = ['#root', [], []]
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        el = [tag, [(k, v if v is not None else k) for k, v in attrs if k not in DROP_ATTRS], []]
        self.stack[-1][2].append(el)
        if tag not in VOID:
            self.stack.append(el)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1][2].append([tag, [(k, v if v is not None else k) for k, v in attrs if k not in DROP_ATTRS], []])

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1][2].append(data)


def _parse(fragment):
    t = _Tree()
    t.feed(fragment)
    t.close()
    return t.root[2]


def _find(nodes, test):
    for n in nodes:
        if isinstance(n, list):
            if test(n):
                return n
            r = _find(n[2], test)
            if r:
                return r
    return None


def _attr(el, name):
    for k, v in el[1]:
        if k == name:
            return v
    return None


def _cls(el):
    return (_attr(el, 'class') or '').split()


def _text(nodes):
    out = []
    for n in nodes:
        out.append(n if isinstance(n, str) else _text(n[2]))
    return ''.join(out)


def _ids(nodes, out):
    for n in nodes:
        if isinstance(n, list):
            i = _attr(n, 'id')
            if i:
                out.append(i)
            _ids(n[2], out)
    return out


def _xa(v):
    return html.escape(v, quote=True)


def _ser(nodes, ctx, in_math=False):
    """XHTML for nodes; ctx rewrites links and pictures"""
    out = []
    for n in nodes:
        if isinstance(n, str):
            out.append(html.escape(n, quote=False))
            continue
        tag, attrs, kids = n
        if tag in ('script', 'style', 'details'):
            continue
        attrs = list(attrs)
        if tag == 'a':
            attrs = [(k, ctx.href(v) if k == 'href' else v) for k, v in attrs]
        if tag == 'img':
            src = _attr(n, 'src')
            new = ctx.picture(src) if src else None
            if not new:
                continue
            attrs = [(k, new if k == 'src' else v) for k, v in attrs]
            if _attr(n, 'alt') is None:
                attrs.append(('alt', ''))
        math = in_math or tag == 'math'
        if tag == 'math' and not in_math:
            attrs = [(k, v) for k, v in attrs if k != 'xmlns'] + [('xmlns', MATHML)]
        seen, a = set(), ''
        for k, v in attrs:
            if k not in seen and re.match(r'^[a-zA-Z_:][-a-zA-Z0-9_:.]*$', k):
                seen.add(k)
                a += f' {k}="{_xa(v)}"'
        if tag in VOID:
            out.append(f'<{tag}{a}/>')
        else:
            out.append(f'<{tag}{a}>{_ser(kids, ctx, math)}</{tag}>')
    return ''.join(out)


def _page(title, body, lang):
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
            f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{lang}" xml:lang="{lang}">\n'
            f'<head><meta charset="utf-8"/><title>{html.escape(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n'
            f'<body>{body}</body>\n</html>\n')


def make_epub(html_path, dest, meta, picture=None):
    """html_path: the web edition; dest: the .epub to write; meta: {id, title, author, date, lang, description};
    picture(src_path, dst_path): writes a screen-size copy of a picture (build.web_picture)"""
    html_path = Path(html_path)
    src = html_path.read_text(encoding='utf-8')
    m = re.search(r'<article class="book".*</article>', src, re.S)
    if not m:
        return False
    art = _parse(m.group(0))[0]
    lang = meta.get('lang') or 'en'
    head = _find(art[2], lambda e: e[0] == 'header')
    body = [n for n in art[2] if not (isinstance(n, list) and (n[0] in ('header', 'details')))]

    # chapters: the text before the first section, then each section
    chapters, lead = [], []
    for n in body:
        if isinstance(n, list) and n[0] == 'section':
            if lead and _text(lead).strip():
                chapters.append(('Opening', lead, False))
            lead = []
            h = _find(n[2], lambda e: e[0] == 'h2')
            chapters.append((' '.join(_text(h[2]).split()) if h else 'Chapter', [n], 'part' in _cls(h) if h else False))
        else:
            lead.append(n)
    if lead and _text(lead).strip():
        chapters.append(('Text' if not chapters else 'End matter', lead, False))
    files = [f'c{i + 1:03d}.xhtml' for i in range(len(chapters))]
    where = {}
    for f, (_, nodes, _) in zip(files, chapters):
        for i in _ids(nodes, []):
            where.setdefault(i, f)

    pics = {}  # source path -> name inside the book

    class Ctx:
        def href(self, v):
            if v.startswith('#'):
                f = where.get(urllib.parse.unquote(v[1:]))
                return f'{f}{v}' if f else v
            return v

        def picture(self, s):
            p = (html_path.parent / urllib.parse.unquote(s)).resolve()
            if not p.is_file() or p.suffix.lower() not in MEDIA:
                return None
            if p not in pics:
                pics[p] = f'img/{len(pics) + 1:04d}{p.suffix.lower()}'
            return pics[p]

    ctx = Ctx()
    pages = {f: _page(t, _ser(nodes, ctx), lang) for f, (t, nodes, _) in zip(files, chapters)}

    title, author = meta.get('title') or 'Untitled', meta.get('author') or ''
    byline = _find(head[2], lambda e: 'byline' in _cls(e)) if head else None
    tpage = _page(title, f'<section class="title" epub:type="titlepage"><h1>{html.escape(title)}</h1>'
                         f'<p class="byline">{html.escape(" ".join(_text(byline[2]).split())) if byline else html.escape(author)}</p>'
                         f'<p class="imprint">Foggy Press</p></section>', lang)

    nav_items = ''.join(f'<li><a href="{f}">{html.escape(t)}</a></li>' for f, (t, _, _) in zip(files, chapters))
    nav = _page('Contents', f'<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>{nav_items}</ol></nav>', lang)
    uid = f'urn:foggypress:{meta["id"]}'
    ncx_points = ''.join(f'<navPoint id="n{i + 1}" playOrder="{i + 1}"><navLabel><text>{html.escape(t)}</text></navLabel><content src="{f}"/></navPoint>'
                         for i, (f, (t, _, _)) in enumerate(zip(files, chapters)))
    ncx = (f'<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head>'
           f'<meta name="dtb:uid" content="{_xa(uid)}"/></head><docTitle><text>{html.escape(title)}</text></docTitle><navMap>{ncx_points}</navMap></ncx>\n')

    modified = (meta.get('date') or '2026-01-01')[:10] + 'T00:00:00Z'
    manifest = ['<item id="style" href="style.css" media-type="text/css"/>',
                '<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>',
                '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
                '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>']
    for i, f in enumerate(files):
        props = ' properties="mathml"' if '<math' in pages[f] else ''
        manifest.append(f'<item id="c{i + 1}" href="{f}" media-type="application/xhtml+xml"{props}/>')
    for i, (p, name) in enumerate(pics.items()):
        manifest.append(f'<item id="i{i + 1}" href="{name}" media-type="{MEDIA[p.suffix.lower()]}"/>')
    spine = '<itemref idref="title"/>' + ''.join(f'<itemref idref="c{i + 1}"/>' for i in range(len(files)))
    desc = f'<dc:description>{html.escape(meta["description"])}</dc:description>' if meta.get('description') else ''
    creator = f'<dc:creator>{html.escape(author)}</dc:creator>' if author else ''
    opf = (f'<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="{lang}">'
           f'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">{_xa(uid)}</dc:identifier>'
           f'<dc:title>{html.escape(title)}</dc:title>{creator}<dc:language>{lang}</dc:language><dc:publisher>Foggy Press</dc:publisher>'
           f'<dc:rights>Public domain</dc:rights>{desc}<meta property="dcterms:modified">{modified}</meta></metadata>'
           f'<manifest>{"".join(manifest)}</manifest><spine toc="ncx">{spine}</spine></package>\n')
    container = ('<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                 '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n')

    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        def put(name, data, store=False):
            zi = zipfile.ZipInfo(name, FIXED)
            zi.compress_type = zipfile.ZIP_STORED if store else zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, data)
        put('mimetype', 'application/epub+zip', store=True)
        put('META-INF/container.xml', container)
        put('OEBPS/content.opf', opf)
        put('OEBPS/style.css', CSS)
        put('OEBPS/title.xhtml', tpage)
        put('OEBPS/nav.xhtml', nav)
        put('OEBPS/toc.ncx', ncx)
        for f in files:
            put(f'OEBPS/{f}', pages[f])
        tmp = dest.parent / f'.{dest.stem}.pic'
        for p, name in pics.items():
            t = tmp.with_suffix(p.suffix.lower())
            if picture:
                picture(p, t)
                data = t.read_bytes()
                t.unlink()
            else:
                data = p.read_bytes()
            put(f'OEBPS/{name}', data, store=p.suffix.lower() in ('.jpg', '.jpeg', '.png', '.gif', '.webp'))
    data = buf.getvalue()
    if not dest.exists() or dest.read_bytes() != data:
        dest.write_bytes(data)
    return True
