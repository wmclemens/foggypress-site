"""Kindle (AZW3) editions of every book, made from its EPUB with Calibre (Nov 2026).

Calibre takes about 2 seconds a book, so converting the whole catalog (~3,600 books) on every build would take
hours. Instead the AZW3 files live in R2 under kindle/ with a manifest, kindle/manifest.json, that maps each book id
to the SHA-256 of the EPUB it was made from (or marks it "failed": tried, not retried until the EPUB changes). EPUBs are reproducible (epub.py), so each build converts only books
whose EPUB is new or changed, within a time budget; books left over are converted on the next build. A book gets a
Kindle link only once its AZW3 is in the manifest (build.py reads the manifest through KINDLE_MANIFEST).

  python build/kindle.py plan    --epubs _pdfs/epub --manifest old.json
      prints how many books need converting (0 means Calibre need not be installed)
  python build/kindle.py convert --epubs _pdfs/epub --manifest old.json --out _kindle --minutes 20
      converts what it can into _kindle/<id>.azw3, writes _kindle/manifest.json (the new manifest, uploaded last)
      and _kindle/stale.txt (AZW3 files of books no longer on the site, to delete from R2)
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(path):
    try:
        d = json.loads(Path(path).read_text(encoding='utf-8'))
        return d.get('books', {}) if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def work(epubs, old):
    """(current {id: epub hash}, ids to convert): new or changed EPUBs, smallest first so a budget covers the most books"""
    cur = {p.stem: sha256(p) for p in sorted(Path(epubs).glob('*.epub'))}
    todo = [i for i in cur if (old.get(i) or {}).get('epub') != cur[i]]
    todo.sort(key=lambda i: (Path(epubs) / f'{i}.epub').stat().st_size)
    return cur, todo


def convert_one(src, dst):
    env = dict(os.environ, QT_QPA_PLATFORM='offscreen')
    r = subprocess.run(['ebook-convert', str(src), str(dst)], capture_output=True, text=True, env=env, timeout=2400)
    if r.returncode or not dst.exists() or dst.stat().st_size == 0:
        raise RuntimeError((r.stdout + r.stderr).strip().splitlines()[-1:] or ['no output'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('action', choices=['plan', 'convert'])
    ap.add_argument('--epubs', required=True)
    ap.add_argument('--manifest', required=True, help='the manifest now on R2 (missing or empty = none yet)')
    ap.add_argument('--out', default='_kindle')
    ap.add_argument('--minutes', type=float, default=20, help='stop starting new conversions after this long')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()

    old = load_manifest(a.manifest)
    cur, todo = work(a.epubs, old)
    if a.action == 'plan':
        print(len(todo))
        return

    if todo and not shutil.which('ebook-convert'):
        sys.exit('Calibre (ebook-convert) is not installed; no Kindle files made')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    # keep books whose AZW3 is up to date; a changed book keeps its old entry (and file) until reconverted
    books = {i: e for i, e in old.items() if i in cur}
    stale = sorted(i for i in old if i not in cur)
    deadline = time.monotonic() + a.minutes * 60
    done, failed = 0, []
    started = time.monotonic()
    with ThreadPoolExecutor(a.jobs) as pool:
        futs, it = {}, iter(todo)

        def submit_next():
            if time.monotonic() >= deadline:
                return False
            i = next(it, None)
            if i is None:
                return False
            futs[pool.submit(convert_one, Path(a.epubs) / f'{i}.epub', out / f'{i}.azw3')] = i
            return True

        for _ in range(a.jobs * 2):
            if not submit_next():
                break
        while futs:
            f = next(as_completed(futs))
            i = futs.pop(f)
            try:
                f.result()
                books[i] = {'epub': cur[i], 'size': (out / f'{i}.azw3').stat().st_size}
                done += 1
            except Exception as e:  # one bad book must not stop the rest
                failed.append(i)
                books[i] = {'epub': cur[i], 'failed': True}   # not retried until its EPUB changes
                print(f'warning: {i}: Kindle file not made ({e})', file=sys.stderr)
            submit_next()
    left = len(todo) - done - len(failed)
    (out / 'manifest.json').write_text(json.dumps({'books': dict(sorted(books.items()))}, separators=(',', ':')), encoding='utf-8')
    (out / 'stale.txt').write_text(''.join(f'{i}.azw3\n' for i in stale), encoding='utf-8')
    print(f'Kindle: {done} converted in {(time.monotonic() - started) / 60:.1f} min, {len(failed)} failed, '
          f'{left} left for the next build, {len(stale)} removed; {sum(not e.get('failed') for e in books.values())} of {len(cur)} books have a Kindle file.')


if __name__ == '__main__':
    main()
