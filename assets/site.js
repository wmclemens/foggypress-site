// Foggy Press public pages: theme switch, collection sort (Tag / Popular), "More collections" paging,
// and the book sort on collection pages (Author / Title / Popular).
// feature-use counts for the admin Reports tab: GoatCounter events, no personal data
window.fpEvent = function (name) {
  try { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({path: String(name).slice(0, 120), title: 'event', event: true}); } catch (e) {}
};
// Read-online pages are served from files.foggypress.com, which keeps its own settings: links there carry
// the reader's language and theme (?fp=es.dark), and assets/i18n.js there takes them up.
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a[href*="/read/"]');
  if (!a || a.host === location.host || !/^https?:$/.test(a.protocol)) return;
  var lang = window.fpLang ? window.fpLang() : '', th = document.documentElement.dataset.theme || '';
  if (!lang && !th) return;
  var u = new URL(a.href); u.searchParams.set('fp', lang + '.' + th); a.href = u.toString();
}, true);
// "?" help buttons (.qm): a tap or click opens the short note beside them (.qpop), again closes it; Esc, the ×
// or a tap anywhere else closes it too. The notes may be drawn later by other scripts, so this listens on the page.
// Also closes the read pages' "Aa" menu (details.rb-menu) on a tap outside it.
(function () {
  function closeAll(except) {
    document.querySelectorAll('.qm[aria-expanded="true"]').forEach(function (b) {
      if (b === except) return;
      b.setAttribute('aria-expanded', 'false');
      var p = document.getElementById(b.getAttribute('aria-controls')); if (p) p.hidden = true;
    });
  }
  function fit(p) {   // keep the note on screen
    p.style.left = ''; p.style.right = '';
    var r = p.getBoundingClientRect(), w = document.documentElement.clientWidth;
    if (r.right > w - 8) p.style.left = (parseFloat(getComputedStyle(p).left) - (r.right - (w - 8))) + 'px';
    r = p.getBoundingClientRect();
    if (r.left < 8) p.style.left = (parseFloat(getComputedStyle(p).left) + (8 - r.left)) + 'px';
  }
  document.addEventListener('click', function (e) {
    var t = e.target, b = t.closest && t.closest('.qm');
    if (b) {
      e.preventDefault();
      var p = document.getElementById(b.getAttribute('aria-controls')), open = b.getAttribute('aria-expanded') !== 'true';
      closeAll(b);
      b.setAttribute('aria-expanded', String(open));
      if (p) { p.hidden = !open; if (open) { fit(p); if (window.fpEvent) fpEvent('help: ' + b.getAttribute('aria-controls')); } }
      return;
    }
    if (t.closest && t.closest('.qx')) { closeAll(); return; }
    if (!(t.closest && t.closest('.qpop'))) closeAll();
    document.querySelectorAll('details.rb-menu[open]').forEach(function (d) { if (!d.contains(t)) d.open = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var b = document.querySelector('.qm[aria-expanded="true"]');
    closeAll(); if (b) b.focus();
    document.querySelectorAll('details.rb-menu[open]').forEach(function (d) { d.open = false; });
  });
})();
// help note markup for pages drawn by script: fpHelp('ask', 'About Ask Foggy Press', ['First paragraph', ...]) (paragraphs are HTML)
window.fpHelp = function (id, label, paras) {
  var T = window.fpT || function (s) { return s; };
  var e = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); };
  return '<span class="qwrap"><button type="button" class="qm" aria-expanded="false" aria-controls="help-' + id + '" aria-label="' + e(label) + '">?</button>' +
    '<span class="qpop" id="help-' + id + '" role="note" hidden><button type="button" class="qx" aria-label="' + e(T('Close')) + '">×</button>' +
    paras.map(function (p) { return '<span>' + p + '</span>'; }).join('') + '</span></span>';
};
(function () {
  var T = window.fpT || function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); };
  var root = document.documentElement;
  var dark = function () { return root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
  var tb = document.getElementById('theme');
  if (tb) {
    var label = function () { tb.textContent = dark() ? T('Light mode') : T('Dark mode'); };
    document.addEventListener('fp-lang', label);
    label();
    tb.addEventListener('click', function () {
      root.dataset.theme = dark() ? 'light' : 'dark';
      fpEvent('theme: ' + root.dataset.theme);
      try { localStorage.setItem('fp-theme', root.dataset.theme); } catch (e) {}
      label();
    });
  }

  var cmp = function (x, y) { return x.localeCompare(y, 'en', {numeric: true}); };   // natural order: "Volume 2" before "Volume 10"

  // books on a collection page: Author (A to Z by last name, then title), Title, or Popular (online views + PDF downloads)
  var bar = document.querySelector('.booksort'), list = bar && document.querySelector('ul.recs');
  if (list) {
    var rows = Array.prototype.slice.call(list.children), bsort = 'author';
    try { bsort = sessionStorage.getItem('fp-bsort') || 'author'; } catch (e) {}
    var by = {
      author: function (a, b) { return cmp(a.dataset.au, b.dataset.au) || cmp(a.dataset.ti, b.dataset.ti); },
      title: function (a, b) { return cmp(a.dataset.ti, b.dataset.ti) || cmp(a.dataset.au, b.dataset.au); },
      popular: function (a, b) { return (+b.dataset.pop - +a.dataset.pop) || by.author(a, b); }
    };
    var drawBooks = function () {
      if (!by[bsort]) bsort = 'author';
      rows.sort(by[bsort]).forEach(function (r) { list.appendChild(r); });
      bar.querySelectorAll('[data-bsort]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.bsort === bsort)); });
    };
    bar.querySelectorAll('[data-bsort]').forEach(function (b) {
      b.addEventListener('click', function () { bsort = b.dataset.bsort; fpEvent('sort: books by ' + bsort); try { sessionStorage.setItem('fp-bsort', bsort); } catch (e) {} drawBooks(); });
    });
    drawBooks();
  }

  // the By author page: each author's titles are folded under the name; open one, or all, or the one in the link (#austen-jane)
  var auAll = document.getElementById('au-all');
  if (auAll) {
    var groups = Array.prototype.slice.call(document.querySelectorAll('details.augrp'));
    var setAll = function (open) {
      groups.forEach(function (d) { d.open = open; });
      auAll.dataset.open = open ? '1' : '';
      auAll.setAttribute('data-t', open ? 'Collapse all' : 'Expand all');
      auAll.textContent = T(open ? 'Collapse all' : 'Expand all');
    };
    auAll.addEventListener('click', function () { setAll(!auAll.dataset.open); });
    var openHash = function () {
      var d = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (d && d.tagName === 'DETAILS') { d.open = true; d.scrollIntoView(); }
    };
    window.addEventListener('hashchange', openHash);
    openHash();
  }

  var grid = document.getElementById('colls');
  if (!grid) return;
  var per = +grid.dataset.page || 25, shown = per;
  var tiles = Array.prototype.slice.call(grid.children);
  var more = document.getElementById('more'), count = document.getElementById('shown');
  var sort = 'tag';
  try { sort = sessionStorage.getItem('fp-sort') || 'tag'; } catch (e) {}
  function draw() {
    tiles.sort(sort === 'popular'
      ? function (a, b) { return (+b.dataset.dl - +a.dataset.dl) || cmp(a.dataset.name, b.dataset.name); }
      : function (a, b) { return cmp(a.dataset.name, b.dataset.name); });
    tiles.forEach(function (t, i) { t.hidden = i >= shown; grid.appendChild(t); });
    var n = Math.min(shown, tiles.length);
    count.textContent = T('Showing {n} of {m}', {n: n, m: tiles.length});
    more.hidden = shown >= tiles.length;
    document.querySelectorAll('[data-sort]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.sort === sort)); });
  }
  document.querySelectorAll('[data-sort]').forEach(function (b) {
    b.addEventListener('click', function () {
      sort = b.dataset.sort; shown = per; fpEvent('sort: collections by ' + sort);
      try { sessionStorage.setItem('fp-sort', sort); } catch (e) {}
      draw();
    });
  });
  more.addEventListener('click', function () { shown += per; draw(); });
  document.addEventListener('fp-lang', draw);
  draw();
})();

// Contact form on the About page: sends through Web3Forms after the hCaptcha check.
(function () {
  var T = window.fpT || function (s) { return s; };
  var f = document.getElementById('contact');
  if (!f || !f.dataset.key) return;
  var status = document.getElementById('cf-status');
  var say = function (msg, cls) { status.textContent = msg; status.className = 'formnote' + (cls ? ' ' + cls : ''); };
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = f.elements, name = el['name'].value.trim(), email = el['email'].value.trim(), msg = el['message'].value.trim();
    if (!name || !email || !msg) { say(T('Please fill in your name, email and message.'), 'bad'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { say(T('That email address doesn’t look right. Please check it.'), 'bad'); return; }
    var cap = f.querySelector('[name="h-captcha-response"]');
    if (!cap || !cap.value) { say(T('Please tick “I am human” before sending.'), 'bad'); return; }
    var btn = f.querySelector('button[type=submit]'); btn.disabled = true; say(T('Sending…'));
    var data = new FormData(f); data.delete('g-recaptcha-response'); // hCaptcha adds this copy; Web3Forms would read it as reCAPTCHA (a paid feature)
    data.append('access_key', f.dataset.key);
    data.append('subject', 'Foggy Press website: message from ' + name);
    data.append('from_name', 'Foggy Press website');
    fetch('https://api.web3forms.com/submit', {method: 'POST', body: data})
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.success) { f.reset(); if (window.hcaptcha) hcaptcha.reset(); say(T('Thank you. Your message has been sent.'), 'ok'); }
        else { say(T('Your message didn’t send: {why}', {why: j.message || T('please try again.')}), 'bad'); if (window.hcaptcha) hcaptcha.reset(); }
      })
      .catch(function () { say(T('Your message didn’t send. Please check your connection and try again.'), 'bad'); })
      .then(function () { btn.disabled = false; });
  });
})();
