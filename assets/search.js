// Foggy Press search.
//  - The search page (/search/?q=...): authors and titles from search/books.json, and every word
//    inside the books from the index files in search/w/ (made by build/search_index.py).
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

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  // one character in, one character out, so positions in the folded text match the original
  function foldKeep(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i], f = c.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (c === '’' || c === '‘') f = "'";
      out += f.length === 1 ? f : (c.toLowerCase().length === 1 ? c.toLowerCase() : ' ');
    }
    return out;
  }
  // the index's own folding (build/search_index.py fold)
  function foldIdx(s) {
    s = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[’‘]/g, "'").replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss');
    return s.replace(/'s\b/g, '').replace(/'/g, '');
  }
  function words(q) { return (foldIdx(q).match(/[a-z0-9]+/g) || []); }
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
    var SHOWN = 10, booksP = getJSON('search/books.json'), splitP = getJSON('search/split.json').catch(function () { return []; });
    var shardCache = {}, pageCache = {}, run = 0, timer;

    function shard(key) {
      if (!shardCache[key]) shardCache[key] = getJSON('search/w/' + key + '.json').catch(function () { return {}; });
      return shardCache[key];
    }
    function variants(w) {
      var v = [w, w + 's', w + 'es'];
      if (w.length > 3 && /s$/.test(w)) v.push(w.slice(0, -1));
      if (w.length > 4 && /es$/.test(w)) v.push(w.slice(0, -2));
      return v;
    }
    // [{book, n, chapters: {chapter: n}}] for books holding every word
    function fullText(ws) {
      if (!ws.length) return Promise.resolve(null);
      return splitP.then(function (split) {
        var sp = {}; split.forEach(function (k) { sp[k] = 1; });
        return Promise.all(ws.map(function (w) {
          var vs = variants(w);
          var keys = {}; vs.forEach(function (v) { keys[sp[v.slice(0, 2)] ? v.slice(0, 3) : v.slice(0, 2)] = 1; });
          return Promise.all(Object.keys(keys).map(shard)).then(function (shards) {
            var per = {};  // book -> chapter -> n
            vs.forEach(function (v) {
              shards.forEach(function (s) {
                (s[v] || []).forEach(function (row) {
                  var b = per[row[0]] = per[row[0]] || {};
                  for (var i = 2; i < row.length; i += 2) b[row[i]] = (b[row[i]] || 0) + row[i + 1];
                });
              });
            });
            return per;
          });
        }));
      }).then(function (pers) {
        var res = [];
        Object.keys(pers[0]).forEach(function (bk) {
          if (!pers.every(function (p) { return p[bk]; })) return;
          var all = {}, both = {}, n = 0;
          pers.forEach(function (p, k) {
            Object.keys(p[bk]).forEach(function (c) {
              n += p[bk][c]; all[c] = (all[c] || 0) + p[bk][c];
              if (pers.every(function (q) { return q[bk][c]; })) both[c] = all[c];
            });
          });
          var chs = Object.keys(both).length ? both : all;
          res.push({book: +bk, n: n, chapters: chs});
        });
        res.sort(function (a, b) { return b.n - a.n; });
        return res;
      });
    }

    function hasAll(text, ws) { var f = foldIdx(text); return ws.every(function (w) { return f.indexOf(w) >= 0; }); }
    function hl(text, ws) {
      var s = String(text || ''), f = foldKeep(s).replace(/'/g, ' ');
      if (!ws.length) return esc(s);
      var on = new Array(s.length);
      ws.forEach(function (w) { var i = 0; while ((i = f.indexOf(w, i)) >= 0) { for (var k = i; k < i + w.length; k++) on[k] = 1; i += w.length; } });
      var o = '', m = false;
      for (var i = 0; i < s.length; i++) {
        if (on[i] && !m) { o += '<mark>'; m = true; }
        if (!on[i] && m) { o += '</mark>'; m = false; }
        o += esc(s[i]);
      }
      return o + (m ? '</mark>' : '');
    }
    function sortT(t) { return t.replace(/^(The|A|An) /, '').toLowerCase(); }
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
    function acts(b) {
      return '<span class="acts">' + (b.read ? '<a class="act" href="' + BASE + 'read/' + esc(b.id) + '/">Read online</a>' : '') +
        '<a class="act" href="' + esc(b.pdf) + '" data-goatcounter-click="pdf-' + esc(b.id) + '" data-goatcounter-title="' + esc(b.t) + '">Print this book</a></span>';
    }
    function mainHref(b, extra) { return b.read ? BASE + 'read/' + b.id + '/' + (extra || '') : b.pdf; }
    function rec(b, ws) {
      return '<li class="rec"><a class="main" href="' + esc(mainHref(b)) + '"><span class="t">' + hl(b.t, ws) + '</span><span class="a">' + hl(b.a, ws) +
        (b.tr ? ' · tr. ' + esc(b.tr) : '') + '</span>' + (b.desc ? '<span class="d">' + esc(b.desc) + '</span>' : '') + '</a>' +
        '<span class="m mono">' + esc(b.d) + '</span>' + acts(b) + '</li>';
    }

    function render() {
      var my = ++run, q = query.trim();
      document.title = q ? '“' + q + '” · Search · Foggy Press' : 'Search · Foggy Press';
      var head = '<div class="ph"><span class="crumb"><a href="' + BASE + '">Home</a> / Search</span>';
      if (!q) { out.innerHTML = head + '<h1>Search</h1><p class="sub">Type a title, an author, or any word from inside the books.</p></div>'; return; }
      var ws = words(q).filter(function (w) { return !STOP[w] || words(q).every(function (x) { return STOP[x]; }); });
      var tws = textWords(q);
      booksP.then(function (books) {
        if (my !== run) return;
        var byT = function (a, b) { return sortT(a.t).localeCompare(sortT(b.t)); };
        var am = {};
        books.forEach(function (b) { if (b.a && hasAll(b.a, ws)) (am[b.a] = am[b.a] || {last: b.al, b: []}).b.push(b); });
        var authors = Object.keys(am).sort(function (a, b) { return am[a].last.localeCompare(am[b].last) || a.localeCompare(b); });
        var titles = books.filter(function (b) { return hasAll(b.t, ws); }).sort(byT);
        var top = head + '<h1>“' + esc(q) + '”</h1><p class="sub" id="sr-sum"></p></div>';
        var body = '';
        if (authors.length) body += '<section class="rgroup"><div class="sec-h"><h2>Authors</h2><span class="eyebrow">' + authors.length + '</span></div><ul class="authors">' +
          authors.map(function (a) {
            var bs = am[a].b.slice().sort(byT);
            return '<li class="au"><span class="n">' + hl(a, ws) + '</span><span class="c mono">' + plural(bs.length, 'book', 'books') + '</span><span class="bk">' +
              bs.map(function (b) { return '<a href="' + esc(mainHref(b)) + '">' + esc(b.t) + '</a>'; }).join('') + '</span></li>';
          }).join('') + '</ul></section>';
        if (titles.length) body += '<section class="rgroup"><div class="sec-h"><h2>Titles</h2><span class="eyebrow">' + titles.length + '</span></div><ul class="recs">' +
          titles.map(function (b) { return rec(b, ws); }).join('') + '</ul></section>';
        out.innerHTML = top + body + (tws.length ? '<section class="rgroup" id="sr-in"><div class="sec-h"><h2>Inside the books</h2><span class="eyebrow">Searching…</span></div></section>' : '');
        var sum = function (inside) {
          var parts = [];
          if (authors.length) parts.push(plural(authors.length, 'author', 'authors'));
          if (titles.length) parts.push(plural(titles.length, 'title', 'titles'));
          if (inside) parts.push('found inside ' + plural(inside, 'book', 'books'));
          document.getElementById('sr-sum').textContent = parts.join(' · ');
          if (!parts.length && inside != null) document.getElementById('sr-sum').innerHTML = 'Nothing matches. Check the spelling, try fewer words, or <a href="' + BASE + 'tags/">browse the collections</a>.';
        };
        sum(null);
        if (!tws.length) { sum(0); return; }
        fullText(tws).then(function (res) {
          if (my !== run) return;
          var sec = document.getElementById('sr-in');
          sum(res.length);
          if (!res.length) { sec.remove(); return; }
          sec.innerHTML = '<div class="sec-h"><h2>Inside the books</h2><span class="sortbar"><span class="eyebrow">Most mentions first</span>' +
            '<button type="button" class="chip" id="xall">Expand all</button></span></div><ul class="recs">' +
            res.map(function (r, i) {
              var b = books[r.book], nc = Object.keys(r.chapters).length;
              return '<li class="rec ins" data-i="' + i + '"' + (i >= SHOWN ? ' hidden' : '') + '><a class="main" href="' + esc(mainHref(b, b.read ? '?q=' + encodeURIComponent(q) : '')) + '"><span class="t">' + esc(b.t) + '</span><span class="a">' + esc(b.a) + (b.tr ? ' · tr. ' + esc(b.tr) : '') + '</span></a>' +
                '<span class="m mono">' + plural(r.n, 'mention', 'mentions') + ' · ' + plural(nc, b.ch.length === 1 ? 'place' : 'chapter', b.ch.length === 1 ? 'places' : 'chapters') + '</span>' + acts(b) +
                (b.read ? '<details class="snipd"><summary><span class="mono">Show passages</span></summary><div class="snips"><span class="snip-wait mono">Loading passages…</span></div></details>' : '') + '</li>';
            }).join('') + '</ul>' +
            (res.length > SHOWN ? '<div class="morebar"><span class="mono" id="sr-shown">Showing ' + SHOWN + ' of ' + res.length + ' books</span><button class="btn ghost sm" type="button" id="sr-more">Show all ' + res.length + '</button></div>' : '');
          var lis = sec.querySelectorAll('li.ins');
          lis.forEach(function (li) {
            var d = li.querySelector('details');
            if (d) d.addEventListener('toggle', function () { if (d.open) passages(li, books[res[+li.dataset.i].book], res[+li.dataset.i], tws, q); });
          });
          var more = document.getElementById('sr-more');
          if (more) more.addEventListener('click', function () { lis.forEach(function (li) { li.hidden = false; }); more.parentNode.remove(); });
          var xa = document.getElementById('xall');
          xa.addEventListener('click', function () {
            var open = xa.textContent === 'Expand all';
            lis.forEach(function (li) { var d = li.querySelector('details'); if (d && !li.hidden) d.open = open; });
            xa.textContent = open ? 'Collapse all' : 'Expand all';
          });
        }).catch(function () {
          if (my !== run) return;
          var sec = document.getElementById('sr-in');
          if (sec) sec.querySelector('.eyebrow').textContent = 'Couldn’t search inside the books just now. Please try again.';
        });
      });
    }

    // up to three passages: the chapters with the most mentions, in reading order
    function passages(li, b, r, tws, q) {
      if (li.dataset.loaded) return;
      li.dataset.loaded = '1';
      var box = li.querySelector('.snips');
      var url = BASE + 'read/' + b.id + '/';
      if (!pageCache[b.id]) pageCache[b.id] = fetch(url).then(function (x) { return x.text(); }).then(function (h) { return new DOMParser().parseFromString(h, 'text/html'); });
      pageCache[b.id].then(function (doc) {
        var chs = Object.keys(r.chapters).map(Number).sort(function (x, y) { return r.chapters[y] - r.chapters[x] || x - y; }).slice(0, 3).sort(function (x, y) { return x - y; });
        var alts = [];
        tws.forEach(function (w) { [w, w + 's', w + 'es'].forEach(function (v) { alts.push(v); }); });
        var rx = new RegExp('\\b(' + alts.join('|') + ')\\b');
        box.innerHTML = chs.map(function (c) {
          var info = b.ch[c] || ['', ''], sid = info[0];
          var el = sid ? doc.getElementById(sid) : doc.querySelector('article.book');
          if (!el) return '';
          var copy = el.cloneNode(true);
          copy.querySelectorAll('h2, details, header').forEach(function (x) { x.remove(); });
          copy.querySelectorAll('p, h3, h4, li, div, br, td, blockquote, figure, figcaption').forEach(function (x) { x.after(' '); });
          var tx = copy.textContent.replace(/\s+/g, ' ').trim();
          var m = rx.exec(foldKeep(tx).replace(/'/g, ' '));
          var at = m ? m.index : 0, len = m ? m[0].length : 0;
          var a = Math.max(0, at - 90), z = Math.min(tx.length, at + len + 110);
          if (a > 0) a = tx.indexOf(' ', a) + 1;
          var zz = tx.indexOf(' ', z); if (zz > 0) z = zz;
          return '<a class="snip" href="' + esc(url + '?q=' + encodeURIComponent(q) + (sid ? '#' + sid : '')) + '"><span class="ch mono">' + esc(info[1] || 'Text') +
            (r.chapters[c] > 1 ? ' · ' + r.chapters[c] : '') + '</span><span class="tx">' + (a > 0 ? '…' : '') + esc(tx.slice(a, at)) +
            (len ? '<mark>' + esc(tx.slice(at, at + len)) + '</mark>' : '') + esc(tx.slice(at + len, z)) + (z < tx.length ? '…' : '') + '</span></a>';
        }).join('') || '<span class="snip-wait mono">Open the book to see where it appears.</span>';
      }).catch(function () {
        delete li.dataset.loaded;
        box.innerHTML = '<span class="snip-wait mono">Couldn’t load the passages. Close and open again to retry.</span>';
      });
    }

    render();
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
      lst = document.getElementById('find-all'), hits = document.getElementById('find-hits');
    if (!art) return;
    var marks = [], cur = -1, timer, lastQ = '';
    var LIST_MAX = 300;

    function clear() {
      var parents = [];
      art.querySelectorAll('mark.hit').forEach(function (m) { var p = m.parentNode; p.replaceChild(document.createTextNode(m.textContent), m); parents.push(p); });
      parents.forEach(function (p) { p.normalize(); });
      marks = []; cur = -1;
    }
    function setList(open) { hits.hidden = !open; lst.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    function chapterOf(node) { var s = node.closest('section'); var h = s && s.querySelector('h2'); return h ? h.textContent.trim() : 'Opening'; }
    function search(q, stay) {
      lastQ = q; clear(); hits.querySelector('ol').innerHTML = '';
      var p = foldKeep(q.trim());
      if (p.length < 2) { cnt.textContent = ''; prev.disabled = next.disabled = lst.disabled = true; lst.textContent = 'All'; setList(false); return; }
      var walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT, {acceptNode: function (n) {
        return n.parentNode.closest('details.toc, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }});
      var nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(function (n) {
        var t = n.nodeValue, f = foldKeep(t), i = f.indexOf(p);
        if (i < 0) return;
        var frag = document.createDocumentFragment(), last = 0;
        while (i >= 0) {
          frag.appendChild(document.createTextNode(t.slice(last, i)));
          var m = document.createElement('mark'); m.className = 'hit'; m.textContent = t.slice(i, i + p.length);
          frag.appendChild(m); marks.push(m); last = i + p.length; i = f.indexOf(p, last);
        }
        frag.appendChild(document.createTextNode(t.slice(last)));
        n.parentNode.replaceChild(frag, n);
      });
      var n = marks.length;
      prev.disabled = next.disabled = lst.disabled = !n;
      lst.textContent = n ? 'All ' + n : 'All';
      if (!n) { cnt.textContent = 'No matches'; setList(false); return; }
      hits.querySelector('ol').innerHTML = marks.slice(0, LIST_MAX).map(function (m, i) {
        var blk = m.closest('p, li, td, blockquote, h2, h3, div') || m.parentNode, tx = blk.textContent, before = 0;
        var w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) { if (w.currentNode.parentNode === m) break; before += w.currentNode.nodeValue.length; }
        var a = Math.max(0, before - 60), z = Math.min(tx.length, before + m.textContent.length + 80);
        return '<li><a href="#" data-hit="' + i + '"><span class="ch">' + esc(chapterOf(m)) + '</span><span class="s">' + (a > 0 ? '…' : '') + esc(tx.slice(a, before)) +
          '<mark>' + esc(m.textContent) + '</mark>' + esc(tx.slice(before + m.textContent.length, z)) + (z < tx.length ? '…' : '') + '</span></a></li>';
      }).join('') + (n > LIST_MAX ? '<li class="more mono">First ' + LIST_MAX + ' of ' + n + ' shown. Use the arrows for the rest.</li>' : '');
      if (!stay) go(0);
    }
    function go(i) {
      if (!marks.length) return;
      if (cur >= 0) marks[cur].classList.remove('cur');
      cur = (i + marks.length) % marks.length;
      marks[cur].classList.add('cur');
      cnt.textContent = (cur + 1) + ' of ' + marks.length;
      // jump straight there, as find does in a document
      marks[cur].scrollIntoView({block: 'center'});
    }
    bq.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { search(bq.value); }, 250); });
    bq.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault(); clearTimeout(timer);
        if (bq.value !== lastQ) search(bq.value); else go(e.shiftKey ? cur - 1 : cur + 1);
      } else if (e.key === 'Escape') { bq.value = ''; search(''); }
    });
    prev.addEventListener('click', function () { go(cur - 1); });
    next.addEventListener('click', function () { go(cur + 1); });
    lst.addEventListener('click', function () { setList(hits.hidden); });
    hits.addEventListener('click', function (e) {
      var a = e.target.closest('[data-hit]'); if (!a) return;
      e.preventDefault(); setList(false); go(+a.dataset.hit);
    });
    // arriving from the site search: /read/<id>/?q=atlanta#c49 finds the word and goes to its first place in that chapter
    var q = new URLSearchParams(location.search).get('q');
    if (q) {
      bq.value = q;
      search(q, true);
      var start = 0, sec = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
      if (sec) for (var k = 0; k < marks.length; k++) if (sec.contains(marks[k])) { start = k; break; }
      if (marks.length) setTimeout(function () { go(start); }, 0);
    }
  }
})();
