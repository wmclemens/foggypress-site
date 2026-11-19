// Foggy Press admin. Reads and writes catalog/books.json and catalog/tags.json in the site repo
// through the GitHub API, using a fine-grained token kept in this browser only.
(function () {
  'use strict';
  var REPO = 'wmclemens/foggypress-site';
  var BRANCH = 'main';
  var BOOKS = 'catalog/books.json', TAGS = 'catalog/tags.json';
  var FEATURED_MAX = 3;
  // tag display levels (build/build.py LEVEL_NAMES): 1 Featured, 2 Main (home page), 3+ only on By tag, search and links
  var LEVELS = {1: 'Featured', 2: 'Main', 3: 'Other'};
  function levelOf(t) { var n = parseInt(t.level, 10); return n >= 1 ? n : (t.featured ? 1 : 2); }
  function levelName(n) { return LEVELS[n] || 'Level ' + n; }
  function levelPick(t) {
    var cur = levelOf(t), top = Math.max(3, cur + 1, data.tags.reduce(function (m, x) { return Math.max(m, levelOf(x)); }, 0) + 1), o = '';
    for (var n = 1; n <= top; n++) o += '<option value="' + n + '"' + (n === cur ? ' selected' : '') + '>' + n + ' · ' + esc(levelName(n)) + '</option>';
    return '<select class="lvl" data-lvl="' + esc(t.name) + '" aria-label="Display level for ' + esc(t.name) + '">' + o + '</select>';
  }
  var KEY = 'fp-admin-token';

  var $ = function (s) { return document.querySelector(s); };
  // "?" notes (less busy, 19 Nov 2026): how-it-works and setup notes sit behind a "?" beside their heading;
  // assets/site.js opens and closes them. html is trusted admin text.
  var helpN = 0;
  var help = function (html, label) { helpN++; return window.fpHelp ? window.fpHelp('a' + helpN, label || 'About this', [html]) : ''; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); };
  var slugify = function (s) { return s.toLowerCase().replace(/&/g, 'and').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); };
  var sortTitle = function (t) { return t.replace(/^(The|A|An) /, ''); };
  var authorName = function (b) { return (b.author_first + ' ' + b.author_last).trim(); };
  var num = function (n) { return n == null ? '' : Number(n).toLocaleString('en-US'); };

  var yearNum = function (y) { var m = String(y || '').match(/(\d+)/); if (!m) return Infinity; var n = +m[1]; return /BC/.test(y) ? -n : n; };
  var sortedTags = function (b) { return (b.tags || []).slice().sort(function (x, y) { return cmp(x, y); }); };
  var catSort = {key: 'author_last', dir: 1}, tagSort = {key: 'name', dir: 1}, oneTagSort = {key: 'title', dir: 1};
  // A clickable column heading: click sorts by it, click again reverses.
  function th(label, key, state, cls) {
    var on = state.key === key;
    return '<th' + (cls ? ' class="' + cls + '"' : '') + ' aria-sort="' + (on ? (state.dir > 0 ? 'ascending' : 'descending') : 'none') + '"><button type="button" class="sortbtn' + (on ? ' on' : '') + '" data-sortkey="' + key + '">' + label + '<span class="arr">' + (on ? (state.dir > 0 ? '▲' : '▼') : '↕') + '</span></button></th>';
  }
  function wireSort(el, state, redraw) {
    el.querySelectorAll('[data-sortkey]').forEach(function (b) {
      b.onclick = function () { var k = b.dataset.sortkey; if (state.key === k) state.dir = -state.dir; else { state.key = k; state.dir = 1; } redraw(); };
    });
  }
  function cmp(a, b) { if (a === b) return 0; if (a === '' || a == null) return 1; if (b === '' || b == null) return -1; return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, {sensitivity: 'base', numeric: true}); }

  var token = null, user = null;
  var data = {books: null, booksSha: null, tags: null, tagsSha: null};
  var stats = {books: {}, unlisted: [], problems: []};
  var q = '';

  function getToken() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setToken(t) { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch (e) {} }

  var toastTimer;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 5000); }

  // ---- GitHub API ----
  function gh(path, opts) {
    opts = opts || {};
    return fetch('https://api.github.com' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28'}, opts.body ? {'Content-Type': 'application/json'} : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = txt ? JSON.parse(txt) : {};
        if (!r.ok) { var e = new Error(j.message || ('GitHub said ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function b64decode(s) { var bin = atob(s.replace(/\s/g, '')); var bytes = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new TextDecoder().decode(bytes); }
  function b64encode(str) { var bytes = new TextEncoder().encode(str), bin = ''; for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); }
  function readFile(path) {
    // the contents API leaves out files over 1 MB (catalog/books.json passed that on 16 Nov 2026 at ~1,500 books):
    // then the text comes from the git blob, which works up to 100 MB
    return gh('/repos/' + REPO + '/contents/' + path + '?ref=' + BRANCH).then(function (j) {
      var text = j.content && j.encoding === 'base64' ? Promise.resolve(j.content) : gh('/repos/' + REPO + '/git/blobs/' + j.sha).then(function (b) { return b.content; });
      return text.then(function (c) { return {json: JSON.parse(b64decode(c)), sha: j.sha}; });
    });
  }
  function writeFile(path, obj, sha, message) {
    return gh('/repos/' + REPO + '/contents/' + path, {method: 'PUT', body: {message: message, content: b64encode(JSON.stringify(obj, null, 2) + '\n'), sha: sha, branch: BRANCH}})
      .then(function (j) { return j.content.sha; });
  }
  function sortBooks() { data.books.sort(function (a, b) { return cmp(a.author_last + ' ' + a.author_first + ' ' + sortTitle(a.title), b.author_last + ' ' + b.author_first + ' ' + sortTitle(b.title)); }); }
  function saveBooks(message) {
    sortBooks();
    return writeFile(BOOKS, data.books, data.booksSha, message).then(function (sha) { data.booksSha = sha; });
  }
  function saveTags(message) {
    data.tags.sort(function (a, b) { return cmp(a.name, b.name); });
    return writeFile(TAGS, data.tags, data.tagsSha, message).then(function (sha) { data.tagsSha = sha; });
  }
  function failed(e) {
    if (e.status === 409) toast('Someone else saved in the meantime. The latest catalog has been reloaded; make your change again.');
    else if (e.status === 401 || e.status === 403) toast('GitHub refused the save: ' + e.message + '. Check that your token can write to ' + REPO + '.');
    else toast('Could not save: ' + e.message);
    if (e.status === 409) return loadData().then(route);
  }
  var SAVED = 'Saved. The public site updates in about two minutes.';

  function loadData() {
    return Promise.all([readFile(BOOKS), readFile(TAGS)]).then(function (r) {
      data.books = r[0].json; data.booksSha = r[0].sha; data.tags = r[1].json; data.tagsSha = r[1].sha;
    });
  }
  function loadStats() {
    return fetch('stats.json', {cache: 'no-store'}).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) { if (s) stats = s; }).catch(function () {});
  }

  // ---- helpers over data ----
  var tagNames = function () { return data.tags.map(function (t) { return t.name; }); };
  var tagBySlug = function (s) { return data.tags.find(function (t) { return slugify(t.name) === s; }); };
  var booksWith = function (name) { return data.books.filter(function (b) { return (b.tags || []).indexOf(name) >= 0; }); };
  var st = function (b) { return stats.books[b.id] || {}; };
  var isLive = function (b) { var s = st(b); return s.live != null ? s.live : !!b.foggy_press_date; };
  var dlOf = function (b) { return st(b).downloads || 0; };
  var vwOf = function (b) { return st(b).views || 0; };
  var svOf = function (b) { return st(b).saved || 0; };
  var hasSaved = function () { return Object.keys(stats.books || {}).some(function (k) { return stats.books[k].saved != null; }); };

  // ---- views ----
  function tabs(cur) {
    return '<div class="tabs"><a href="#" ' + (cur === 'books' ? 'aria-current="page"' : '') + '>Book catalog</a><a href="#tags" ' + (cur === 'tags' ? 'aria-current="page"' : '') + '>Tag file</a>' +
      '<a href="#reports" ' + (cur === 'reports' ? 'aria-current="page"' : '') + '>Reports</a>' +
      '<a href="#chat" ' + (cur === 'chat' ? 'aria-current="page"' : '') + '>Chat</a></div>';
  }

  function vSignIn(err) {
    $('#app').innerHTML = '<div class="signin"><h1>Sign in</h1>' +
      '<p class="note">Paste a GitHub token that can write to <span class="mono">' + REPO + '</span>. It is kept in this browser only.</p>' +
      '<ol><li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a fine-grained token</a>.</li>' +
      '<li>Repository access: only <span class="mono">foggypress-site</span>.</li><li>Permissions: Contents, Read and write.</li></ol>' +
      '<div class="fld"><label for="tok">Token</label><input id="tok" type="password" autocomplete="off" placeholder="github_pat_…"></div>' +
      '<div><button class="btn" id="go" type="button">Sign in</button></div>' + (err ? '<p class="note err">' + esc(err) + '</p>' : '') + '</div>';
    var go = function () { var v = $('#tok').value.trim(); if (!v) return; token = v; start(true); };
    $('#go').onclick = go;
    $('#tok').onkeydown = function (e) { if (e.key === 'Enter') go(); };
    $('#tok').focus();
  }

  function vCatalog() {
    var un = stats.unlisted || [];
    var banner = un.length ? '<div class="banner"><strong>' + un.length + ' finished PDF' + (un.length === 1 ? ' is' : 's are') + ' not in the catalog yet.</strong><ul>' +
      un.slice(0, 12).map(function (u, i) { return '<li>' + esc(u.title) + ' · ' + esc(u.author_last) + ' <button type="button" data-addun="' + i + '">Add record</button></li>'; }).join('') +
      (un.length > 12 ? '<li>…and ' + (un.length - 12) + ' more</li>' : '') + '</ul></div>' : '';
    var probs = (stats.problems || []).length ? '<div class="banner"><strong>The last build could not find these PDFs:</strong><ul>' + stats.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>' : '';
    $('#app').innerHTML = tabs('books') + banner + probs +
      '<div class="tools"><input id="q" type="search" placeholder="Search title, author or tag" aria-label="Search the catalog" value="' + esc(q) + '"><a class="btn sm" href="#new">New record</a><span class="mono count" id="count"></span></div>' +
      '<div class="tbl-wrap"><table><thead id="chead"></thead><tbody id="rows"></tbody></table></div>' +
      (stats.built ? '<p class="note" style="margin-top:.75rem">Pages and downloads as of the last site build, ' + esc(stats.built.replace('T', ' ')) + ' UTC.</p>' : '');
    var draw = function () {
      var s = q.trim().toLowerCase();
      var list = data.books.filter(function (b) { return !s || [b.author_last, b.author_first, b.title, b.translator].concat(b.tags || []).join(' ').toLowerCase().indexOf(s) >= 0; });
      var val = {
        author_last: function (b) { return b.author_last; }, author_first: function (b) { return b.author_first; },
        title: function (b) { return sortTitle(b.title); }, original_date: function (b) { var n = yearNum(b.original_date); return n === Infinity ? '' : n; },
        foggy_press_date: function (b) { return b.foggy_press_date || ''; }, downloads: function (b) { return dlOf(b); }, views: function (b) { return vwOf(b); }, saved: function (b) { return svOf(b); },
        pages: function (b) { return st(b).pages == null ? '' : st(b).pages; }, tags: function (b) { return sortedTags(b).join(', '); }
      }[catSort.key];
      list.sort(function (a, b) { var r = cmp(val(a), val(b)); return (r * catSort.dir) || cmp(a.author_last + ' ' + a.author_first + ' ' + sortTitle(a.title), b.author_last + ' ' + b.author_first + ' ' + sortTitle(b.title)); });
      $('#chead').innerHTML = '<tr>' + th('Author last', 'author_last', catSort) + th('Author first', 'author_first', catSort) + th('Title', 'title', catSort) + th('Original', 'original_date', catSort) + th('Foggy Press', 'foggy_press_date', catSort) + th('PDF downloads', 'downloads', catSort) + th('Online views', 'views', catSort) + (hasSaved() ? th('Saved', 'saved', catSort) : '') + th('Pages', 'pages', catSort) + th('Tags', 'tags', catSort) + '</tr>';
      wireSort($('#chead'), catSort, draw);
      $('#count').textContent = list.length + ' of ' + data.books.length + ' records · ' + data.books.filter(isLive).length + ' live';
      $('#rows').innerHTML = list.map(function (b) {
        return '<tr class="go" data-id="' + esc(b.id) + '" tabindex="0"><td>' + esc(b.author_last) + '</td><td>' + esc(b.author_first) + '</td><td>' + esc(b.title) + '</td><td class="num">' + esc(b.original_date) + '</td>' +
          '<td class="num">' + (b.foggy_press_date ? esc(b.foggy_press_date) : '<span class="pill warn">Hidden</span>') + '</td><td class="num">' + num(dlOf(b)) + '</td><td class="num">' + num(vwOf(b)) + '</td>' + (hasSaved() ? '<td class="num">' + num(svOf(b)) + '</td>' : '') + '<td class="num">' + num(st(b).pages) + '</td>' +
          '<td><div class="chips">' + sortedTags(b).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') + '</div></td></tr>';
      }).join('');
    };
    $('#q').oninput = function (e) { q = e.target.value; draw(); };
    $('#rows').onclick = function (e) { var r = e.target.closest('tr[data-id]'); if (r) location.hash = 'book-' + r.dataset.id; };
    $('#rows').onkeydown = function (e) { var r = e.target.closest('tr[data-id]'); if (r && e.key === 'Enter') location.hash = 'book-' + r.dataset.id; };
    $('#app').querySelectorAll('[data-addun]').forEach(function (btn) { btn.onclick = function () { pendingNew = un[+btn.dataset.addun]; location.hash = 'new'; }; });
    draw();
  }

  var pendingNew = null;
  function vEdit(id) {
    var isNew = id == null;
    var b = isNew ? Object.assign({id: '', author_last: '', author_first: '', title: '', translator: '', original_date: '', foggy_press_date: '', github_dir: '', github_pdf: '', tags: []}, pendingNew || {}) : data.books.find(function (x) { return x.id === id; });
    pendingNew = null;
    if (!b) { $('#app').innerHTML = tabs('books') + '<p class="note" style="padding:2rem 0">No record with that id. <a href="#">Back to the catalog</a></p>'; return; }
    var f = function (key, label, type, hint, full) {
      return '<div class="fld' + (full ? ' full' : '') + '"><label for="f-' + key + '">' + label + '</label><input id="f-' + key + '" type="' + (type || 'text') + '" value="' + esc(b[key]) + '">' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>';
    };
    var s = st(b);
    $('#app').innerHTML = tabs('books') +
      '<div style="padding-top:1.25rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap"><span class="crumb"><a href="#">Book catalog</a> / ' + (isNew ? 'New record' : 'Edit record') + '</span>' +
      (isNew ? '' : '<span class="mono" style="color:var(--muted)">' + (isLive(b) ? '<span class="pill">Live</span>' : '<span class="pill warn">Not live</span>') + ' · ' + num(s.pages) + ' pages · ' + num(dlOf(b)) + ' PDF downloads · ' + num(vwOf(b)) + ' online views</span>') + '</div>' +
      '<div class="form">' +
      f('author_last', 'Author last name') + f('author_first', 'Author first name') +
      f('title', 'Title', 'text', '', true) +
      f('translator', 'Translator', 'text', 'Optional') + f('original_date', 'Original publish date', 'text', 'Free text: 1851, 1868–69, c. 375 BC') +
      f('foggy_press_date', 'Foggy Press publish date', 'date', 'Leave empty to keep the book off the site') +
      f('id', 'Web address', 'text', isNew ? 'Used in links: /read/<id>/ and the PDF file name <id>.pdf. Filled from the title.' : 'Changing this breaks old links and resets the book’s download count.') +
      f('github_dir', 'GitHub directory link', 'url', '', true) +
      f('github_pdf', 'GitHub PDF link', 'url', 'Admin only. Visitors get the site’s own copy of this PDF.', true) +
      '<div class="fld full"><label for="tagin">Tags' + help('Checked against the tag file as you type. “Create new tag” adds it to the tag file when you save.') + '</label><div class="picker" id="picker"><span class="chips" id="tagchips"></span>' +
      '<input id="tagin" type="text" placeholder="Type to add a tag" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="sugg"><div class="sugg" id="sugg" hidden></div></div></div>' +
      '</div>' +
      '<div class="saverow"><button class="btn" id="save" type="button">' + (isNew ? 'Add to catalog' : 'Save record') + '</button><a class="btn ghost" href="#">Cancel</a>' +
      (isNew ? '' : '<span class="confirm" id="delwrap"><button class="star danger" id="del" type="button">Remove from catalog</button></span>') + '<span class="note" id="savenote"></span></div>';

    if (isNew) $('#f-title').addEventListener('input', function () { if (!$('#f-id').dataset.touched) $('#f-id').value = slugify($('#f-title').value); });
    $('#f-id').addEventListener('input', function () { $('#f-id').dataset.touched = '1'; });

    var draft = sortedTags(b), created = [];
    var chips = function () { draft.sort(function (x, y) { return cmp(x, y); }); $('#tagchips').innerHTML = draft.map(function (t, i) { return '<span class="chip">' + esc(t) + '<button type="button" data-rm="' + i + '" aria-label="Remove ' + esc(t) + '">×</button></span>'; }).join(''); };
    chips();
    var inp = $('#tagin'), sg = $('#sugg'), opts = [], on = 0;
    var all = function () { return tagNames().concat(created); };
    var add = function (name) {
      name = name.trim(); if (!name) return;
      var hit = all().find(function (t) { return t.toLowerCase() === name.toLowerCase(); });
      if (!hit) { created.push(name); hit = name; toast('New tag “' + name + '” will be added to the tag file when you save.'); }
      if (draft.indexOf(hit) < 0) draft.push(hit);
      inp.value = ''; chips(); render(); inp.focus();
    };
    var render = function () {
      var v = inp.value.trim().toLowerCase();
      if (!v) { sg.hidden = true; inp.setAttribute('aria-expanded', 'false'); return; }
      var m = all().filter(function (t) { return t.toLowerCase().indexOf(v) >= 0 && draft.indexOf(t) < 0; })
        .sort(function (a, c) { return a.toLowerCase().indexOf(v) - c.toLowerCase().indexOf(v) || a.localeCompare(c); }).slice(0, 8);
      var exact = all().some(function (t) { return t.toLowerCase() === v; });
      opts = m.map(function (t) { return {label: t, val: t, n: booksWith(t).length}; });
      if (!exact) opts.push({label: 'Create new tag “' + inp.value.trim() + '”', val: inp.value.trim(), isNew: true});
      on = Math.min(on, opts.length - 1);
      sg.innerHTML = opts.map(function (o, i) { return '<button type="button" data-i="' + i + '" class="' + (o.isNew ? 'new ' : '') + (i === on ? 'on' : '') + '"><span>' + esc(o.label) + '</span>' + (o.isNew ? '' : '<span class="mono">' + o.n + '</span>') + '</button>'; }).join('');
      sg.hidden = false; inp.setAttribute('aria-expanded', 'true');
    };
    inp.addEventListener('input', function () { on = 0; render(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { on = Math.min(on + 1, opts.length - 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { on = Math.max(on - 1, 0); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (!sg.hidden && opts[on]) add(opts[on].val); e.preventDefault(); }
      else if (e.key === 'Backspace' && !inp.value && draft.length) { draft.pop(); chips(); }
      else if (e.key === 'Escape') { sg.hidden = true; }
    });
    sg.addEventListener('mousedown', function (e) { var x = e.target.closest('[data-i]'); if (x) { e.preventDefault(); add(opts[+x.dataset.i].val); } });
    inp.addEventListener('blur', function () { setTimeout(function () { sg.hidden = true; }, 150); });
    $('#tagchips').addEventListener('click', function (e) { var x = e.target.closest('[data-rm]'); if (x) { draft.splice(+x.dataset.rm, 1); chips(); } });
    $('#picker').addEventListener('click', function (e) { if (e.target.id === 'picker') inp.focus(); });

    $('#save').onclick = function () {
      var rec = {};
      ['id', 'author_last', 'author_first', 'title', 'translator', 'original_date', 'foggy_press_date', 'github_dir', 'github_pdf'].forEach(function (k) { rec[k] = $('#f-' + k).value.trim(); });
      rec.id = slugify(rec.id || rec.title);
      rec.tags = draft.slice().sort(function (x, y) { return cmp(x, y); });
      var note = $('#savenote');
      if (!rec.title) { note.innerHTML = '<span class="err">Add a title first.</span>'; return; }
      if (!rec.github_pdf) { note.innerHTML = '<span class="err">Add the GitHub PDF link: the site copies the PDF from there.</span>'; return; }
      var clash = data.books.find(function (x) { return x.id === rec.id && x !== b; });
      if (clash) { note.innerHTML = '<span class="err">“' + esc(rec.id) + '” is already used by ' + esc(clash.title) + '. Change the web address.</span>'; return; }
      var btn = $('#save'); btn.disabled = true; note.textContent = 'Saving…';
      var newTags = created.filter(function (t) { return draft.indexOf(t) >= 0 && tagNames().indexOf(t) < 0; });
      var step = newTags.length ? (function () { newTags.forEach(function (t) { data.tags.push({name: t, level: 3}); }); return saveTags('Add tag' + (newTags.length > 1 ? 's ' : ' ') + newTags.join(', ')); })() : Promise.resolve();
      step.then(function () {
        if (isNew) data.books.push(rec); else Object.assign(b, rec);
        return saveBooks((isNew ? 'Add ' : 'Update ') + rec.title);
      }).then(function () {
        toast(SAVED);
        location.hash = 'book-' + rec.id;
        if (!isNew && location.hash === '#book-' + rec.id) route();
      }).catch(function (e) { btn.disabled = false; note.textContent = ''; failed(e); });
    };
    if (!isNew) $('#del').onclick = function () {
      $('#delwrap').innerHTML = '<span class="note">Remove “' + esc(b.title) + '” from the catalog and the site?</span><button class="star danger" id="delyes" type="button">Yes, remove</button><button class="star" id="delno" type="button">Keep it</button>';
      $('#delno').onclick = function () { route(); };
      $('#delyes').onclick = function () {
        var i = data.books.indexOf(b); data.books.splice(i, 1);
        saveBooks('Remove ' + b.title).then(function () { toast('Removed. ' + SAVED); location.hash = ''; }).catch(function (e) { data.books.splice(i, 0, b); failed(e); });
      };
    };
  }

  function vTags() {
    var ts = data.tags.map(function (t) { var bs = booksWith(t.name), live = bs.filter(isLive); return {t: t, books: bs.length, live: live.length, dl: live.reduce(function (s, b) { return s + dlOf(b); }, 0), vw: live.reduce(function (s, b) { return s + vwOf(b); }, 0)}; });
    var tv = {name: function (r) { return r.t.name; }, books: function (r) { return r.books; }, live: function (r) { return r.live; }, downloads: function (r) { return r.dl; }, views: function (r) { return r.vw; }, level: function (r) { return levelOf(r.t); }}[tagSort.key];
    ts.sort(function (a, b) { return (cmp(tv(a), tv(b)) * tagSort.dir) || cmp(a.t.name, b.t.name); });
    var nf = data.tags.filter(function (t) { return levelOf(t) === 1; }).length;
    $('#app').innerHTML = tabs('tags') +
      '<div class="tools"><input id="nt" type="text" placeholder="New tag name" aria-label="New tag name" style="width:min(16rem,100%)"><button class="btn sm" id="addtag" type="button">Add tag</button><span class="mono count">' + ts.length + ' tags · ' + nf + ' of ' + FEATURED_MAX + ' featured</span></div>' +
      '<div class="tbl-wrap"><table><thead id="thead"><tr>' + th('Tag', 'name', tagSort) + th('Books', 'books', tagSort) + th('Live', 'live', tagSort) + th('PDF downloads', 'downloads', tagSort) + th('Online views', 'views', tagSort) + th('Shows as', 'level', tagSort) + '</tr></thead><tbody>' +
      ts.map(function (r) {
        var t = r.t;
        return '<tr class="go" data-slug="' + slugify(t.name) + '" tabindex="0"><td style="font-weight:500">' + esc(t.name) + '</td><td class="num">' + r.books + '</td><td class="num">' + r.live + '</td><td class="num">' + num(r.dl) + '</td><td class="num">' + num(r.vw) + '</td>' +
          '<td>' + levelPick(t) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    $('#addtag').onclick = function () {
      var v = $('#nt').value.trim(); if (!v) return;
      if (tagNames().some(function (t) { return t.toLowerCase() === v.toLowerCase(); })) { toast('“' + v + '” is already in the tag file.'); return; }
      data.tags.push({name: v, level: 3});
      saveTags('Add tag ' + v).then(function () { toast('Added “' + v + '”. Open it to tag books.'); route(); }).catch(function (e) { data.tags.pop(); failed(e); });
    };
    $('#nt').onkeydown = function (e) { if (e.key === 'Enter') $('#addtag').click(); };
    wireSort($('#thead'), tagSort, vTags);
    wireFeature();
    $('#app').querySelector('tbody').onclick = function (e) { if (e.target.closest('button, select')) return; var r = e.target.closest('tr[data-slug]'); if (r) location.hash = 'tag-' + r.dataset.slug; };
    $('#app').querySelector('tbody').onkeydown = function (e) { var r = e.target.closest('tr[data-slug]'); if (r && e.key === 'Enter' && !e.target.closest('button, select')) location.hash = 'tag-' + r.dataset.slug; };
  }

  function wireFeature() {
    $('#app').querySelectorAll('[data-lvl]').forEach(function (sel) {
      sel.onclick = function (e) { e.stopPropagation(); };
      sel.onchange = function () {
        var t = data.tags.find(function (x) { return x.name === sel.dataset.lvl; }), was = {level: t.level, featured: t.featured}, n = +sel.value;
        if (n === 1 && levelOf(t) !== 1 && data.tags.filter(function (x) { return levelOf(x) === 1; }).length >= FEATURED_MAX) {
          toast('Three collections are already featured. Move one to another level first.'); sel.value = levelOf(t); return;
        }
        t.level = n; delete t.featured; sel.disabled = true;
        saveTags('Show ' + t.name + ' as ' + levelName(n)).then(function () { toast('“' + t.name + '” now shows as ' + levelName(n) + '. ' + SAVED); route(); })
          .catch(function (err) { t.level = was.level; if (was.featured !== undefined) t.featured = was.featured; if (was.level === undefined) delete t.level; sel.disabled = false; sel.value = levelOf(t); failed(err); });
      };
    });
  }

  function vTag(slug) {
    var t = tagBySlug(slug);
    if (!t) { $('#app').innerHTML = tabs('tags') + '<p class="note" style="padding:2rem 0">No such tag. <a href="#tags">Back to the tag file</a></p>'; return; }
    var ov = {title: function (b) { return sortTitle(b.title); }, author: function (b) { return b.author_last + ' ' + b.author_first; }, downloads: function (b) { return dlOf(b); }, views: function (b) { return vwOf(b); }, status: function (b) { return isLive(b) ? 0 : 1; }}[oneTagSort.key];
    var list = booksWith(t.name).sort(function (a, b) { return (cmp(ov(a), ov(b)) * oneTagSort.dir) || cmp(sortTitle(a.title), sortTitle(b.title)); });
    $('#app').innerHTML = tabs('tags') +
      '<div style="padding-top:1.25rem;display:grid;gap:.5rem"><span class="crumb"><a href="#tags">Tag file</a> / ' + esc(t.name) + '</span>' +
      '<div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap"><h1 style="font-size:2rem">' + esc(t.name) + '</h1><label class="mono" style="display:flex;gap:.5rem;align-items:center">Shows as ' + levelPick(t) + '</label></div></div>' +
      '<div class="form" style="padding-top:1rem"><div class="fld"><label for="addbook">Add books to this tag</label><div class="picker" style="padding:.25rem"><input id="addbook" type="text" placeholder="Type a title or author" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="bsugg"><div class="sugg" id="bsugg" hidden></div></div></div>' +
      '<div class="fld"><label for="rn">Rename tag</label><div style="display:flex;gap:.5rem"><input id="rn" type="text" value="' + esc(t.name) + '"><button class="btn ghost sm" id="rename" type="button">Rename</button></div></div></div>' +
      '<div class="tbl-wrap" style="margin-top:1.25rem"><table><thead id="thead"><tr>' + th('Title', 'title', oneTagSort) + th('Author', 'author', oneTagSort) + th('PDF downloads', 'downloads', oneTagSort) + th('Online views', 'views', oneTagSort) + th('Status', 'status', oneTagSort) + '<th></th></tr></thead><tbody>' +
      (list.map(function (b) { return '<tr><td>' + esc(b.title) + '</td><td>' + esc(authorName(b)) + '</td><td class="num">' + num(dlOf(b)) + '</td><td class="num">' + num(vwOf(b)) + '</td><td>' + (isLive(b) ? '<span class="pill">Live</span>' : '<span class="pill warn">Hidden</span>') + '</td><td><button class="star" type="button" data-untag="' + esc(b.id) + '">Remove</button></td></tr>'; }).join('') ||
        '<tr><td colspan="5">No books have this tag yet.</td></tr>') + '</tbody></table></div>' +
      '<div class="saverow"><span class="confirm" id="tdelwrap"><button class="star danger" id="tdel" type="button">Delete tag</button></span></div>';
    wireSort($('#thead'), oneTagSort, function () { vTag(slug); });
    wireFeature();
    var inp = $('#addbook'), sg = $('#bsugg'), opts = [];
    var tagBook = function (b) {
      b.tags = (b.tags || []).concat([t.name]); inp.value = ''; sg.hidden = true;
      saveBooks('Tag ' + b.title + ': ' + t.name).then(function () { toast('Tagged “' + b.title + '”. ' + SAVED); route(); }).catch(function (e) { b.tags.pop(); failed(e); });
    };
    inp.addEventListener('input', function () {
      var v = inp.value.trim().toLowerCase();
      opts = v ? data.books.filter(function (b) { return (b.tags || []).indexOf(t.name) < 0 && (b.title + ' ' + authorName(b)).toLowerCase().indexOf(v) >= 0; }).slice(0, 8) : [];
      sg.innerHTML = opts.map(function (b, i) { return '<button type="button" data-i="' + i + '"><span>' + esc(b.title) + '</span><span class="mono">' + esc(b.author_last) + '</span></button>'; }).join('') || (v ? '<button type="button" disabled>No matching books</button>' : '');
      sg.hidden = !v; inp.setAttribute('aria-expanded', String(!!v));
    });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && opts[0]) { e.preventDefault(); tagBook(opts[0]); } });
    sg.addEventListener('mousedown', function (e) { var x = e.target.closest('[data-i]'); if (x) { e.preventDefault(); tagBook(opts[+x.dataset.i]); } });
    inp.addEventListener('blur', function () { setTimeout(function () { sg.hidden = true; }, 150); });
    $('#app').querySelectorAll('[data-untag]').forEach(function (btn) {
      btn.onclick = function () {
        var b = data.books.find(function (x) { return x.id === btn.dataset.untag; }); var before = b.tags.slice();
        b.tags = b.tags.filter(function (n) { return n !== t.name; });
        saveBooks('Untag ' + b.title + ': ' + t.name).then(function () { toast('Removed “' + b.title + '” from ' + t.name + '. ' + SAVED); route(); }).catch(function (e) { b.tags = before; failed(e); });
      };
    });
    $('#rename').onclick = function () {
      var v = $('#rn').value.trim(); if (!v || v === t.name) return;
      if (tagNames().some(function (n) { return n.toLowerCase() === v.toLowerCase() && n !== t.name; })) { toast('There is already a tag called “' + v + '”.'); return; }
      var old = t.name; t.name = v;
      data.books.forEach(function (b) { b.tags = (b.tags || []).map(function (n) { return n === old ? v : n; }); });
      saveTags('Rename tag ' + old + ' to ' + v).then(function () { return saveBooks('Rename tag ' + old + ' to ' + v); })
        .then(function () { toast('Renamed. ' + SAVED); location.hash = 'tag-' + slugify(v); }).catch(function (e) { failed(e); loadData().then(route); });
    };
    $('#tdel').onclick = function () {
      $('#tdelwrap').innerHTML = '<span class="note">Delete “' + esc(t.name) + '” and take it off ' + list.length + ' book' + (list.length === 1 ? '' : 's') + '?</span><button class="star danger" id="tyes" type="button">Yes, delete</button><button class="star" id="tno" type="button">Keep it</button>';
      $('#tno').onclick = function () { route(); };
      $('#tyes').onclick = function () {
        data.tags = data.tags.filter(function (x) { return x !== t; });
        data.books.forEach(function (b) { b.tags = (b.tags || []).filter(function (n) { return n !== t.name; }); });
        (list.length ? saveBooks('Delete tag ' + t.name) : Promise.resolve()).then(function () { return saveTags('Delete tag ' + t.name); })
          .then(function () { toast('Deleted. ' + SAVED); location.hash = 'tags'; }).catch(function (e) { failed(e); loadData().then(route); });
      };
    };
  }

  // ---- Reports: admin/report.json, gathered at build time by build/report.py (GoatCounter, Cloudflare)
  var report = null;
  function vReports() {
    $('#app').innerHTML = tabs('reports') + '<p class="note" style="padding:2rem 0">Loading the reports…</p>';
    (report ? Promise.resolve(report) : fetch('report.json', {cache: 'no-store'}).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }))
      .then(function (r) { report = r; drawReports(r); })
      .catch(function () { $('#app').innerHTML = tabs('reports') + '<p class="note" style="padding:2rem 0">No report yet. It is made by the next site build (nightly, or after any change).</p>'; });
  }
  function fmtDay(d) { var x = new Date(d + 'T12:00:00Z'); return isNaN(x) ? d : x.toLocaleDateString(undefined, {month: 'short', day: 'numeric', timeZone: 'UTC'}); }
  function ranked(title, rows, opts) {
    opts = opts || {};
    rows = (rows || []).filter(function (r) { return r[1] > 0; }).slice(0, opts.max || 10);
    var top = rows.reduce(function (m, r) { return Math.max(m, r[1]); }, 0) || 1;
    return '<section class="rp-card' + (opts.wide ? ' wide' : '') + '"><h2>' + esc(title) + (opts.note ? help(opts.note) : '') + '</h2>' +
      (rows.length ? '<table class="rk"><tbody>' + rows.map(function (r) {
        return '<tr><td class="rk-n" title="' + esc(r[0]) + '">' + esc(opts.label ? opts.label(r[0]) : r[0]) + '</td><td class="rk-b"><span style="width:' + Math.max(2, Math.round(r[1] / top * 100)) + '%"></span></td><td class="num">' + num(r[1]) + '</td></tr>';
      }).join('') + '</tbody></table>' : '<p class="note">Nothing yet.</p>') + '</section>';
  }
  function daily(rows) {
    if (!rows || !rows.length) return '';
    var W = 720, H = 170, pad = 22, top0 = 10, n = rows.length, max = rows.reduce(function (m, r) { return Math.max(m, r[1]); }, 0) || 1;
    var step = (W - pad) / n, bw = Math.max(2, step - 2);
    var nice = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / nice) * nice;
    var bars = rows.map(function (r, i) {
      var h = Math.max(r[1] ? 2 : 0, (H - pad - top0) * r[1] / top), x = pad + i * step + 1, y = H - pad - h;
      return '<g class="dbar" data-i="' + i + '"><rect class="hit" x="' + (pad + i * step) + '" y="0" width="' + step + '" height="' + (H - pad) + '"/>' +
        (h ? '<path class="bar" d="M' + x + ',' + (H - pad) + 'V' + (y + Math.min(4, h)) + 'Q' + x + ',' + y + ' ' + (x + Math.min(4, bw / 2)) + ',' + y + 'H' + (x + bw - Math.min(4, bw / 2)) + 'Q' + (x + bw) + ',' + y + ' ' + (x + bw) + ',' + (y + Math.min(4, h)) + 'V' + (H - pad) + 'Z"/>' : '') + '</g>';
    }).join('');
    var grid = [0, .5, 1].map(function (f) { var y = H - pad - (H - pad - top0) * f; return '<line class="grid" x1="' + pad + '" x2="' + W + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (pad - 4) + '" y="' + (y + 3) + '" text-anchor="end">' + num(Math.round(top * f)) + '</text>'; }).join('');
    var ticks = [0, Math.floor(n / 2), n - 1].map(function (i) { return '<text class="ax" x="' + (i === 0 ? pad : i === n - 1 ? W : pad + i * step + step / 2) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + esc(fmtDay(rows[i][0])) + '</text>'; }).join('');
    return '<section class="rp-card wide"><h2>Visitors per day</h2><div class="dchart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Visitors per day, last ' + n + ' days">' + grid + bars + ticks + '</svg><div class="tip" hidden></div></div>' +
      '<details class="rp-tbl"><summary class="mono">Show as a table</summary><table><tbody>' + rows.map(function (r) { return '<tr><td>' + esc(fmtDay(r[0])) + '</td><td class="num">' + num(r[1]) + '</td></tr>'; }).join('') + '</tbody></table></details></section>';
  }
  function drawReports(r) {
    var g = r.goatcounter, c = r.cloudflare, f = {};
    ((g && g.features) || []).forEach(function (x) { f[x[0]] = x[1]; });
    var tile = function (label, v, sub) { return '<div class="rp-tile"><span class="mono">' + esc(label) + '</span><b>' + (v == null ? '–' : typeof v === 'string' ? esc(v) : num(v)) + '</b>' + (sub ? '<span class="note">' + sub + '</span>' : '') + '</div>'; };
    var h = tabs('reports') + '<div class="rp-head"><p class="note">' + (g ? 'Last 30 days (' + esc(fmtDay(g.start)) + ' to ' + esc(fmtDay(g.end)) + '). ' : '') + 'Updated with each site build, last ' + esc((r.built || '').replace('T', ' ')) + ' UTC.' + help('Counts come from GoatCounter, which leaves out known bots.') + '</p></div>';
    if (r.missing && r.missing.length) h += '<div class="banner"><b>Not included this time</b><ul>' + r.missing.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>';
    if (g) {
      h += '<div class="rp-tiles">' + tile('Visitors', g.visitors) + tile('Read-online views', f['Read-online page views']) + tile('PDF downloads', f['PDF downloads']) + tile('EPUB downloads', f['EPUB downloads']) + tile('Searches', f['Searches'] || 0, f['Searches that found nothing'] ? num(f['Searches that found nothing']) + ' found nothing' : '') + '</div>';
      h += daily(g.daily);
      h += '<div class="rp-grid">' +
        ranked('Where visitors come from', g.toprefs, {note: '“(none)” is people who typed the address or used a bookmark.', label: function (s) { return s === '' ? '(none)' : s; }}) +
        ranked('Feature use', g.features, {max: 14}) +
        ranked('Top searches', g.searches, {max: 15}) +
        ranked('Searches that found nothing', g.searches_none, {max: 15, note: 'Books people looked for and we don’t have.'}) +
        ranked('Countries', g.locations) + ranked('Browsers', g.browsers) + ranked('Systems', g.systems) + ranked('Screen sizes', g.sizes) +
        ranked('Most visited pages', g.pages, {max: 20, wide: true}) + '</div>';
    }
    var a = r.accounts;
    if (a) {
      var titleOf = function (id) { var b = data.books.find(function (x) { return x.id === id; }); return b ? b.title : id; };
      h += '<h2 class="rp-sec">Reader accounts</h2><div class="rp-tiles">' + tile('Accounts', a.accounts) + tile('New in 7 days', a.new_7d) + tile('Active in 30 days', a.active_30d) + tile('Saved books', a.favorites) + tile('Reading lists', a.lists, num(a.list_items) + ' books on lists') + '</div>' +
        '<div class="rp-grid">' + ranked('Most-saved books', (a.top_saved || []).map(function (x) { return [titleOf(x[0]), x[1]]; }), {max: 20, note: 'Totals only: who saved what is never shown here.'}) + '</div>';
      if (a.requests_waiting != null) {
        h += '<h2 class="rp-sec">Book requests' + help('Readers ask on /request/. Each night the books repository picks up new requests, builds the ones it can from approved sources, and emails the reader. The list itself is in foggy-press-files, requests/queue.json.') + '</h2><div class="rp-tiles">' + tile('Waiting or being built', a.requests_waiting) + tile('Published', a.requests_published) + tile('Not possible', a.requests_declined) + '</div>';
      }
      if (a.ask_cap != null) {
        var cost = Number(a.ask_cost_month || 0), cap = Number(a.ask_cap || 0);
        h += '<h2 class="rp-sec">Ask Foggy Press' + help('Change the daily limit or the monthly cap in Supabase: Table Editor → ask_config. Questions and answers are never shown here.') + '</h2><div class="rp-tiles">' + tile('Questions in 30 days', a.ask_30d) + tile('People asking, 30 days', a.ask_askers_30d) +
          tile('Spent this month', '$' + cost.toFixed(2), 'of the $' + cap.toFixed(2) + ' monthly cap' + (cap && cost >= cap ? ': Ask is paused' : '')) + tile('Saved chats', a.chats) + '</div>';
      }
    }
    h += '<div class="rp-grid">';
    if (c) {
      var tot = (c.people + c.bots) || 1;
      h += '<section class="rp-card"><h2>files.foggypress.com requests: people and bots' + help('Bots are requests whose browser name says crawler, bot, script and the like.</span><span>Bots may read the read-online pages here, but PDF and EPUB downloads refuse them (Cloudflare rule from build/cloudflare_rules.py).') + '</h2><p class="note">' + esc(c.host) + ', last 7 days, from Cloudflare.</p>' +
        '<div class="split"><span style="width:' + Math.round(c.people / tot * 100) + '%"></span></div>' +
        '<table class="rk"><tbody><tr><td class="rk-n">People</td><td class="num">' + num(c.people) + ' (' + Math.round(c.people / tot * 100) + '%)</td></tr><tr><td class="rk-n">Bots</td><td class="num">' + num(c.bots) + ' (' + Math.round(c.bots / tot * 100) + '%)</td></tr>' +
        (c.blocked != null ? '<tr><td class="rk-n">Bot requests refused</td><td class="num">' + num(c.blocked) + '</td></tr>' : '') + '</tbody></table></section>' +
        ranked('Busiest bots', c.bot_agents) + ranked('People’s countries (downloads)', c.countries);
    } else {
      h += '<section class="rp-card"><h2>PDF and EPUB requests: people and bots' + help('Pages on GitHub keep no visit logs, so bots can only be counted for the PDFs and EPUBs, which Cloudflare serves. To turn this on: in Cloudflare, My Profile → API Tokens → Create token → “Read analytics and logs” template, limited to the foggypress.com zone. Add it to the foggypress-site repository as the secret <span class="mono">CLOUDFLARE_API_TOKEN</span>, and the zone ID (on the foggypress.com Overview page) as <span class="mono">CLOUDFLARE_ZONE_ID</span>.', 'How to connect it') + '</h2><p class="note">Not connected yet.</p></section>';
    }
    h += '</div>';
    $('#app').innerHTML = h;
    var chart = $('#app').querySelector('.dchart');
    if (chart && g) {
      var tip = chart.querySelector('.tip');
      chart.addEventListener('mousemove', function (e) {
        var b = e.target.closest('.dbar'); if (!b) { tip.hidden = true; return; }
        var d = g.daily[+b.dataset.i], box = chart.getBoundingClientRect();
        tip.innerHTML = '<span class="mono">' + esc(fmtDay(d[0])) + '</span><b>' + num(d[1]) + '</b> visitors';
        tip.hidden = false;
        tip.style.left = Math.min(box.width - tip.offsetWidth, Math.max(0, e.clientX - box.left - tip.offsetWidth / 2)) + 'px';
        chart.querySelectorAll('.dbar.on').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on');
      });
      chart.addEventListener('mouseleave', function () { tip.hidden = true; chart.querySelectorAll('.dbar.on').forEach(function (x) { x.classList.remove('on'); }); });
    }
  }

  // ---- Chat: Ask Foggy Press usage and the answers readers rated, live from the ask function ----
  // The function checks that this admin token belongs to the site's owner on GitHub before it answers.
  var chatData = null, chatFilter = 'down';
  function vChat(reload) {
    $('#app').innerHTML = tabs('chat') + '<p class="note" style="padding:2rem 0">Loading chat figures…</p>';
    if (!stats.ask) { $('#app').innerHTML = tabs('chat') + '<p class="note" style="padding:2rem 0">Ask Foggy Press isn’t turned on in this build (repository variable ASK_ON).</p>'; return; }
    (chatData && !reload ? Promise.resolve(chatData) : fetch(stats.ask, {method: 'POST', headers: {'Content-Type': 'application/json', 'apikey': stats.ask_key}, body: JSON.stringify({op: 'admin', gh: token})})
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || r.status); e.status = r.status; throw e; } return j; }); }))
      .then(function (d) { chatData = d; drawChat(d); })
      .catch(function (e) {
        $('#app').innerHTML = tabs('chat') + '<p class="note" style="padding:2rem 0">' + (e.status === 403 ? 'The ask function didn’t accept this sign-in. It only answers for the GitHub account wmclemens.' :
          'Couldn’t load the chat figures (' + esc(e.message) + '). If this is the first time, run the latest supabase/schema.sql in Supabase’s SQL editor.') + '</p>';
      });
  }
  function drawChat(d) {
    var t = d.totals_30d || {}, rt = d.ratings || {}, cfg = d.config || {}, cost = Number(d.month_cost || 0), cap = Number(cfg.monthly_cap_usd || 0);
    var tile = function (label, v, sub) { return '<div class="rp-tile"><span class="mono">' + esc(label) + '</span><b>' + (v == null ? '–' : typeof v === 'string' ? esc(v) : num(v)) + '</b>' + (sub ? '<span class="note">' + sub + '</span>' : '') + '</div>'; };
    var rated = (rt.up_30d || 0) + (rt.down_30d || 0);
    var titleOf = function (id) { if (id.indexOf('eb:') === 0) return 'Britannica: ' + id.slice(3); var b = data.books.find(function (x) { return x.id === id; }); return b ? b.title : id; };
    var h = tabs('chat') + '<div class="rp-head"><p class="note">Live from the database, ' + esc(new Date(d.built).toLocaleString()) + '. Last 30 days unless it says otherwise. <button type="button" class="linkish" id="chat-reload">Refresh</button></p></div>' +
      (!cfg.enabled ? '<div class="banner"><b>Ask is turned off</b> (ask_config.enabled in Supabase).</div>' : cap && cost >= cap ? '<div class="banner"><b>Ask is paused</b>: this month’s spending reached the cap.</div>' : '') +
      '<div class="rp-tiles">' + tile('Questions', t.questions, num(t.members) + ' signed in · ' + num(t.guests) + ' guests') +
      tile('People asking', (t.askers || 0) + (t.guest_askers || 0), num(t.askers) + ' accounts · ' + num(t.guest_askers) + ' guest addresses') +
      tile('Spent this month', '$' + cost.toFixed(2), 'of the $' + cap.toFixed(2) + ' cap' + (t.questions ? ' · about ' + (Number(t.cost) / t.questions * 100).toFixed(2) + '¢ a question' : '')) +
      tile('Thumbs up', rt.up_30d || 0, rated ? Math.round((rt.up_30d || 0) / rated * 100) + '% of rated answers' : '') +
      tile('Thumbs down', rt.down_30d || 0, (rt.answers_30d ? Math.round(rated / rt.answers_30d * 100) + '% of ' + num(rt.answers_30d) + ' answers were rated' : '')) + '</div>';
    // questions per day, signed in and guests stacked
    var days = d.days || [], W = 720, H = 170, pad = 22, top0 = 10, n = days.length || 1;
    var max = days.reduce(function (m, r) { return Math.max(m, r.members + r.guests); }, 0) || 1, nice = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / nice) * nice;
    var step = (W - pad) / n, bw = Math.max(2, step - 2), y = function (v) { return (H - pad - top0) * v / top; };
    var bars = days.map(function (r, i) {
      var x = pad + i * step + 1, hm = y(r.members), hg = y(r.guests);
      return '<g class="dbar" data-i="' + i + '"><rect class="hit" x="' + (pad + i * step) + '" y="0" width="' + step + '" height="' + (H - pad) + '"/>' +
        (hm ? '<rect class="bar" x="' + x + '" y="' + (H - pad - hm) + '" width="' + bw + '" height="' + hm + '"/>' : '') +
        (hg ? '<rect class="bar2" x="' + x + '" y="' + (H - pad - hm - hg) + '" width="' + bw + '" height="' + hg + '"/>' : '') + '</g>';
    }).join('');
    var grid = [0, .5, 1].map(function (f) { var yy = H - pad - (H - pad - top0) * f; return '<line class="grid" x1="' + pad + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '"/><text class="ax" x="' + (pad - 4) + '" y="' + (yy + 3) + '" text-anchor="end">' + num(Math.round(top * f)) + '</text>'; }).join('');
    var ticks = days.length ? [0, Math.floor(n / 2), n - 1].map(function (i) { return '<text class="ax" x="' + (i === 0 ? pad : i === n - 1 ? W : pad + i * step + step / 2) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + esc(fmtDay(days[i].day)) + '</text>'; }).join('') : '';
    h += '<section class="rp-card wide"><h2>Questions per day</h2><p class="note"><span class="key k1"></span>Signed in <span class="key k2"></span>Guests</p><div class="dchart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Questions per day, last 30 days">' + grid + bars + ticks + '</svg><div class="tip" hidden></div></div>' +
      '<details class="rp-tbl"><summary class="mono">Show as a table</summary><table><thead><tr><th>Day</th><th class="num">Signed in</th><th class="num">Guests</th><th class="num">Cost</th><th class="num">👍</th><th class="num">👎</th></tr></thead><tbody>' +
      days.map(function (r) { return '<tr><td>' + esc(fmtDay(r.day)) + '</td><td class="num">' + num(r.members) + '</td><td class="num">' + num(r.guests) + '</td><td class="num">$' + Number(r.cost).toFixed(3) + '</td><td class="num">' + num(r.up) + '</td><td class="num">' + num(r.down) + '</td></tr>'; }).join('') +
      '</tbody></table></details></section>';
    var PL = {home: 'Home page', ask: 'Ask page', book: 'A book’s read page', article: 'A Britannica article'};
    h += '<div class="rp-grid">' + ranked('Where people ask', Object.keys(d.places || {}).map(function (k) { return [PL[k] || k, d.places[k]]; }).sort(function (a, b) { return b[1] - a[1]; })) +
      ranked('Books and articles asked about', (d.books || []).map(function (x) { return [titleOf(x[0]), x[1]]; }), {max: 15, note: 'Chats started from a book or article page.'}) +
      '<section class="rp-card"><h2>Limits' + help('Change these in Supabase: Table Editor → ask_config. A guest limit of 0 means only signed-in readers can ask.') + '</h2><table class="rk"><tbody>' +
      '<tr><td class="rk-n">Questions a day, signed in</td><td class="num">' + num(cfg.daily_limit) + '</td></tr>' +
      '<tr><td class="rk-n">Questions a day, guest</td><td class="num">' + (cfg.guest_daily_limit == null ? '–' : num(cfg.guest_daily_limit)) + '</td></tr>' +
      '<tr><td class="rk-n">All guests together, a day</td><td class="num">' + (cfg.guests_daily_cap == null ? '–' : num(cfg.guests_daily_cap)) + '</td></tr>' +
      '<tr><td class="rk-n">Monthly spending cap</td><td class="num">$' + cap.toFixed(2) + '</td></tr></tbody></table></section></div>';
    // the rated answers
    var all = d.rated || [], list = all.filter(function (r) { return chatFilter === 'all' || (chatFilter === 'down' ? r.rating < 0 : r.rating > 0); });
    h += '<h2 class="rp-sec">Rated answers' + help('The question and the answer, never who asked. The latest 200.') + '</h2><div class="rp-head" style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap"><div class="seg" role="group" aria-label="Show">' +
      [['down', 'Thumbs down (' + all.filter(function (r) { return r.rating < 0; }).length + ')'], ['up', 'Thumbs up (' + all.filter(function (r) { return r.rating > 0; }).length + ')'], ['all', 'All']].map(function (o) {
        return '<button type="button" data-cf="' + o[0] + '" aria-pressed="' + (chatFilter === o[0]) + '">' + esc(o[1]) + '</button>';
      }).join('') + '</div></div>' +
      (list.length ? '<div class="rated">' + list.map(function (r) {
        return '<details class="rated-i"><summary><span class="rv ' + (r.rating > 0 ? 'up' : 'down') + '">' + (r.rating > 0 ? '👍' : '👎') + '</span><span class="rq">' + esc(r.question || '(question not found)') + '</span>' +
          '<span class="mono rd">' + esc(new Date(r.rated_at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})) + (r.guest ? ' · guest' : '') + (r.book_id ? ' · ' + esc(titleOf(r.book_id)) : '') + '</span></summary>' +
          (r.note ? '<p class="rnote"><b>What was wrong:</b> ' + esc(r.note) + '</p>' : '') + '<div class="rans">' + esc(r.answer).replace(/\[\[(\w+) ([^\]]+)\]\]/g, '<span class="mono">[$1 $2]</span>') + '</div></details>';
      }).join('') + '</div>' : '<p class="note" style="padding:1rem 0">No ' + (chatFilter === 'all' ? '' : chatFilter === 'down' ? 'thumbs-down ' : 'thumbs-up ') + 'answers yet.</p>');
    $('#app').innerHTML = h;
    $('#chat-reload').onclick = function () { vChat(true); };
    $('#app').querySelectorAll('[data-cf]').forEach(function (b) { b.onclick = function () { chatFilter = b.dataset.cf; drawChat(d); }; });
    var chart = $('#app').querySelector('.dchart');
    if (chart) {
      var tip = chart.querySelector('.tip');
      chart.addEventListener('mousemove', function (e) {
        var b = e.target.closest('.dbar'); if (!b) { tip.hidden = true; return; }
        var r = days[+b.dataset.i], box = chart.getBoundingClientRect();
        tip.innerHTML = '<span class="mono">' + esc(fmtDay(r.day)) + '</span><b>' + num(r.members + r.guests) + '</b> questions (' + num(r.guests) + ' guests) · $' + Number(r.cost).toFixed(3);
        tip.hidden = false;
        tip.style.left = Math.min(box.width - tip.offsetWidth, Math.max(0, e.clientX - box.left - tip.offsetWidth / 2)) + 'px';
      });
      chart.addEventListener('mouseleave', function () { tip.hidden = true; });
    }
  }

  function route() {
    if (!data.books) return;
    var h = decodeURIComponent(location.hash.slice(1));
    if (h === 'reports') vReports();
    else if (h === 'chat') vChat();
    else if (h === 'tags') vTags();
    else if (h.indexOf('tag-') === 0) vTag(h.slice(4));
    else if (h === 'new') vEdit(null);
    else if (h.indexOf('book-') === 0) vEdit(h.slice(5));
    else vCatalog();
    scrollTo(0, 0);
  }

  function start(fresh) {
    $('#app').innerHTML = '<p class="note" style="padding:2rem 0">Loading the catalog…</p>';
    gh('/repos/' + REPO).then(function (r) {
      if (!r.permissions || !r.permissions.push) throw Object.assign(new Error('This token can read ' + REPO + ' but not write to it. Give it Contents: Read and write.'), {status: 403});
      return gh('/user').catch(function () { return {}; });
    }).then(function (u) {
      user = u.login || 'token';
      if (fresh) setToken(token);
      $('#who').textContent = 'Signed in as ' + user; $('#who').hidden = false; $('#signout').hidden = false;
      return Promise.all([loadData(), loadStats()]);
    }).then(route).catch(function (e) {
      // only a refused token signs you out; anything else (a network blip, a page mid-update) keeps you signed in
      if (e.status === 401 || e.status === 403 || fresh) {
        setToken(null); token = null;
        vSignIn(e.status === 401 ? 'GitHub didn’t accept that token. Check it was copied in full and hasn’t expired.' : e.message);
      } else {
        $('#app').innerHTML = '<p class="note err" style="padding:2rem 0">Couldn’t load the catalog just now (' + esc(e.message || 'network error') + '). You’re still signed in. <button class="btn sm ghost" type="button" id="retry">Try again</button></p>';
        $('#retry').onclick = function () { start(false); };
      }
    });
  }

  $('#signout').onclick = function () { setToken(null); token = null; data.books = null; $('#who').hidden = true; $('#signout').hidden = true; vSignIn(); };
  addEventListener('hashchange', route);
  token = getToken();
  if (token) start(false); else vSignIn();
})();
