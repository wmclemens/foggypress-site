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
