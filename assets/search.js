// Foggy Press search.
//  - The search page (/search/?q=...): authors and titles from search/books.json, and words
//    inside the books from the index files in search/p/ (made by build/search_index.py).
//    Several words are searched as an exact phrase, in titles, authors and the text.
//  - Read-online pages (/read/<id>/): "Find in this book", which works like find in a document.
(function () {
  var me = document.currentScript && document.currentScript.src;
  var BASE = me ? me.replace(/assets\/search\.js(\?.*)?$/, '') : '/';   // site root, ending in "/"

  // keep in step with STOP in build/search_index.py
  var STOP = {};
  ('a about after all also an and any are as at be been but by can could did do does for from had has have he her ' +
   'him his how i if in into is it its may me more most my no not now of on one only or our out over she so some such than that the ' +
   'their them then there these they this those to up upon us was we were what when where which who whom why will with would you your')
    .split(' ').forEach(function (w) { STOP[w] = 1; });

  var T = function (s, v) { return window.fpT ? window.fpT(s, v) : String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  // the index's own folding (build/search_index.py fold)
  function foldIdx(s) {
    s = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[’‘]/g, "'").replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss');
    return s.replace(/'s\b/g, '').replace(/'/g, '');
  }
  function words(q) { return (foldIdx(q).match(/[a-z0-9]+/g) || []); }
  // the index's folding of a whole text, with at[i] = where folded character i came from,
  // so a match in the folded text can be marked in the original
  function foldMap(s) {
    var f = '', at = [], q = /['’‘]/;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q.test(c)) {
        if (/s/i.test(s[i + 1] || '') && !/[a-z0-9]/i.test(s[i + 2] || '')) i++;  // possessive 's
        continue;
      }
      var g = c.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (c === 'æ' || c === 'Æ') g = 'ae'; else if (c === 'œ' || c === 'Œ') g = 'oe'; else if (c === 'ß') g = 'ss';
      else if (g.length !== 1) g = ' ';
      for (var k = 0; k < g.length; k++) { f += g[k]; at.push(i); }
    }
    at.push(s.length);
    return {f: f, at: at};
  }
  function rxEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // the words of a query as one pattern: in order, with only spaces or punctuation between
  function phraseRx(toks, whole) {
    var body = toks.map(rxEsc).join('[^a-z0-9]+');
    return new RegExp(whole ? '(?:^|[^a-z0-9])(' + body + ')(?![a-z0-9])' : '()' + body, 'g');
  }
  // [[start, end]] in the original text of each match of rx (group 1 is the match)
  function findAll(s, rx) {
    var fm = foldMap(s), out = [], m;
    rx.lastIndex = 0;
    while ((m = rx.exec(fm.f))) {
      var a = m.index + (m[0].length - (m[1] || m[0]).length), z = a + (m[1] || m[0]).length;
      if (z > a) out.push([fm.at[a], fm.at[z - 1] + 1]);
      if (rx.lastIndex === m.index) rx.lastIndex++;
    }
    return out;
  }
  function textWords(q) { return words(q).filter(function (w) { return w.length > 1 && !STOP[w]; }); }
  function getJSON(path) {
    return fetch(BASE + path).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  if (document.getElementById('search-results')) searchPage();
  if (document.getElementById('find')) findInBook();

  // ---------------------------------------------------------------- search page
  function searchPage() {
    var out = document.getElementById('search-results');
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input[name="q"]'));
    var params = new URLSearchParams(location.search);
    var query = params.get('q') || '';
    inputs.forEach(function (i) { i.value = query; });
    var SHOWN = 10, booksP = getJSON('search/books.json'), tagsP = getJSON('search/tags.json').catch(function () { return []; }), keysP = getJSON('search/p.json').then(function (ks) {
      var set = {}; ks.forEach(function (k) { set[k] = 1; }); return set; });
    var fileCache = {}, pageCache = {}, run = 0, timer;

    // ---- the index (format: build/search_index.py)
    function keyFor(set, w) {
      if (set[w + '-']) return w + '-';
      for (var n = w.length; n >= 2; n--) if (set[w.slice(0, n)]) return w.slice(0, n);
      return null;
    }
    // {word: [start, end]} of each record in one index file
    function file(key) {
      if (!fileCache[key]) fileCache[key] = fetch(BASE + 'search/p/' + key + '.bin').then(function (r) {
        if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(function (buf) {
        var u = new Uint8Array(buf), at = {}, i = 0;
        while (i < u.length) {
          var w = '';
          while (u[i]) w += String.fromCharCode(u[i++]);
          i++;
          var n = 0, s = 0, c;
          do { c = u[i++]; n += (c & 127) * Math.pow(2, s); s += 7; } while (c & 128);
          at[w] = [i, i + n]; i += n;
        }
        return {u: u, at: at};
      });
      return fileCache[key];
    }
    // where one word sits: {book: {chapter: [positions]}}, or {} if it isn't in any book
    function places(w) {
      return keysP.then(function (set) {
        var key = keyFor(set, w);
        if (!key) return {};
        return file(key).then(function (f) {
          var span = f.at[w], out = {};
          if (!span) return out;
          var u = f.u, i = span[0];
          function num() { var n = 0, s = 0, c; do { c = u[i++]; n += (c & 127) * Math.pow(2, s); s += 7; } while (c & 128); return n; }
          var nb = num(), bk = 0;
          for (var x = 0; x < nb; x++) {
            bk += num();
            var nc = num(), ch = 0, b = out[bk] = {};
            for (var y = 0; y < nc; y++) {
              ch += num();
              var np = num(), pos = 0, ps = b[ch] = new Array(np);
              for (var z = 0; z < np; z++) { pos += num(); ps[z] = pos; }
            }
          }
          return out;
        });
      });
    }
    function variants(w) {
      var v = [w, w + 's', w + 'es'];
      if (w.length > 3 && /s$/.test(w)) v.push(w.slice(0, -1));
      if (w.length > 4 && /es$/.test(w)) v.push(w.slice(0, -2));
      return v;
    }
    function ranked(per) {
      var res = [];
      Object.keys(per).forEach(function (bk) {
        var n = 0; Object.keys(per[bk]).forEach(function (c) { n += per[bk][c]; });
        if (n) res.push({book: +bk, n: n, chapters: per[bk]});
      });
      res.sort(function (a, b) { return b.n - a.n || a.book - b.book; });
      return res;
    }
    // [{book, n, chapters: {chapter: n}}], most mentions first.
    // One word: the word and its plural or singular. Several: the exact phrase.
    function fullText(toks) {
      var idx = [];
      toks.forEach(function (w, k) { if (w.length > 1 && !STOP[w]) idx.push(k); });
      if (!idx.length) return Promise.resolve(null);
      if (toks.length === 1) {
        return Promise.all(variants(toks[0]).map(places)).then(function (all) {
          var per = {};
          all.forEach(function (pl) {
            Object.keys(pl).forEach(function (bk) {
              var b = per[bk] = per[bk] || {};
              Object.keys(pl[bk]).forEach(function (c) { b[c] = (b[c] || 0) + pl[bk][c].length; });
            });
          });
          return ranked(per);
        });
      }
      // a phrase: the start of each place where every indexed word sits at its distance from the start
      return Promise.all(idx.map(function (k) { return places(toks[k]); })).then(function (all) {
        var per = {};
        Object.keys(all[0]).forEach(function (bk) {
          if (!all.every(function (pl) { return pl[bk]; })) return;
          Object.keys(all[0][bk]).forEach(function (c) {
            if (!all.every(function (pl) { return pl[bk][c]; })) return;
            var lists = all.map(function (pl, j) { return {off: idx[j], ps: pl[bk][c]}; });
            lists.sort(function (a, b) { return a.ps.length - b.ps.length; });
            var sets = lists.slice(1).map(function (l) { var s = new Set(l.ps); return {off: l.off, s: s}; });
            var n = 0;
            lists[0].ps.forEach(function (p) {
              var start = p - lists[0].off;
              if (sets.every(function (s) { return s.s.has(start + s.off); })) n++;
            });
            if (n) (per[bk] = per[bk] || {})[c] = n;
          });
        });
        return ranked(per);
      });
    }

    // titles and authors: the query's words in order, the last one may be unfinished ("dosto" finds Dostoyevsky)
    function hasPhrase(text, toks) { return (' ' + words(text).join(' ') + ' ').indexOf(' ' + toks.join(' ')) >= 0; }
    function marked(s, spans) {
      s = String(s || '');
      var o = '', last = 0;
      spans.forEach(function (sp) { if (sp[0] < last) return; o += esc(s.slice(last, sp[0])) + '<mark>' + esc(s.slice(sp[0], sp[1])) + '</mark>'; last = sp[1]; });
      return o + esc(s.slice(last));
    }
    function hl(text, toks) {
      if (!toks.length) return esc(text);
      var rx = new RegExp('(?:^|[^a-z0-9])(' + toks.map(rxEsc).join('[^a-z0-9]+') + ')', 'g');
      return marked(text, findAll(String(text || ''), rx));
    }
    // authors: "Jane Austen", "Austen Jane" and "austen, jane" all name Jane Austen. A query that names an author
    // in either order (middle initials may be left out) is an exact author match: that author comes first, and
    // their books lead the titles and the books found inside.
    function nameWords(b) {
      var all = words(b.a), last = words(b.al);
      var first = all.slice(0, Math.max(0, all.length - last.length));
      return {all: all, rev: last.concat(first)};
    }
    function authorHit(b, ws) {
      if (!b.a || !ws.length) return 0;
      var nw = nameWords(b), cut = function (a) { return a.filter(function (w) { return w.length > 1; }); };
      var q = cut(ws), n = cut(nw.all);
      // exact: the same words as the name, in either order, give or take the initials
      if (q.length && q.length === n.length && (q.join(' ') === n.join(' ') || q.join(' ') === cut(nw.rev).join(' ')) &&
          ws.every(function (w) { return nw.all.indexOf(w) >= 0 || (w.length === 1 && n.some(function (x) { return x[0] === w; })); })) return 2;
      return hasPhrase(b.a, ws) || hasPhrase(nw.rev.join(' '), ws) ? 1 : 0;
    }
    function sortT(t) { return t.replace(/^(The|A|An) /, '').toLowerCase(); }
    // counted phrases: the English key is "{n} books"; translations pick their own plural form
    function plural(n, one, many) { return T(n === 1 ? '{n} ' + one : '{n} ' + many, {n: n}); }
    function acts(b) {
      return '<span class="acts">' + (b.read ? '<a class="act" href="' + esc(readUrl(b)) + '">' + T('Read online') + '</a>' : '') +
        '<a class="act" href="' + esc(b.pdf) + '" data-goatcounter-click="pdf-' + esc(b.id) + '" data-goatcounter-title="' + esc(b.t) + '">' + T('Print this book') + '</a>' +
        (b.epub ? '<a class="act" href="' + esc(b.epub) + '" download data-goatcounter-click="epub-' + esc(b.id) + '" data-goatcounter-title="' + esc(b.t) + '" title="' + esc(T('For e-readers: Kindle, Apple Books, Kobo')) + '">EPUB</a>' : '') + '</span>';
    }
    // a book's read-online page: in R2 (files.foggypress.com) once the site moved them there, else /read/<id>/
    function readUrl(b) { return b.rd || BASE + 'read/' + b.id + '/'; }
    function mainHref(b, extra) { return b.read ? readUrl(b) + (extra || '') : b.pdf; }
    function rec(b, ws) {
      return '<li class="rec"><a class="main" href="' + esc(mainHref(b)) + '"><span class="t">' + hl(b.t, ws) + '</span><span class="a">' + hl(b.a, ws) +
        (b.tr ? ' · ' + T('tr.') + ' ' + esc(b.tr) : '') + '</span>' + (b.desc ? '<span class="d">' + esc(b.desc) + '</span>' : '') + '</a>' +
        '<span class="m mono">' + esc(b.d) + '</span>' + acts(b) + '</li>';
    }

    // one count per search the reader settles on (not every keystroke): what people look for, and what we lack
    var logTimer, logged = {};
    function logSearch(q, found) {
      clearTimeout(logTimer);
      var k = words(q).join(' ').slice(0, 80);
      if (!k || logged[k]) return;
      logTimer = setTimeout(function () { logged[k] = 1; if (window.fpEvent) fpEvent((found ? 'search: ' : 'search-none: ') + k); }, 2000);
    }
    function render() {
      var my = ++run, q = query.trim();
      document.title = q ? '“' + q + '” · ' + T('Search') + ' · Foggy Press' : T('Search') + ' · Foggy Press';
      var head = '<div class="ph"><span class="crumb"><a href="' + BASE + '">' + T('Home') + '</a> / ' + T('Search') + '</span>';
      if (!q) { out.innerHTML = head + '<h1>' + T('Search') + '</h1><p class="sub">' + T('Type a title, an author, or any word from inside the books.') + '</p></div>'; return; }
      var ws = words(q), tws = textWords(q);
      Promise.all([booksP, tagsP]).then(function (got) {
        var books = got[0], tags = got[1];
        if (my !== run) return;
        var byT = function (a, b) { return sortT(a.t).localeCompare(sortT(b.t), 'en', {numeric: true}); };
        var am = {}, mine = {};
        books.forEach(function (b, i) {
          var h = authorHit(b, ws);
          if (!h) return;
          var e = am[b.a] = am[b.a] || {last: b.al, b: [], x: 0};
          e.b.push(b);
          if (h === 2) { e.x = 1; mine[i] = 1; }
        });
        var authors = Object.keys(am).sort(function (a, b) { return (am[b].x - am[a].x) || am[a].last.localeCompare(am[b].last, 'en', {numeric: true}) || a.localeCompare(b, 'en', {numeric: true}); });
        var exact = authors.filter(function (a) { return am[a].x; });
        var isMine = function (b) { return am[b.a] && am[b.a].x ? 1 : 0; };
        var titles = books.filter(function (b) { return hasPhrase(b.t, ws); }).sort(function (a, b) { return (isMine(b) - isMine(a)) || byT(a, b); });
        var colls = tags.filter(function (g) { return hasPhrase(g.n, ws); });
        // no book by that title or author: readers with accounts can ask for it (Build me a book, /request/)
        var ask = !titles.length && !authors.length && !exact.length && document.querySelector('meta[name="fp-account"]')
          ? '<p class="sub reqhint">' + T('Not on Foggy Press yet?') + ' <a href="' + BASE + 'request/?title=' + encodeURIComponent(q) + '">' + T('Request this book') + ' →</a></p>' : '';
        var top = head + '<h1 lang="">“' + esc(q) + '”</h1><p class="sub" id="sr-sum"></p>' + ask + '</div>';
        var body = '';
        if (authors.length) body += '<section class="rgroup"><div class="sec-h"><h2>' + T('Authors') + '</h2><span class="eyebrow">' + authors.length + '</span></div><ul class="authors">' +
          authors.map(function (a) {
            var bs = am[a].b.slice().sort(byT);
            // the author's place on the By author page: build.py slugify(last + ' ' + first)
            var b0 = am[a].b[0], fst = b0.a.slice(-b0.al.length) === b0.al ? b0.a.slice(0, b0.a.length - b0.al.length).trim() : '';
            var aid = (b0.al + ' ' + fst).toLowerCase().replace(/&/g, 'and').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            return '<li class="au' + (am[a].x ? ' exact' : '') + '"><a class="n" href="' + BASE + 'authors/#' + esc(aid) + '">' + (am[a].x ? esc(a) : hl(a, ws)) + '</a><span class="c mono">' + plural(bs.length, 'book', 'books') + '</span><span class="bk">' +
              bs.map(function (b) { return '<a href="' + esc(mainHref(b)) + '">' + esc(b.t) + '</a>'; }).join('') + '</span></li>';
          }).join('') + '</ul></section>';
        if (colls.length) body += '<section class="rgroup"><div class="sec-h"><h2>' + T('Collections') + '</h2><span class="eyebrow">' + colls.length + '</span></div><div class="taglist">' +
          colls.map(function (g) { return '<a href="' + BASE + 'tag/' + esc(g.s) + '/"><span>' + hl(g.n, ws) + '</span><span class="mono">' + g.c + '</span></a>'; }).join('') + '</div></section>';
        if (titles.length) body += '<section class="rgroup"><div class="sec-h"><h2>' + T('Titles') + '</h2><span class="eyebrow">' + titles.length + '</span></div><ul class="recs">' +
          titles.map(function (b) { return rec(b, ws); }).join('') + '</ul></section>';
        out.innerHTML = top + body + (tws.length ? '<section class="rgroup" id="sr-in"><div class="sec-h"><h2>' + T('Inside the books') + '</h2><span class="eyebrow">' + T('Searching…') + '</span></div></section>' : '');
        var sum = function (inside) {
          var parts = [];
          if (authors.length) parts.push(plural(authors.length, 'author', 'authors'));
          if (colls.length) parts.push(plural(colls.length, 'collection', 'collections'));
          if (titles.length) parts.push(plural(titles.length, 'title', 'titles'));
          if (inside) parts.push(T(inside === 1 ? 'found inside {n} book' : 'found inside {n} books', {n: inside}));
          document.getElementById('sr-sum').textContent = parts.join(' · ');
          if (!parts.length && inside != null) document.getElementById('sr-sum').textContent = T('Nothing found.');
        };
        sum(null);
        if (!tws.length) { sum(0); logSearch(q, authors.length + titles.length + colls.length); return; }
        fullText(ws).then(function (res) {
          if (my !== run) return;
          res = res || [];
          // an exact author match: that author's own books first, then the rest by mentions
          if (exact.length) res = res.filter(function (r) { return mine[r.book]; }).concat(res.filter(function (r) { return !mine[r.book]; }));
          logSearch(q, res.length + authors.length + titles.length + colls.length);
          var sec = document.getElementById('sr-in');
          sum(res.length);
          if (!res.length) { sec.remove(); return; }
          sec.innerHTML = '<div class="sec-h"><h2>' + T('Inside the books') + '</h2><span class="sortbar"><span class="eyebrow">' + T(ws.length > 1 ? 'Exact phrase · most mentions first' : 'Most mentions first') + '</span>' +
            '<button type="button" class="chip" id="xall">' + T('Expand all') + '</button></span></div><ul class="recs">' +
            res.map(function (r, i) {
              var b = books[r.book], nc = Object.keys(r.chapters).length;
              return '<li class="rec ins" data-i="' + i + '"' + (i >= SHOWN ? ' hidden' : '') + '><a class="main" href="' + esc(mainHref(b, b.read ? '?q=' + encodeURIComponent(q) : '')) + '"><span class="t">' + esc(b.t) + '</span><span class="a">' + esc(b.a) + (b.tr ? ' · ' + T('tr.') + ' ' + esc(b.tr) : '') + '</span></a>' +
                '<span class="m mono">' + plural(r.n, 'mention', 'mentions') + ' · ' + plural(nc, b.ch.length === 1 ? 'place' : 'chapter', b.ch.length === 1 ? 'places' : 'chapters') + '</span>' + acts(b) +
                (b.read ? '<details class="snipd"><summary><span class="mono">' + T('Show passages') + '</span></summary><div class="snips"><span class="snip-wait mono">' + T('Loading passages…') + '</span></div></details>' : '') + '</li>';
            }).join('') + '</ul>' +
            (res.length > SHOWN ? '<div class="morebar"><span class="mono" id="sr-shown">' + T('Showing {n} of {m} books', {n: SHOWN, m: res.length}) + '</span><button class="btn ghost sm" type="button" id="sr-more">' + T('Show all {n}', {n: res.length}) + '</button></div>' : '');
          var lis = sec.querySelectorAll('li.ins');
          lis.forEach(function (li) {
            var d = li.querySelector('details');
            if (d) d.addEventListener('toggle', function () { if (d.open) passages(li, books[res[+li.dataset.i].book], res[+li.dataset.i], ws, q); });
          });
          var more = document.getElementById('sr-more');
          if (more) more.addEventListener('click', function () { lis.forEach(function (li) { li.hidden = false; }); more.parentNode.remove(); });
          var xa = document.getElementById('xall');
          xa.addEventListener('click', function () {
            var open = !xa.dataset.open;
            lis.forEach(function (li) { var d = li.querySelector('details'); if (d && !li.hidden) d.open = open; });
            if (open) xa.dataset.open = '1'; else delete xa.dataset.open;
            xa.textContent = open ? T('Collapse all') : T('Expand all');
          });
        }).catch(function () {
          if (my !== run) return;
          var sec = document.getElementById('sr-in');
          if (sec) sec.querySelector('.eyebrow').textContent = T('Couldn’t search inside the books just now. Please try again.');
        });
      });
    }

    // up to three passages: the chapters with the most mentions, in reading order
    function passages(li, b, r, toks, q) {
      if (li.dataset.loaded) return;
      li.dataset.loaded = '1';
      var box = li.querySelector('.snips');
      var url = readUrl(b);
      if (!pageCache[b.id]) pageCache[b.id] = fetch(url).then(function (x) { return x.text(); }).then(function (h) { return new DOMParser().parseFromString(h, 'text/html'); });
      pageCache[b.id].then(function (doc) {
        var chs = Object.keys(r.chapters).map(Number).sort(function (x, y) { return r.chapters[y] - r.chapters[x] || x - y; }).slice(0, 3).sort(function (x, y) { return x - y; });
        var alt = toks.length === 1 ? '(?:' + variants(toks[0]).map(rxEsc).join('|') + ')' : toks.map(rxEsc).join('[^a-z0-9]+');
        var rx = new RegExp('(?:^|[^a-z0-9])(' + alt + ')(?![a-z0-9])', 'g');
        box.innerHTML = chs.map(function (c) {
          var info = b.ch[c] || ['', ''], sid = info[0];
          var el = sid ? doc.getElementById(sid) : doc.querySelector('article.book');
          if (!el) return '';
          var copy = el.cloneNode(true);
          copy.querySelectorAll('h2, details, header').forEach(function (x) { x.remove(); });
          copy.querySelectorAll('p, h3, h4, li, div, br, td, blockquote, figure, figcaption').forEach(function (x) { x.after(' '); });
          var tx = copy.textContent.replace(/\s+/g, ' ').trim();
          var m = findAll(tx, rx)[0];
          var at = m ? m[0] : 0, len = m ? m[1] - m[0] : 0;
          var a = Math.max(0, at - 90), z = Math.min(tx.length, at + len + 110);
          if (a > 0) a = tx.indexOf(' ', a) + 1;
          var zz = tx.indexOf(' ', z); if (zz > 0) z = zz;
          return '<a class="snip" href="' + esc(url + '?q=' + encodeURIComponent(q) + (sid ? '#' + sid : '')) + '"><span class="ch mono">' + esc(info[1] || T('Text')) +
            (r.chapters[c] > 1 ? ' · ' + r.chapters[c] : '') + '</span><span class="tx">' + (a > 0 ? '…' : '') + esc(tx.slice(a, at)) +
            (len ? '<mark>' + esc(tx.slice(at, at + len)) + '</mark>' : '') + esc(tx.slice(at + len, z)) + (z < tx.length ? '…' : '') + '</span></a>';
        }).join('') || '<span class="snip-wait mono">' + T('Open the book to see where it appears.') + '</span>';
      }).catch(function () {
        delete li.dataset.loaded;
        box.innerHTML = '<span class="snip-wait mono">' + T('Couldn’t load the passages. Close and open again to retry.') + '</span>';
      });
    }

    render();
    document.addEventListener('fp-lang', render);
    inputs.forEach(function (inp) {
      inp.addEventListener('input', function () {
        query = inp.value;
        inputs.forEach(function (o) { if (o !== inp) o.value = query; });
        clearTimeout(timer);
        timer = setTimeout(function () {
          try { history.replaceState(null, '', query.trim() ? '?q=' + encodeURIComponent(query.trim()) : location.pathname); } catch (e) {}
          render();
        }, 250);
      });
      inp.form.addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(timer); query = inp.value; try { history.replaceState(null, '', '?q=' + encodeURIComponent(query.trim())); } catch (x) {} render(); inp.blur(); });
    });
  }

  // ---------------------------------------------------------------- find in this book
  function findInBook() {
    var art = document.querySelector('article.book');
    var bq = document.getElementById('find'), cnt = document.getElementById('find-count'),
      prev = document.getElementById('find-prev'), next = document.getElementById('find-next'),
      lst = document.getElementById('find-all'), list = document.getElementById('find-hits');
    if (!art) return;
    var hits = [], cur = -1, timer, lastQ = '';   // hits[i] = the <mark>s of match i (more than one if it crosses italics)
    var LIST_MAX = 300, BLOCK = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, div, section, figcaption, dd, dt, pre';

    function clear() {
      var parents = [];
      art.querySelectorAll('mark.hit').forEach(function (m) { var p = m.parentNode; p.replaceChild(document.createTextNode(m.textContent), m); parents.push(p); });
      parents.forEach(function (p) { p.normalize(); });
      hits = []; cur = -1;
    }
    function setList(open) { list.hidden = !open; lst.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    function chapterOf(node) { var s = node.closest('section'); var h = s && s.querySelector('h2'); return h ? h.textContent.trim() : T('Opening'); }
    var findLogged = false;
    function search(q, stay) {
      if (!findLogged && q && q.trim().length > 1 && window.fpEvent) { findLogged = true; fpEvent('find-in-book'); }
      lastQ = q; clear(); list.querySelector('ol').innerHTML = '';
      var toks = words(q);
      if (toks.join('').length < 2) { cnt.textContent = ''; prev.disabled = next.disabled = lst.disabled = true; lst.textContent = T('All'); setList(false); return; }
      // the book's text as one string, with a space where one block ends and the next begins
      var walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT, {acceptNode: function (n) {
        return n.parentNode.closest('details.toc, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }});
      var nodes = [], starts = [], text = '', lastBlock = null;
      while (walker.nextNode()) {
        var n = walker.currentNode, blk = n.parentNode.closest(BLOCK), prevEl = n.previousSibling;
        if (text && (blk !== lastBlock || (prevEl && prevEl.nodeName === 'BR'))) text += ' ';
        lastBlock = blk; nodes.push(n); starts.push(text.length); text += n.nodeValue;
      }
      var found = findAll(text, phraseRx(toks, false));
      // cut each match into its pieces, one per text node, then wrap the pieces from the end backwards
      var pieces = [], ni = 0;
      found.forEach(function (sp, h) {
        while (ni + 1 < nodes.length && starts[ni + 1] <= sp[0]) ni++;
        for (var k = ni; k < nodes.length && starts[k] < sp[1]; k++) {
          var a = Math.max(sp[0], starts[k]) - starts[k], z = Math.min(sp[1], starts[k] + nodes[k].nodeValue.length) - starts[k];
          if (z > a) pieces.push({k: k, a: a, z: z, h: h});
        }
      });
      hits = found.map(function () { return []; });
      for (var i = pieces.length - 1; i >= 0; i--) {
        var pc = pieces[i], node = nodes[pc.k];
        var after = node.splitText(pc.a), rest = after.splitText(pc.z - pc.a);
        var m = document.createElement('mark'); m.className = 'hit'; m.textContent = after.nodeValue;
        after.parentNode.replaceChild(m, after);
        hits[pc.h].unshift(m);
        nodes[pc.k] = node;   // text before the piece stays in the same node, so earlier pieces still fit
        void rest;
      }
      var n = hits.length;
      prev.disabled = next.disabled = lst.disabled = !n;
      lst.textContent = n ? T('All {n}', {n: n}) : T('All');
      if (!n) { cnt.textContent = T('No matches'); setList(false); return; }
      list.querySelector('ol').innerHTML = hits.slice(0, LIST_MAX).map(function (ms, i) {
        var m = ms[0], blk = m.closest(BLOCK) || m.parentNode, tx = blk.textContent, before = 0, len = 0;
        var w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) { if (w.currentNode.parentNode === m) break; before += w.currentNode.nodeValue.length; }
        ms.forEach(function (x) { len += x.textContent.length; });
        len = Math.min(len, tx.length - before);
        var a = Math.max(0, before - 60), z = Math.min(tx.length, before + len + 80);
        return '<li><a href="#" data-hit="' + i + '"><span class="ch">' + esc(chapterOf(m)) + '</span><span class="s">' + (a > 0 ? '…' : '') + esc(tx.slice(a, before)) +
          '<mark>' + esc(tx.slice(before, before + len)) + '</mark>' + esc(tx.slice(before + len, z)) + (z < tx.length ? '…' : '') + '</span></a></li>';
      }).join('') + (n > LIST_MAX ? '<li class="more mono">' + T('First {n} of {m} shown. Use the arrows for the rest.', {n: LIST_MAX, m: n}) + '</li>' : '');
      if (!stay) go(0);
    }
    function go(i) {
      if (!hits.length) return;
      if (cur >= 0) hits[cur].forEach(function (m) { m.classList.remove('cur'); });
      cur = (i + hits.length) % hits.length;
      hits[cur].forEach(function (m) { m.classList.add('cur'); });
      cnt.textContent = T('{n} of {m}', {n: cur + 1, m: hits.length});
      // jump straight there, as find does in a document
      hits[cur][0].scrollIntoView({block: 'center'});
    }
    bq.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { search(bq.value); }, 250); });
    bq.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault(); clearTimeout(timer);
        if (bq.value !== lastQ) search(bq.value); else go(e.shiftKey ? cur - 1 : cur + 1);
      } else if (e.key === 'Escape') { bq.value = ''; search(''); }
    });
    document.addEventListener('fp-lang', function () { if (lastQ) { var c = cur; search(lastQ, true); if (c >= 0) go(c); } else { lst.textContent = T('All'); } });
    prev.addEventListener('click', function () { go(cur - 1); });
    next.addEventListener('click', function () { go(cur + 1); });
    lst.addEventListener('click', function () { setList(list.hidden); });
    list.addEventListener('click', function (e) {
      var a = e.target.closest('[data-hit]'); if (!a) return;
      e.preventDefault(); setList(false); go(+a.dataset.hit);
    });
    // arriving from the site search: /read/<id>/?q=atlanta#c49 finds the word and goes to its first place in that chapter
    var q = new URLSearchParams(location.search).get('q');
    if (q) {
      bq.value = q;
      search(q, true);
      var start = 0, sec = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
      if (sec) for (var k = 0; k < hits.length; k++) if (sec.contains(hits[k][0])) { start = k; break; }
      if (hits.length) setTimeout(function () { go(start); }, 0);
    }
  }
})();
