// Britannica front page: "Find an article". Titles match as you type (from /britannica/titles.json);
// the articles' own full-text index (britannica/search/) finds a word (or its plural), or several words as an exact phrase.
(function () {
  var inp = document.getElementById('ebq'), out = document.getElementById('eb-results');
  if (!inp) return;
  // the articles and their data: files.foggypress.com/britannica/ (R2), or /britannica/ on a site that keeps its own files
  var DATA = inp.dataset.base || '/britannica/', R2 = /^https?:/.test(DATA);
  function artHref(slug, extra) { return DATA + slug + '/' + (R2 ? 'index.html' : '') + (extra || ''); }
  var STOP = {};
  ('a about after all also an and any are as at be been but by can could did do does for from had has have he her him his how i if in into is it its may me more most my no not now of on one only or our out over she so some such than that the their them then there these they this those to up upon us was we were what when where which who whom why will with would you your').split(' ').forEach(function (w) { STOP[w] = 1; });
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  function fold(s) {
    return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’‘]/g, "'").replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss').replace(/'s\b/g, '').replace(/'/g, '');
  }
  function toks(s) { return fold(s).match(/[a-z0-9]+/g) || []; }
  function get(p) { return fetch(DATA + p).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  var titlesP = get('titles.json'), rowsP = null, keysP = null, cache = {};
  function li(slug, title, vol, page, extra) {
    return '<li><a href="' + esc(artHref(slug, extra)) + '">' + esc(title) + '</a><span class="mono">Vol. ' + vol + (page ? ', p. ' + esc(page) : '') + '</span></li>';
  }
  // ---- the full-text index (format: build/search_index.py; one "book" per article, one "chapter" each)
  function keyFor(set, w) {
    if (set[w + '-']) return w + '-';
    for (var n = w.length; n >= 2; n--) if (set[w.slice(0, n)]) return w.slice(0, n);
    return null;
  }
  function file(key) {
    if (!cache[key]) cache[key] = fetch(DATA + 'search/p/' + key + '.bin').then(function (r) {
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
    return cache[key];
  }
  // where one word sits: {article: [positions]}
  function places(w) {
    keysP = keysP || get('search/p.json').then(function (ks) { var set = {}; ks.forEach(function (k) { set[k] = 1; }); return set; });
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
          var nc = num(), ch = 0, all = out[bk] = out[bk] || [];
          for (var y = 0; y < nc; y++) {
            ch += num();
            var np = num(), pos = 0;
            for (var z = 0; z < np; z++) { pos += num(); all.push(pos); }
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
  // [{row, n}], most mentions first. One word: it and its plural or singular. Several: the exact phrase.
  function fullText(ts) {
    var idx = [];
    ts.forEach(function (w, k) { if (w.length > 1 && !STOP[w]) idx.push(k); });
    if (!idx.length) return Promise.resolve(null);
    rowsP = rowsP || get('search/books.json');
    var hits = ts.length === 1
      ? Promise.all(variants(ts[0]).map(places)).then(function (all) {
          var per = {}; all.forEach(function (pl) { Object.keys(pl).forEach(function (k) { per[k] = (per[k] || 0) + pl[k].length; }); }); return per;
        })
      : Promise.all(idx.map(function (k) { return places(ts[k]); })).then(function (all) {
          var per = {};
          Object.keys(all[0]).forEach(function (k) {
            if (!all.every(function (pl) { return pl[k]; })) return;
            var lists = all.map(function (pl, j) { return {off: idx[j], ps: pl[k]}; }).sort(function (a, b) { return a.ps.length - b.ps.length; });
            var sets = lists.slice(1).map(function (l) { return {off: l.off, s: new Set(l.ps)}; }), n = 0;
            lists[0].ps.forEach(function (p) { var st = p - lists[0].off; if (sets.every(function (s) { return s.s.has(st + s.off); })) n++; });
            if (n) per[k] = n;
          });
          return per;
        });
    return Promise.all([hits, rowsP]).then(function (r) {
      return Object.keys(r[0]).map(function (k) { return {row: r[1][k], n: r[0][k]}; }).sort(function (a, b) { return b.n - a.n; });
    });
  }
  var timer, seq = 0;
  function render() {
    var q = inp.value.trim(), my = ++seq;
    if (q.length < 2) { out.innerHTML = ''; return; }
    var fq = fold(q);
    titlesP.then(function (titles) {
      if (my !== seq) return;
      var starts = [], has = [];
      titles.forEach(function (t) { var f = fold(t[1]); if (f.indexOf(fq) === 0) starts.push(t); else if (f.indexOf(fq) > 0) has.push(t); });
      var tm = starts.concat(has).slice(0, 30);
      var html = '<div class="grp"><div class="eyebrow">Article titles · ' + (starts.length + has.length) + '</div>' +
        (tm.length ? '<ul>' + tm.map(function (t) { return li(t[0], t[1], t[2], t[3]); }).join('') + '</ul>' : '<p class="none">No article has that in its title.</p>') + '</div>' +
        '<div class="grp" id="eb-in"><div class="eyebrow">Inside the articles · searching…</div></div>';
      out.innerHTML = html;
      var box = document.getElementById('eb-in');
      fullText(toks(q)).then(function (res) {
        if (my !== seq) return;
        if (!res) { box.remove(); return; }
        var top = res.slice(0, 50), extra = '?q=' + encodeURIComponent(q);
        box.innerHTML = '<div class="eyebrow">Inside the articles · ' + res.length + (res.length > 50 ? ' (top 50, most mentions first)' : '') + '</div>' +
          (top.length ? '<ul>' + top.map(function (r) { return li(r.row.id, r.row.t, r.row.v, r.row.p, extra); }).join('') + '</ul>' : (toks(q).length > 1 ? '<p class="none">No article has that exact phrase.</p>' : '<p class="none">No article mentions that.</p>'));
      }).catch(function () { box.innerHTML = '<p class="none">Couldn’t search inside the articles just now.</p>'; });
    });
  }
  inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(render, 200); });
  var q0 = new URLSearchParams(location.search).get('q');
  if (q0) { inp.value = q0; render(); }
})();
