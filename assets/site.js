// Foggy Press public pages: theme switch, collection sort (Tag / Popular), "More collections" paging,
// and the book sort on collection pages (Author / Title / Popular).
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
      try { localStorage.setItem('fp-theme', root.dataset.theme); } catch (e) {}
      label();
    });
  }

  // books on a collection page: Author (A to Z by last name, then title), Title, or Popular (online views + PDF downloads)
  var bar = document.querySelector('.booksort'), list = bar && document.querySelector('ul.recs');
  if (list) {
    var rows = Array.prototype.slice.call(list.children), bsort = 'author';
    try { bsort = sessionStorage.getItem('fp-bsort') || 'author'; } catch (e) {}
    var cmp = function (x, y) { return x.localeCompare(y, 'en', {numeric: true}); };   // "Volume 2" before "Volume 10"
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
      b.addEventListener('click', function () { bsort = b.dataset.bsort; try { sessionStorage.setItem('fp-bsort', bsort); } catch (e) {} drawBooks(); });
    });
    drawBooks();
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
      ? function (a, b) { return (+b.dataset.dl - +a.dataset.dl) || a.dataset.name.localeCompare(b.dataset.name); }
      : function (a, b) { return a.dataset.name.localeCompare(b.dataset.name); });
    tiles.forEach(function (t, i) { t.hidden = i >= shown; grid.appendChild(t); });
    var n = Math.min(shown, tiles.length);
    count.textContent = T('Showing {n} of {m}', {n: n, m: tiles.length});
    more.hidden = shown >= tiles.length;
    document.querySelectorAll('[data-sort]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.sort === sort)); });
  }
  document.querySelectorAll('[data-sort]').forEach(function (b) {
    b.addEventListener('click', function () {
      sort = b.dataset.sort; shown = per;
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
