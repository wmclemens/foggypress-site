# foggypress-site

The website for Foggy Press: free, printable public-domain books at [foggypress.com](https://foggypress.com).

Everything is built from scratch from the files in this repo. The book PDFs themselves live in the private `foggy-press-files` repo; the build copies in only the books that are live.

## What's here

- `catalog/books.json`: one record per book: author last and first name, title, translator, original publish date, Foggy Press publish date, GitHub directory and PDF links, and tags.
- `catalog/tags.json`: the tag file: every tag, and whether it is one of the three featured collections.
- `content/about.md`: the About page.
- `admin/`: the admin pages at foggypress.com/admin, for editing the catalog and tags.
- `assets/`: the site's stylesheet and script.
- `build/build.py`: turns the catalog into the website.
- `build/search_index.py`: makes the search index (called by `build.py`).
- `.github/workflows/build.yml`: builds and publishes the site.

## Read online

Every book has two links: **Read online** opens `/read/<id>/`, the book's web edition, and **Print this book** opens its PDF. The web edition is made in `foggy-press-files` from the book's final LaTeX (`pipeline/web/`), so it has the same text as the PDF; the build wraps it in a plain reading page and copies its pictures. A book without a web edition links straight to its PDF.

## Search

A search box sits at the top of the left nav (under the name on phones). It opens `/search/?q=...`, which lists matching **Authors**, **Titles**, and every book whose text has the words (**Inside the books**, most mentions first, with each book's best passages folded under "Show passages"). A passage opens the book at that chapter with the words already found.

The search runs in the browser with no server. Each build writes `search/books.json` (the books and their chapter lists) and `search/w/*.json` (every word of every web edition, split into small files by its first letters), so a search downloads only the few files its words need. Very common words such as "the" and "and" are not indexed. Every read-online page also has **Find in this book**, which works like find in a document: typing goes to the first match, Enter or ↓ to the next, Shift+Enter or ↑ back, and "All" lists every match by chapter.

## Descriptions

Each record shows a one-sentence description, also used at the top of its read-online page. It lives in the book's README in `foggy-press-files`, under `## Description`; edit it there and the site shows the new text after its next build (daily, or **Run workflow**).

## How a book goes live

A book appears on the site when its record has a Foggy Press publish date that is today or earlier and its PDF exists in `foggy-press-files`. Leave the date empty to keep a book hidden.

The site rebuilds on every change to this repo (including every save in admin), once a day, and whenever you press **Run workflow** under Actions → Build and publish site.

## Settings the build uses

| Where | Name | What |
|---|---|---|
| Secrets | `FILES_TOKEN` | Fine-grained token, read-only Contents on `foggy-press-files`. Required. |
| Secrets | `GOATCOUNTER_TOKEN` | GoatCounter API token, for download counts. Optional. |
| Variables | `GOATCOUNTER_CODE` | GoatCounter site code, e.g. `foggypress`. Optional. |
| Variables | `SITE_DOMAIN` | `foggypress.com` once DNS points here. Optional. |

## Build locally

```
pip install pypdf markdown
python build/build.py --files ../foggy-press-files
python -m http.server -d _site 8000
```
