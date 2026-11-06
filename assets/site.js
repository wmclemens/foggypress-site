// Foggy Press public pages: theme switch, collection sort (Tag / Popular) and "More collections" paging.
(function () {
  var root = document.documentElement;
  var dark = function () { return root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
  var tb = document.getElementById('theme');
  if (tb) {
    var label = function () { tb.textContent = dark() ? 'Light mode' : 'Dark mode'; };
    label();
    tb.addEventListener('click', function () {
      root.dataset.theme = dark() ? 'light' : 'dark';
      try { localStorage.setItem('fp-theme', root.dataset.theme); } catch (e) {}
      label();
    });
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
    count.textContent = 'Showing ' + n + ' of ' + tiles.length;
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
  draw();
})();

// Contact form on the About page: sends through Web3Forms after the hCaptcha check.
(function () {
  var f = document.getElementById('contact');
  if (!f || !f.dataset.key) return;
  var status = document.getElementById('cf-status');
  var say = function (msg, cls) { status.textContent = msg; status.className = 'formnote' + (cls ? ' ' + cls : ''); };
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var el = f.elements, name = el['name'].value.trim(), email = el['email'].value.trim(), msg = el['message'].value.trim();
    if (!name || !email || !msg) { say('Please fill in your name, email and message.', 'bad'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { say('That email address doesn’t look right. Please check it.', 'bad'); return; }
    var cap = f.querySelector('[name="h-captcha-response"]');
    if (!cap || !cap.value) { say('Please tick “I am human” before sending.', 'bad'); return; }
    var btn = f.querySelector('button[type=submit]'); btn.disabled = true; say('Sending…');
    var data = new FormData(f);
    data.append('access_key', f.dataset.key);
    data.append('subject', 'Foggy Press website: message from ' + name);
    data.append('from_name', 'Foggy Press website');
    fetch('https://api.web3forms.com/submit', {method: 'POST', body: data})
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.success) { f.reset(); if (window.hcaptcha) hcaptcha.reset(); say('Thank you. Your message has been sent.', 'ok'); }
        else { say('Your message didn’t send: ' + (j.message || 'please try again.'), 'bad'); if (window.hcaptcha) hcaptcha.reset(); }
      })
      .catch(function () { say('Your message didn’t send. Please check your connection and try again.', 'bad'); })
      .then(function () { btn.disabled = false; });
  });
})();
