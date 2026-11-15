// Britannica front page: "Find an article". Titles match as you type (from /britannica/titles.json);
// words are also looked up in the articles' own full-text index (/britannica/search/), most mentions first.
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
  function words(s) { return (fold(s).match(/[a-z0-9]+/g) || []).filter(function (w) { return w.length > 1 && !STOP[w]; }); }
  function get(p) { return fetch(DATA + p).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  var titlesP = get('titles.json'), splitP = get('search/split.json').catch(function () { return []; }), rowsP = null, cache = {};
  function shard(k) { return cache[k] || (cache[k] = get('search/w/' + k + '.json').catch(function () { return {}; })); }
  function li(slug, title, vol, page, extra) {
    return '<li><a href="' + esc(artHref(slug, extra)) + '">' + esc(title) + '</a><span class="mono">Vol. ' + vol + (page ? ', p. ' + esc(page) : '') + '</span></li>';
  }
  function fullText(ws) {
    rowsP = rowsP || get('search/books.json');
    return Promise.all([splitP, rowsP]).then(function (r) {
      var sp = {}; r[0].forEach(function (k) { sp[k] = 1; });
      return Promise.all(ws.map(function (w) {
        return shard(sp[w.slice(0, 2)] ? w.slice(0, 3) : w.slice(0, 2)).then(function (s) {
          var m = {}; (s[w] || []).forEach(function (row) { m[row[0]] = row[1]; }); return m;
        });
      })).then(function (maps) {
        var res = [];
        Object.keys(maps[0]).forEach(function (k) {
          if (!maps.every(function (m) { return m[k]; })) return;
          res.push({row: r[1][k], n: maps.reduce(function (a, m) { return a + m[k]; }, 0)});
        });
        return res.sort(function (a, b) { return b.n - a.n; });
      });
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
      var ws = words(q);
      var box = document.getElementById('eb-in');
      if (!ws.length) { box.remove(); return; }
      fullText(ws).then(function (res) {
        if (my !== seq) return;
        var top = res.slice(0, 50), extra = '?q=' + encodeURIComponent(q);
        box.innerHTML = '<div class="eyebrow">Inside the articles · ' + res.length + (res.length > 50 ? ' (top 50, most mentions first)' : '') + '</div>' +
          (top.length ? '<ul>' + top.map(function (r) { return li(r.row.id, r.row.t, r.row.v, r.row.p, extra); }).join('') + '</ul>' : '<p class="none">No article uses all of those words.</p>');
      }).catch(function () { box.innerHTML = '<p class="none">Couldn’t search inside the articles just now.</p>'; });
    });
  }
  inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(render, 200); });
  var q0 = new URLSearchParams(location.search).get('q');
  if (q0) { inp.value = q0; render(); }
})();
