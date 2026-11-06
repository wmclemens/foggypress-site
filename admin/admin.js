// Foggy Press admin. Reads and writes catalog/books.json and catalog/tags.json in the site repo
// through the GitHub API, using a fine-grained token kept in this browser only.
(function () {
  'use strict';
  var REPO = 'wmclemens/foggypress-site';
  var BRANCH = 'main';
  var BOOKS = 'catalog/books.json', TAGS = 'catalog/tags.json';
  var FEATURED_MAX = 3;
  var KEY = 'fp-admin-token';

  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); };
  var slugify = function (s) { return s.toLowerCase().replace(/&/g, 'and').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); };
  var sortTitle = function (t) { return t.replace(/^(The|A|An) /, ''); };
  var authorName = function (b) { return (b.author_first + ' ' + b.author_last).trim(); };
  var num = function (n) { return n == null ? '' : Number(n).toLocaleString('en-US'); };

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
    return gh('/repos/' + REPO + '/contents/' + path + '?ref=' + BRANCH).then(function (j) { return {json: JSON.parse(b64decode(j.content)), sha: j.sha}; });
  }
  function writeFile(path, obj, sha, message) {
    return gh('/repos/' + REPO + '/contents/' + path, {method: 'PUT', body: {message: message, content: b64encode(JSON.stringify(obj, null, 2) + '\n'), sha: sha, branch: BRANCH}})
      .then(function (j) { return j.content.sha; });
  }
  function sortBooks() { data.books.sort(function (a, b) { return (a.author_last + a.author_first + sortTitle(a.title)).localeCompare(b.author_last + b.author_first + sortTitle(b.title)); }); }
  function saveBooks(message) {
    sortBooks();
    return writeFile(BOOKS, data.books, data.booksSha, message).then(function (sha) { data.booksSha = sha; });
  }
  function saveTags(message) {
    data.tags.sort(function (a, b) { return a.name.localeCompare(b.name); });
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
    return fetch('/admin/stats.json', {cache: 'no-store'}).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) { if (s) stats = s; }).catch(function () {});
  }

  // ---- helpers over data ----
  var tagNames = function () { return data.tags.map(function (t) { return t.name; }); };
  var tagBySlug = function (s) { return data.tags.find(function (t) { return slugify(t.name) === s; }); };
  var booksWith = function (name) { return data.books.filter(function (b) { return (b.tags || []).indexOf(name) >= 0; }); };
  var st = function (b) { return stats.books[b.id] || {}; };
  var isLive = function (b) { var s = st(b); return s.live != null ? s.live : !!b.foggy_press_date; };
  var dlOf = function (b) { return st(b).downloads || 0; };

  // ---- views ----
  function tabs(cur) {
    return '<div class="tabs"><a href="#" ' + (cur === 'books' ? 'aria-current="page"' : '') + '>Book catalog</a><a href="#tags" ' + (cur === 'tags' ? 'aria-current="page"' : '') + '>Tag file</a></div>';
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
      '<div class="tbl-wrap"><table><thead><tr><th>Author last</th><th>Author first</th><th>Title</th><th>Original</th><th>Foggy Press</th><th>Downloads</th><th>Pages</th><th>Tags</th></tr></thead><tbody id="rows"></tbody></table></div>' +
      (stats.built ? '<p class="note" style="margin-top:.75rem">Pages and downloads as of the last site build, ' + esc(stats.built.replace('T', ' ')) + ' UTC.</p>' : '');
    var draw = function () {
      var s = q.trim().toLowerCase();
      var list = data.books.filter(function (b) { return !s || [b.author_last, b.author_first, b.title, b.translator].concat(b.tags || []).join(' ').toLowerCase().indexOf(s) >= 0; });
      $('#count').textContent = list.length + ' of ' + data.books.length + ' records · ' + data.books.filter(isLive).length + ' live';
      $('#rows').innerHTML = list.map(function (b) {
        return '<tr class="go" data-id="' + esc(b.id) + '" tabindex="0"><td>' + esc(b.author_last) + '</td><td>' + esc(b.author_first) + '</td><td>' + esc(b.title) + '</td><td class="num">' + esc(b.original_date) + '</td>' +
          '<td class="num">' + (b.foggy_press_date ? esc(b.foggy_press_date) : '<span class="pill warn">Hidden</span>') + '</td><td class="num">' + num(dlOf(b)) + '</td><td class="num">' + num(st(b).pages) + '</td>' +
          '<td><div class="chips">' + (b.tags || []).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') + '</div></td></tr>';
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
      (isNew ? '' : '<span class="mono" style="color:var(--muted)">' + (isLive(b) ? '<span class="pill">Live</span>' : '<span class="pill warn">Not live</span>') + ' · ' + num(s.pages) + ' pages · ' + num(dlOf(b)) + ' downloads</span>') + '</div>' +
      '<div class="form">' +
      f('author_last', 'Author last name') + f('author_first', 'Author first name') +
      f('title', 'Title', 'text', '', true) +
      f('translator', 'Translator', 'text', 'Optional') + f('original_date', 'Original publish date', 'text', 'Free text: 1851, 1868–69, c. 375 BC') +
      f('foggy_press_date', 'Foggy Press publish date', 'date', 'Leave empty to keep the book off the site') +
      f('id', 'Web address', 'text', isNew ? 'Used in links: /pdf/<id>.pdf. Filled from the title.' : 'Changing this breaks old links and resets the book’s download count.') +
      f('github_dir', 'GitHub directory link', 'url', '', true) +
      f('github_pdf', 'GitHub PDF link', 'url', 'Admin only. Visitors get the site’s own copy of this PDF.', true) +
      '<div class="fld full"><label for="tagin">Tags</label><div class="picker" id="picker"><span class="chips" id="tagchips"></span>' +
      '<input id="tagin" type="text" placeholder="Type to add a tag" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="sugg"><div class="sugg" id="sugg" hidden></div></div>' +
      '<span class="hint">Checked against the tag file as you type. “Create new tag” adds it to the tag file when you save.</span></div>' +
      '</div>' +
      '<div class="saverow"><button class="btn" id="save" type="button">' + (isNew ? 'Add to catalog' : 'Save record') + '</button><a class="btn ghost" href="#">Cancel</a>' +
      (isNew ? '' : '<span class="confirm" id="delwrap"><button class="star danger" id="del" type="button">Remove from catalog</button></span>') + '<span class="note" id="savenote"></span></div>';

    if (isNew) $('#f-title').addEventListener('input', function () { if (!$('#f-id').dataset.touched) $('#f-id').value = slugify($('#f-title').value); });
    $('#f-id').addEventListener('input', function () { $('#f-id').dataset.touched = '1'; });

    var draft = (b.tags || []).slice(), created = [];
    var chips = function () { $('#tagchips').innerHTML = draft.map(function (t, i) { return '<span class="chip">' + esc(t) + '<button type="button" data-rm="' + i + '" aria-label="Remove ' + esc(t) + '">×</button></span>'; }).join(''); };
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
      rec.tags = draft.slice();
      var note = $('#savenote');
      if (!rec.title) { note.innerHTML = '<span class="err">Add a title first.</span>'; return; }
      if (!rec.github_pdf) { note.innerHTML = '<span class="err">Add the GitHub PDF link: the site copies the PDF from there.</span>'; return; }
      var clash = data.books.find(function (x) { return x.id === rec.id && x !== b; });
      if (clash) { note.innerHTML = '<span class="err">“' + esc(rec.id) + '” is already used by ' + esc(clash.title) + '. Change the web address.</span>'; return; }
      var btn = $('#save'); btn.disabled = true; note.textContent = 'Saving…';
      var newTags = created.filter(function (t) { return draft.indexOf(t) >= 0 && tagNames().indexOf(t) < 0; });
      var step = newTags.length ? (function () { newTags.forEach(function (t) { data.tags.push({name: t, featured: false}); }); return saveTags('Add tag' + (newTags.length > 1 ? 's ' : ' ') + newTags.join(', ')); })() : Promise.resolve();
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
    var ts = data.tags.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var nf = ts.filter(function (t) { return t.featured; }).length;
    $('#app').innerHTML = tabs('tags') +
      '<div class="tools"><input id="nt" type="text" placeholder="New tag name" aria-label="New tag name" style="width:min(16rem,100%)"><button class="btn sm" id="addtag" type="button">Add tag</button><span class="mono count">' + ts.length + ' tags · ' + nf + ' of ' + FEATURED_MAX + ' featured</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Tag</th><th>Books</th><th>Live</th><th>Downloads</th><th>Featured on home page</th></tr></thead><tbody>' +
      ts.map(function (t) {
        var bs = booksWith(t.name), live = bs.filter(isLive);
        return '<tr class="go" data-slug="' + slugify(t.name) + '" tabindex="0"><td style="font-weight:500">' + esc(t.name) + '</td><td class="num">' + bs.length + '</td><td class="num">' + live.length + '</td><td class="num">' + num(live.reduce(function (s, b) { return s + dlOf(b); }, 0)) + '</td>' +
          '<td><button class="star" type="button" data-feat="' + esc(t.name) + '" aria-pressed="' + !!t.featured + '">' + (t.featured ? '★ Featured' : '☆ Feature') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>';
    $('#addtag').onclick = function () {
      var v = $('#nt').value.trim(); if (!v) return;
      if (tagNames().some(function (t) { return t.toLowerCase() === v.toLowerCase(); })) { toast('“' + v + '” is already in the tag file.'); return; }
      data.tags.push({name: v, featured: false});
      saveTags('Add tag ' + v).then(function () { toast('Added “' + v + '”. Open it to tag books.'); route(); }).catch(function (e) { data.tags.pop(); failed(e); });
    };
    $('#nt').onkeydown = function (e) { if (e.key === 'Enter') $('#addtag').click(); };
    wireFeature();
    $('#app').querySelector('tbody').onclick = function (e) { if (e.target.closest('button')) return; var r = e.target.closest('tr[data-slug]'); if (r) location.hash = 'tag-' + r.dataset.slug; };
    $('#app').querySelector('tbody').onkeydown = function (e) { var r = e.target.closest('tr[data-slug]'); if (r && e.key === 'Enter' && !e.target.closest('button')) location.hash = 'tag-' + r.dataset.slug; };
  }

  function wireFeature() {
    $('#app').querySelectorAll('[data-feat]').forEach(function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var t = data.tags.find(function (x) { return x.name === btn.dataset.feat; });
        if (!t.featured && data.tags.filter(function (x) { return x.featured; }).length >= FEATURED_MAX) { toast('Three collections are already featured. Unfeature one first.'); return; }
        t.featured = !t.featured; btn.disabled = true;
        saveTags((t.featured ? 'Feature ' : 'Unfeature ') + t.name).then(function () { toast((t.featured ? '“' + t.name + '” is now featured. ' : '“' + t.name + '” is no longer featured. ') + SAVED); route(); })
          .catch(function (err) { t.featured = !t.featured; btn.disabled = false; failed(err); });
      };
    });
  }

  function vTag(slug) {
    var t = tagBySlug(slug);
    if (!t) { $('#app').innerHTML = tabs('tags') + '<p class="note" style="padding:2rem 0">No such tag. <a href="#tags">Back to the tag file</a></p>'; return; }
    var list = booksWith(t.name).sort(function (a, b) { return sortTitle(a.title).localeCompare(sortTitle(b.title)); });
    $('#app').innerHTML = tabs('tags') +
      '<div style="padding-top:1.25rem;display:grid;gap:.5rem"><span class="crumb"><a href="#tags">Tag file</a> / ' + esc(t.name) + '</span>' +
      '<div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap"><h1 style="font-size:2rem">' + esc(t.name) + '</h1><button class="star" type="button" data-feat="' + esc(t.name) + '" aria-pressed="' + !!t.featured + '">' + (t.featured ? '★ Featured' : '☆ Feature') + '</button></div></div>' +
      '<div class="form" style="padding-top:1rem"><div class="fld"><label for="addbook">Add books to this tag</label><div class="picker" style="padding:.25rem"><input id="addbook" type="text" placeholder="Type a title or author" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="bsugg"><div class="sugg" id="bsugg" hidden></div></div></div>' +
      '<div class="fld"><label for="rn">Rename tag</label><div style="display:flex;gap:.5rem"><input id="rn" type="text" value="' + esc(t.name) + '"><button class="btn ghost sm" id="rename" type="button">Rename</button></div></div></div>' +
      '<div class="tbl-wrap" style="margin-top:1.25rem"><table><thead><tr><th>Title</th><th>Author</th><th>Downloads</th><th>Status</th><th></th></tr></thead><tbody>' +
      (list.map(function (b) { return '<tr><td>' + esc(b.title) + '</td><td>' + esc(authorName(b)) + '</td><td class="num">' + num(dlOf(b)) + '</td><td>' + (isLive(b) ? '<span class="pill">Live</span>' : '<span class="pill warn">Hidden</span>') + '</td><td><button class="star" type="button" data-untag="' + esc(b.id) + '">Remove</button></td></tr>'; }).join('') ||
        '<tr><td colspan="5">No books have this tag yet.</td></tr>') + '</tbody></table></div>' +
      '<div class="saverow"><span class="confirm" id="tdelwrap"><button class="star danger" id="tdel" type="button">Delete tag</button></span></div>';
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

  function route() {
    if (!data.books) return;
    var h = decodeURIComponent(location.hash.slice(1));
    if (h === 'tags') vTags();
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
      setToken(null); token = null;
      vSignIn(e.status === 401 ? 'GitHub didn’t accept that token. Check it was copied in full and hasn’t expired.' : e.message);
    });
  }

  $('#signout').onclick = function () { setToken(null); token = null; data.books = null; $('#who').hidden = true; $('#signout').hidden = true; vSignIn(); };
  addEventListener('hashchange', route);
  token = getToken();
  if (token) start(false); else vSignIn();
})();
