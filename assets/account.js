// Foggy Press reader accounts (see supabase/schema.sql and the accounts plan): favorites, the reader's own tags,
// reading lists and reading history, saved to a Supabase account, or (signed out) to this browser only.
//  - Turned on by <meta name="fp-account" content="<supabase url>|<public key>|<turnstile site key>">, which the
//    build writes only when SUPABASE_URL and SUPABASE_ANON_KEY are set. Without it this script does nothing.
//  - The sign-in session is kept in cookies for all of foggypress.com, so pages on foggypress.com and read pages
//    on files.foggypress.com share it. Signed-out favorites and "Recently read" use a cookie the same way.
//  - Supabase's browser library loads only when it is needed: a session exists, or the reader signs in.
(function () {
  var meta = document.querySelector('meta[name="fp-account"]');
  if (!meta) return;
  var cfg = meta.content.split('|'), URL_ = cfg[0], KEY = cfg[1], TS_KEY = cfg[2] || '';
  if (!URL_ || !KEY) return;
  var T = window.fpT || function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); };
  var LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  var me = document.currentScript && document.currentScript.src;
  var BASE = me ? me.replace(/assets\/account\.js(\?.*)?$/, '') : '/';
  var DOMAIN = /(^|\.)foggypress\.com$/.test(location.hostname) ? '; domain=foggypress.com' : '';
  var SECURE = location.protocol === 'https:' ? '; secure' : '';
  var MAX_LOCAL_FAVS = 200, MAX_LOCAL_RECENT = 20;
  // signed in from Ask or Request a book: go back there, keeping that page's own ?title=… (only these two pages)
  var NEXT = (function () {
    var p = new URLSearchParams(location.search), n = p.get('next');
    if (n !== 'ask' && n !== 'request') return '';
    p.delete('next'); p.delete('code');
    return n + '/' + (String(p) ? '?' + String(p) : '');
  })();

  // ---------- cookies (long values are split over several) ----------
  function ckRaw(name) { var m = document.cookie.match('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'); return m ? m[1] : null; }
  function ckSetRaw(name, val, days) { document.cookie = name + '=' + val + '; path=/; max-age=' + Math.round(days * 86400) + '; samesite=lax' + SECURE + DOMAIN; }
  var store = {
    getItem: function (k) {
      var n = +ckRaw(k + '.n');
      if (!n) return null;
      var s = '';
      for (var i = 0; i < n; i++) { var p = ckRaw(k + '.' + i); if (p == null) return null; s += p; }
      try { return decodeURIComponent(s); } catch (e) { return null; }
    },
    setItem: function (k, v) {
      var s = encodeURIComponent(v), parts = [], old = +ckRaw(k + '.n') || 0;
      for (var i = 0; i < s.length; i += 3000) parts.push(s.slice(i, i + 3000));
      parts.forEach(function (p, i) { ckSetRaw(k + '.' + i, p, 30); });
      ckSetRaw(k + '.n', String(parts.length), 30);
      for (var j = parts.length; j < old; j++) ckSetRaw(k + '.' + j, '', 0);
    },
    removeItem: function (k) {
      var n = +ckRaw(k + '.n') || 0;
      for (var i = 0; i < n; i++) ckSetRaw(k + '.' + i, '', 0);
      ckSetRaw(k + '.n', '', 0);
    }
  };

  // ---------- signed-out store: favorites and "Recently read" in this browser ----------
  function local() {
    var d = null;
    try { d = JSON.parse(store.getItem('fp-local') || 'null'); } catch (e) {}
    return {f: (d && d.f) || [], r: (d && d.r) || []};
  }
  function saveLocal(d) {
    d.f = d.f.slice(0, MAX_LOCAL_FAVS); d.r = d.r.slice(0, MAX_LOCAL_RECENT);
    if (!d.f.length && !d.r.length) store.removeItem('fp-local'); else store.setItem('fp-local', JSON.stringify(d));
  }

  // ---------- Supabase ----------
  var sb = null, user = null, ready = null;
  function loadLib() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = LIB; s.onload = ok; s.onerror = bad; document.head.appendChild(s);
    });
  }
  function start() {
    if (ready) return ready;
    ready = loadLib().then(function () {
      sb = window.supabase.createClient(URL_, KEY, {auth: {storage: store, storageKey: 'fp-auth', flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}});
      return sb.auth.getSession();
    }).then(function (r) {
      user = r && r.data && r.data.session ? r.data.session.user : null;
      sb.auth.onAuthStateChange(function (ev, session) {
        var was = user && user.id;
        user = session ? session.user : null;
        if ((user && user.id) !== was) changed();
      });
      if (user) return mergeLocal();
    }).catch(function (e) { console.warn('Foggy Press accounts:', e); });
    return ready;
  }
  function signedIn() { return !!(sb && user); }
  function q(p) { return p.then(function (r) { if (r.error) throw r.error; return r.data; }); }

  // ---------- favorites ----------
  var favs = null;   // Set of book ids
  function loadFavs() {
    if (signedIn()) return q(sb.from('favorites').select('book_id,saved_at').order('saved_at', {ascending: false}).limit(2000)).then(function (rows) {
      favs = new Set(rows.map(function (r) { return r.book_id; })); favRows = rows; return favs;
    });
    var l = local(); favs = new Set(l.f); favRows = l.f.map(function (id) { return {book_id: id, saved_at: ''}; });
    return Promise.resolve(favs);
  }
  var favRows = [];
  function setFav(id, on) {
    if (on) favs.add(id); else favs.delete(id);
    paintStars(id);
    fpEvent && fpEvent(on ? 'save' : 'unsave');
    if (signedIn()) {
      var p = on ? sb.from('favorites').upsert({book_id: id}, {onConflict: 'user_id,book_id', ignoreDuplicates: true}) : sb.from('favorites').delete().eq('book_id', id);
      return q(p).catch(function (e) { if (on) favs.delete(id); else favs.add(id); paintStars(id); toast(T('That didn’t save. Please try again.')); throw e; });
    }
    var l = local();
    l.f = l.f.filter(function (x) { return x !== id; });
    if (on) {
      if (l.f.length >= MAX_LOCAL_FAVS) { favs.delete(id); paintStars(id); toast(T('This browser holds {n} saved books. Sign in to save more.', {n: MAX_LOCAL_FAVS})); return Promise.resolve(); }
      l.f.unshift(id);
    }
    saveLocal(l);
    return Promise.resolve();
  }

  // the browser's saved books and recent reading join the account on sign-in
  function mergeLocal() {
    var l = local();
    if (!l.f.length && !l.r.length) return;
    var jobs = [];
    if (l.f.length) jobs.push(q(sb.from('favorites').upsert(l.f.map(function (id) { return {book_id: id}; }), {onConflict: 'user_id,book_id', ignoreDuplicates: true})));
    l.r.slice().reverse().forEach(function (r) { jobs.push(q(sb.rpc('record_reading', {p_book: r[0], p_chapter: r[1] || '', p_progress: r[2] || 0}))); });
    return Promise.all(jobs).then(function () {
      saveLocal({f: [], r: []});
      toast(T('Books saved in this browser were added to your account.'));
    }).catch(function (e) { console.warn('Foggy Press accounts: merge', e); });
  }

  // ---------- the catalog (titles, authors, links) from the search index ----------
  var catalog = null;
  function books() {
    if (!catalog) catalog = fetch(BASE + 'search/books.json').then(function (r) { return r.json(); }).then(function (rows) {
      var m = {}; rows.forEach(function (b) { m[b.id] = b; }); return m;
    });
    return catalog;
  }

  // ---------- small helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function toast(msg) {
    var t = document.getElementById('fp-toast');
    if (!t) { t = el('<div id="fp-toast" class="toast" role="status" aria-live="polite"></div>'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.h); toast.h = setTimeout(function () { t.classList.remove('on'); }, 4200);
  }
  function fpEvent(name) { if (window.fpEvent) window.fpEvent(name); }
  function readLink(b, extra) { return (b.rd || (BASE + 'read/' + encodeURIComponent(b.id) + '/')) + (extra || ''); }
  function chapterName(b, ch) {
    if (!b || !b.ch || !ch) return '';
    for (var i = 0; i < b.ch.length; i++) if (b.ch[i][0] === ch) return b.ch[i][1];
    return '';
  }
  function day(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString((window.fpLang ? window.fpLang() : 'en') + '-u-nu-latn', {year: 'numeric', month: 'short', day: 'numeric'}); } catch (e) { return iso.slice(0, 10); }
  }
  // two clicks to do something that can't be undone, with no browser pop-up
  function confirmBtn(btn, label, go) {
    btn.addEventListener('click', function () {
      if (btn.dataset.armed) { delete btn.dataset.armed; go(); return; }
      btn.dataset.armed = '1'; var was = btn.textContent; btn.textContent = label;
      setTimeout(function () { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = was; } }, 5000);
    });
  }

  // ---------- the star (Save) and its menu, on book rows and read pages ----------
  function starHtml(id) {
    return '<span class="savebox" data-id="' + esc(id) + '"><button type="button" class="star" aria-pressed="false"><span class="ic" aria-hidden="true">☆</span><span class="lb">' + esc(T('Save')) + '</span></button>' +
      '<button type="button" class="more" aria-haspopup="true" aria-expanded="false" aria-label="' + esc(T('Lists and tags')) + '" title="' + esc(T('Lists and tags')) + '">▾</button></span>';
  }
  function paintStars(only) {
    document.querySelectorAll('.savebox').forEach(function (s) {
      if (only && s.dataset.id !== only) return;
      var on = favs && favs.has(s.dataset.id), b = s.querySelector('.star');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.querySelector('.ic').textContent = on ? '★' : '☆';
      b.querySelector('.lb').textContent = on ? T('Saved') : T('Save');
    });
  }
  function addStars(root) {
    (root || document).querySelectorAll('li.rec[data-id] .acts').forEach(function (a) {
      if (a.querySelector('.savebox')) return;
      a.appendChild(el(starHtml(a.closest('li.rec').dataset.id)));
    });
    var rb = document.querySelector('.readbar .rb-acts'), id = document.body.dataset.book;
    if (rb && id && !rb.querySelector('.savebox')) rb.insertBefore(el(starHtml(id)), rb.firstChild);
    paintStars();
  }
  document.addEventListener('click', function (e) {
    var star = e.target.closest && e.target.closest('.savebox .star');
    if (star) { var id = star.parentNode.dataset.id; setFav(id, !favs.has(id)); return; }
    var more = e.target.closest && e.target.closest('.savebox .more');
    if (more) { openMenu(more); return; }
    if (menu && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu) { var b = menuBtn; closeMenu(); b && b.focus(); } });

  var menu = null, menuBtn = null, lists = null, labels = null, labelBooks = null;
  function loadListsLabels(force) {
    if (!signedIn()) return Promise.resolve();
    if (lists && !force) return Promise.resolve();
    return Promise.all([
      q(sb.from('lists').select('id,name,note,updated_at').order('updated_at', {ascending: false})),
      q(sb.from('list_items').select('list_id,book_id,position,note').order('position')),
      q(sb.from('labels').select('id,name').order('name')),
      q(sb.from('label_books').select('label_id,book_id'))
    ]).then(function (r) {
      lists = r[0]; lists.forEach(function (l) { l.items = r[1].filter(function (i) { return i.list_id === l.id; }); });
      labels = r[2]; labelBooks = r[3];
    });
  }
  function closeMenu() { if (menu) { menu.remove(); menu = null; } if (menuBtn) { menuBtn.setAttribute('aria-expanded', 'false'); menuBtn = null; } }
  function openMenu(btn) {
    if (menuBtn === btn) { closeMenu(); return; }
    closeMenu();
    menuBtn = btn; btn.setAttribute('aria-expanded', 'true');
    var id = btn.parentNode.dataset.id;
    menu = el('<div class="savemenu" role="dialog" aria-label="' + esc(T('Lists and tags')) + '"><p class="mono sm">' + esc(T('Loading…')) + '</p></div>');
    document.body.appendChild(menu);
    place();
    if (!signedIn()) {
      menu.innerHTML = '<p>' + esc(T('Sign in to put books on reading lists and add your own tags.')) + '</p><a class="btn sm" href="' + BASE + 'account/">' + esc(T('Sign in')) + '</a>';
      return;
    }
    loadListsLabels().then(function () { if (menuBtn === btn) drawMenu(id); }).catch(function () { menu && (menu.innerHTML = '<p>' + esc(T('That didn’t load. Please try again.')) + '</p>'); });
  }
  function place() {
    if (!menu || !menuBtn) return;
    var r = menuBtn.getBoundingClientRect(), w = Math.min(300, innerWidth - 32);
    menu.style.width = w + 'px';
    menu.style.left = Math.max(16, Math.min(innerWidth - w - 16, r.right - w)) + scrollX + 'px';
    menu.style.top = r.bottom + 6 + scrollY + 'px';
  }
  addEventListener('resize', place);
  function drawMenu(id) {
    var onList = function (l) { return l.items.some(function (i) { return i.book_id === id; }); };
    var hasLabel = function (lb) { return labelBooks.some(function (x) { return x.label_id === lb.id && x.book_id === id; }); };
    menu.innerHTML = '<div class="eyebrow">' + esc(T('Reading lists')) + '</div><div class="opts">' +
      lists.map(function (l) { return '<label><input type="checkbox" data-list="' + l.id + '"' + (onList(l) ? ' checked' : '') + '> <span>' + esc(l.name) + '</span></label>'; }).join('') +
      '</div><form class="addnew" data-kind="list"><input maxlength="200" placeholder="' + esc(T('New list')) + '" aria-label="' + esc(T('New list')) + '"><button class="btn sm" type="submit">+</button></form>' +
      '<div class="eyebrow">' + esc(T('My tags')) + '</div><div class="opts">' +
      labels.map(function (lb) { return '<label><input type="checkbox" data-label="' + lb.id + '"' + (hasLabel(lb) ? ' checked' : '') + '> <span>' + esc(lb.name) + '</span></label>'; }).join('') +
      '</div><form class="addnew" data-kind="label"><input maxlength="200" placeholder="' + esc(T('New tag')) + '" aria-label="' + esc(T('New tag')) + '"><button class="btn sm" type="submit">+</button></form>' +
      '<a class="mono sm" href="' + BASE + 'account/">' + esc(T('My books')) + ' →</a>';
    menu.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var p = cb.dataset.list ? putOnList(cb.dataset.list, id, cb.checked) : putLabel(cb.dataset.label, id, cb.checked);
        p.catch(function () { cb.checked = !cb.checked; });
      });
    });
    menu.querySelectorAll('form.addnew').forEach(function (f) {
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = f.querySelector('input').value.trim();
        if (!name) return;
        var made = f.dataset.kind === 'list' ? newList(name).then(function (l) { return putOnList(l.id, id, true); }) : newLabel(name).then(function (lb) { return putLabel(lb.id, id, true); });
        made.then(function () { drawMenu(id); var i = menu && menu.querySelector('form[data-kind="' + f.dataset.kind + '"] input'); i && i.focus(); });
      });
    });
    var first = menu.querySelector('input'); first && first.focus();
  }
  // a failed save shows a message; the error still rejects so the caller can undo, but is not reported again
  addEventListener('unhandledrejection', function (e) { if (e.reason && e.reason.fpShown) e.preventDefault(); });
  function fail(e) {
    if (e && typeof e === 'object') e.fpShown = true;
    var msg = String(e && e.message || '');
    toast(/limit reached/.test(msg) ? T('You’ve reached the limit for this. Remove something first.') : /duplicate|unique/.test(msg) ? T('You already have one with that name.') : T('That didn’t save. Please try again.'));
    throw e;
  }
  function newList(name) {
    return q(sb.from('lists').insert({name: name}).select('id,name,note,updated_at').single()).then(function (l) { l.items = []; lists.unshift(l); fpEvent('list: new'); return l; }, fail);
  }
  function newLabel(name) {
    return q(sb.from('labels').insert({name: name}).select('id,name').single()).then(function (lb) { labels.push(lb); labels.sort(function (a, b) { return a.name.localeCompare(b.name, 'en', {numeric: true}); }); fpEvent('tag: new'); return lb; }, fail);
  }
  function putOnList(listId, id, on) {
    var l = lists.filter(function (x) { return x.id === listId; })[0];
    if (on) {
      var pos = l.items.length ? l.items[l.items.length - 1].position + 1 : 1;
      return q(sb.from('list_items').upsert({list_id: listId, book_id: id, position: pos}, {onConflict: 'list_id,book_id', ignoreDuplicates: true})).then(function () {
        if (!l.items.some(function (i) { return i.book_id === id; })) l.items.push({list_id: listId, book_id: id, position: pos, note: ''});
      }, fail);
    }
    return q(sb.from('list_items').delete().eq('list_id', listId).eq('book_id', id)).then(function () {
      l.items = l.items.filter(function (i) { return i.book_id !== id; });
    }, fail);
  }
  function putLabel(labelId, id, on) {
    if (on) return q(sb.from('label_books').upsert({label_id: labelId, book_id: id}, {onConflict: 'label_id,book_id', ignoreDuplicates: true})).then(function () {
      labelBooks.push({label_id: labelId, book_id: id});
    }, fail);
    return q(sb.from('label_books').delete().eq('label_id', labelId).eq('book_id', id)).then(function () {
      labelBooks = labelBooks.filter(function (x) { return !(x.label_id === labelId && x.book_id === id); });
    }, fail);
  }

  // ---------- reading history ----------
  function recordLocal(id, ch, pct) {
    var l = local();
    l.r = l.r.filter(function (r) { return r[0] !== id; });
    l.r.unshift([id, ch || '', Math.round((pct || 0) * 10) / 10, Date.now()]);
    saveLocal(l);
  }
  function record(id, ch, pct, opened) {
    if (signedIn()) return q(sb.rpc('record_reading', {p_book: id, p_chapter: ch || '', p_progress: pct || 0, p_open: !!opened})).catch(function () {});
    recordLocal(id, ch, pct);
  }
  function recent(n) {
    if (signedIn()) return q(sb.from('history').select('book_id,chapter,progress,last_opened,opens,downloaded_pdf,downloaded_epub').order('last_opened', {ascending: false}).limit(n));
    return Promise.resolve(local().r.slice(0, n).map(function (r) { return {book_id: r[0], chapter: r[1], progress: r[2], last_opened: new Date(r[3]).toISOString()}; }));
  }
  // where the reader is on a read page: the chapter at the top of the screen, and how far down the book
  function position() {
    var secs = document.querySelectorAll('article.book section[id]'), ch = '';
    for (var i = 0; i < secs.length; i++) { if (secs[i].getBoundingClientRect().top <= 80) ch = secs[i].id; else break; }
    var h = document.documentElement.scrollHeight - innerHeight;
    return {ch: ch, pct: h > 0 ? Math.max(0, Math.min(100, scrollY / h * 100)) : 0};
  }
  function readPage() {
    var id = document.body.dataset.book;
    if (!id) return;
    // ?pos=42.5 (from Continue reading): go back to that place
    try {
      var u = new URL(location.href), pos = parseFloat(u.searchParams.get('pos'));
      if (!isNaN(pos)) {
        u.searchParams.delete('pos'); history.replaceState(null, '', u.toString());
        var go = function () { scrollTo(0, pos / 100 * (document.documentElement.scrollHeight - innerHeight)); };
        if (document.readyState === 'complete') go(); else addEventListener('load', go);
        setTimeout(go, 400);
      }
    } catch (e) {}
    var last = '', timer = null;
    var save = function (opened) {
      var p = position(), key = p.ch + '|' + Math.round(p.pct);
      if (key === last && !opened) return;
      last = key; record(id, p.ch, p.pct, opened);
    };
    setTimeout(function () { save(true); }, 1500);
    addEventListener('scroll', function () { clearTimeout(timer); timer = setTimeout(function () { save(false); }, 4000); }, {passive: true});
    addEventListener('pagehide', function () { save(false); });
  }
  // PDF and EPUB downloads join the history of a signed-in reader
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-goatcounter-click^="pdf-"], a[data-goatcounter-click^="epub-"]');
    if (!a || !signedIn()) return;
    var k = a.dataset.goatcounterClick, pdf = k.indexOf('pdf-') === 0;
    sb.rpc('record_reading', {p_book: k.slice(pdf ? 4 : 5), p_pdf: pdf, p_epub: !pdf}).then(function () {}, function () {});
  });

  // ---------- Continue reading (left rail, signed-in readers only) ----------
  function continueRow() {
    var box = document.getElementById('railhist');
    if (!box) return;
    if (!signedIn()) { box.hidden = true; return; }
    recent(5).then(function (rows) {
      return books().then(function (cat) {
        var items = rows.filter(function (r) { return cat[r.book_id]; }).map(function (r) {
          var b = cat[r.book_id], pct = Math.round(r.progress || 0);
          return '<a class="rh" href="' + esc(readLink(b, '?pos=' + (r.progress || 0))) + '" title="' + esc(b.t + (b.a ? ' · ' + b.a : '')) + '"><span class="rht"><span class="t">' + esc(b.t) + '</span>' +
            '<span class="pg" aria-hidden="true"><i style="width:' + Math.max(2, pct) + '%"></i></span></span><span class="mono">' + esc(T('{n}% read', {n: pct})) + '</span></a>';
        });
        box.innerHTML = '<div class="eyebrow" style="margin-bottom:.6rem">' + esc(T('Continue reading')) + '</div><nav aria-label="' + esc(T('Continue reading')) + '">' +
          (items.length ? items.join('') : '<p class="rhnone">' + esc(T('No reading history yet.')) + '</p>') +
          '<a href="' + BASE + 'account/#history"><span>' + esc(T('History')) + '</span><span class="mono">→</span></a></nav>';
        box.hidden = false;
      });
    }).catch(function () { box.hidden = true; });
  }

  // ---------- My books (/account/) ----------
  function rowHtml(b, id, extra) {
    if (!b) return '<li class="rec gone" data-id="' + esc(id) + '"><span class="main"><span class="t">' + esc(id) + '</span><span class="a">' + esc(T('No longer on the site')) + '</span></span><span class="acts"></span>' + (extra || '') + '</li>';
    return '<li class="rec" data-id="' + esc(b.id) + '"><a class="main" href="' + esc(b.read ? readLink(b) : b.pdf) + '"><span class="t">' + esc(b.t) + '</span><span class="a">' + esc(b.a) + '</span></a>' +
      '<span class="m mono">' + esc(b.d) + '</span><span class="acts">' + (b.read ? '<a class="act" href="' + esc(readLink(b)) + '">' + esc(T('Read online')) + '</a>' : '') +
      '<a class="act" href="' + esc(b.pdf) + '" data-goatcounter-click="pdf-' + esc(b.id) + '">' + esc(T('Print this book')) + '</a>' +
      (b.epub ? '<a class="act" href="' + esc(b.epub) + '" download data-goatcounter-click="epub-' + esc(b.id) + '">EPUB</a>' : '') + '</span>' + (extra || '') + '</li>';
  }
  var acct = null, view = 'saved', sortBy = 'saved', labelFilter = '';
  function accountPage() {
    acct = document.getElementById('acct');
    if (!acct) return;
    start().then(drawAccount);
    addEventListener('hashchange', function () { if (signedIn()) drawAccount(); });
  }
  function drawAccount() {
    if (!acct) return;
    if (!signedIn()) return drawSignIn();
    // signed in from Ask's "Sign in to ask": back to Ask
    if (NEXT) { location.replace(BASE + NEXT); return; }
    var h = location.hash.replace('#', '');
    view = ['saved', 'lists', 'history', 'account'].indexOf(h) >= 0 ? h : 'saved';
    var tabs = [['saved', T('Saved')], ['lists', T('Reading lists')], ['history', T('History')], ['account', T('Account')]];
    acct.innerHTML = '<div class="ph"><span class="crumb"><a href="' + BASE + '">' + esc(T('Home')) + '</a></span><h1>' + esc(T('My books')) + '</h1><p class="sub mono">' + esc(user.email || '') + '</p></div>' +
      '<div class="seg tabs" role="tablist">' + tabs.map(function (t) { return '<a role="tab" href="#' + t[0] + '" aria-selected="' + (t[0] === view) + '">' + esc(t[1]) + '</a>'; }).join('') + '</div><div id="acct-body"><p class="mono sm">' + esc(T('Loading…')) + '</p></div>';
    var body = document.getElementById('acct-body');
    var draw = {saved: drawSaved, lists: drawLists, history: drawHistory, account: drawSettings}[view];
    draw(body).catch(function (e) { console.warn(e); body.innerHTML = '<p>' + esc(T('That didn’t load. Please try again.')) + '</p>'; });
  }
  function drawSaved(body) {
    return Promise.all([loadFavs(), loadListsLabels(true), books()]).then(function (r) {
      var cat = r[2];
      var rows = favRows.slice();
      if (labelFilter) {
        var on = new Set(labelBooks.filter(function (x) { return x.label_id === labelFilter; }).map(function (x) { return x.book_id; }));
        rows = rows.filter(function (x) { return on.has(x.book_id); });
      }
      var key = function (x) { var b = cat[x.book_id]; return b ? (sortBy === 'author' ? (b.al + ' ' + b.t) : b.t.replace(/^(the|a|an) /i, '')) : x.book_id; };
      if (sortBy !== 'saved') rows.sort(function (a, b) { return key(a).localeCompare(key(b), 'en', {numeric: true}); });
      var tagsOf = function (id) { return labelBooks.filter(function (x) { return x.book_id === id; }).map(function (x) { var lb = labels.filter(function (l) { return l.id === x.label_id; })[0]; return lb ? '<span class="mytag">' + esc(lb.name) + '</span>' : ''; }).join(''); };
      body.innerHTML = '<div class="booksort"><span class="eyebrow">' + esc(T('Sort by')) + '</span><div class="seg" role="group">' +
        [['saved', T('Saved')], ['author', T('Author')], ['title', T('Title')]].map(function (s) { return '<button type="button" data-s="' + s[0] + '" aria-pressed="' + (s[0] === sortBy) + '">' + esc(s[1]) + '</button>'; }).join('') + '</div>' +
        (labels.length ? '<label class="tagfilter"><span class="vh">' + esc(T('My tags')) + '</span><select><option value="">' + esc(T('All my tags')) + '</option>' + labels.map(function (l) { return '<option value="' + l.id + '"' + (l.id === labelFilter ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('') + '</select></label>' : '') + '</div>' +
        (rows.length ? '<ul class="recs">' + rows.map(function (x) { return rowHtml(cat[x.book_id], x.book_id, tagsOf(x.book_id) ? '<span class="mytags">' + tagsOf(x.book_id) + '</span>' : ''); }).join('') + '</ul>'
          : '<p class="empty">' + esc(labelFilter ? T('No saved books have this tag.') : T('Nothing saved yet. Press Save on any book to keep it here.')) + '</p>') +
        (labels.length ? '<div class="manage"><div class="eyebrow">' + esc(T('My tags')) + '</div>' + labels.map(function (l) { return '<span class="mytag">' + esc(l.name) + ' <button type="button" class="x" data-del-label="' + l.id + '" aria-label="' + esc(T('Delete tag')) + '" title="' + esc(T('Delete tag')) + '">×</button></span>'; }).join(' ') + '</div>' : '');
      addStars(body);
      body.querySelectorAll('[data-s]').forEach(function (b) { b.addEventListener('click', function () { sortBy = b.dataset.s; drawSaved(body); }); });
      var sel = body.querySelector('.tagfilter select');
      sel && sel.addEventListener('change', function () { labelFilter = sel.value; drawSaved(body); });
      body.querySelectorAll('[data-del-label]').forEach(function (b) {
        confirmBtn(b, '?', function () {
          q(sb.from('labels').delete().eq('id', b.dataset.delLabel)).then(function () { if (labelFilter === b.dataset.delLabel) labelFilter = ''; drawSaved(body); }, fail);
        });
      });
    });
  }
  function drawLists(body) {
    return loadListsLabels(true).then(function () {
      body.innerHTML = '<form class="addnew big"><input maxlength="200" placeholder="' + esc(T('Name a new reading list')) + '" aria-label="' + esc(T('New list')) + '"><button class="btn sm" type="submit">' + esc(T('Make list')) + '</button></form>' +
        (lists.length ? '<ul class="lists">' + lists.map(function (l) {
          return '<li><a href="' + BASE + 'list/?id=' + l.id + '"><span class="t">' + esc(l.name) + '</span>' + (l.note ? '<span class="a">' + esc(l.note) + '</span>' : '') + '</a><span class="mono sm">' +
            esc(T(l.items.length === 1 ? '{n} book' : '{n} books', {n: l.items.length})) + ' · ' + esc(day(l.updated_at)) + '</span></li>';
        }).join('') + '</ul>' : '<p class="empty">' + esc(T('No reading lists yet.')) + '</p>');
      body.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        var name = this.querySelector('input').value.trim();
        if (name) newList(name).then(function (l) { location.href = BASE + 'list/?id=' + l.id; });
      });
    });
  }
  function historyOn() { return q(sb.from('profiles').select('history_on').maybeSingle()).then(function (p) { return !p || p.history_on; }); }
  function drawHistory(body) {
    return Promise.all([recent(200), books(), historyOn()]).then(function (r) {
      var rows = r[0], cat = r[1], on = r[2];
      body.innerHTML = '<div class="booksort"><label class="switch"><input type="checkbox"' + (on ? ' checked' : '') + '> ' + esc(T('Keep my reading history')) + '</label>' +
        (rows.length ? '<button type="button" class="btn ghost sm" id="clearh">' + esc(T('Clear history')) + '</button>' : '') + '</div>' +
        (!on ? '<p class="sub">' + esc(T('History is off. Nothing new is recorded.')) + '</p>' : '') +
        (rows.length ? '<ul class="recs">' + rows.map(function (x) {
          var b = cat[x.book_id], ch = chapterName(b, x.chapter), bits = [];
          if (x.progress) bits.push(T('{n}% read', {n: Math.round(x.progress)}));
          if (ch) bits.push(ch);
          if (x.downloaded_pdf) bits.push('PDF');
          if (x.downloaded_epub) bits.push('EPUB');
          bits.push(day(x.last_opened));
          var cont = b && b.read ? '<a class="act" href="' + esc(readLink(b, '?pos=' + (x.progress || 0))) + '">' + esc(T('Continue reading')) + '</a>' : '';
          return rowHtml(b, x.book_id, '<span class="hist mono sm">' + esc(bits.join(' · ')) + '</span>' + cont);
        }).join('') + '</ul>' : '<p class="empty">' + esc(T('No reading history yet.')) + '</p>');
      addStars(body);
      body.querySelector('.switch input').addEventListener('change', function () {
        var v = this.checked;
        q(sb.from('profiles').update({history_on: v}).eq('user_id', user.id)).then(function () { drawHistory(body); }, fail);
      });
      var c = document.getElementById('clearh');
      c && confirmBtn(c, T('Press again to clear'), function () {
        q(sb.from('history').delete().eq('user_id', user.id)).then(function () { drawHistory(body); }, fail);
      });
    });
  }
  function drawSettings(body) {
    body.innerHTML = '<dl class="facts"><dt>' + esc(T('Email')) + '</dt><dd class="mono">' + esc(user.email) + '</dd></dl>' +
      '<p><button type="button" class="btn ghost sm" id="signout">' + esc(T('Sign out')) + '</button></p>' +
      '<h2 class="eyebrow">' + esc(T('Your data')) + '</h2><p class="sub">' + esc(T('Download everything saved in your account as a file, or delete the account and everything in it.')) + ' <a href="' + BASE + 'privacy/">' + esc(T('Privacy')) + '</a></p>' +
      '<p class="btns"><button type="button" class="btn ghost sm" id="export">' + esc(T('Download my data')) + '</button> <button type="button" class="btn ghost sm danger" id="delete">' + esc(T('Delete my account')) + '</button></p>';
    document.getElementById('signout').addEventListener('click', function () { sb.auth.signOut().finally(function () { store.removeItem('fp-auth'); location.href = BASE; }); });
    document.getElementById('export').addEventListener('click', function () {
      // chats exist once Ask is set up; without its tables they come back empty
      var opt = function (t) { return sb.from(t).select('*').then(function (x) { return x.error ? [] : x.data; }); };
      Promise.all(['profiles', 'favorites', 'labels', 'label_books', 'lists', 'list_items', 'history'].map(function (t) { return q(sb.from(t).select('*')); }).concat([opt('chats'), opt('chat_messages'), opt('book_requests')])).then(function (r) {
        var data = {email: user.email, account_created: user.created_at, exported: new Date().toISOString(), profile: r[0][0] || null, favorites: r[1], tags: r[2], tagged_books: r[3], lists: r[4], list_books: r[5], history: r[6], chats: r[7], chat_messages: r[8], book_requests: r[9]};
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
        a.download = 'foggy-press-my-data.json'; document.body.appendChild(a); a.click(); a.remove();
      }, fail);
    });
    confirmBtn(document.getElementById('delete'), T('Press again to delete everything'), function () {
      q(sb.rpc('delete_me')).then(function () {
        return sb.auth.signOut().catch(function () {});
      }).then(function () { store.removeItem('fp-auth'); saveLocal({f: [], r: []}); location.href = BASE + '?deleted=1'; }, fail);
    });
    return Promise.resolve();
  }

  // ---------- signing in ----------
  var tsWidget = null, tsToken = '';
  function turnstile(box) {
    if (!TS_KEY) return;
    var render = function () { tsWidget = window.turnstile.render(box, {sitekey: TS_KEY, appearance: 'interaction-only', callback: function (t) { tsToken = t; }, 'expired-callback': function () { tsToken = ''; }}); };
    if (window.turnstile) return render();
    window.fpTurnstile = render;
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=fpTurnstile'; s.async = true; document.head.appendChild(s);
  }
  var sentEmail = '';
  function drawSignIn(sentTo) {
    sentEmail = sentTo || '';
    var l = local();
    acct.innerHTML = '<div class="ph"><span class="crumb"><a href="' + BASE + '">' + esc(T('Home')) + '</a></span><h1>' + esc(T('My books')) + '</h1>' +
      // less busy (19 Nov 2026): a shorter line; how sign-in works is in the "?" beside it
      '<p class="sub">' + esc(T('Sign in to keep your books, lists and history on every device.')) +
      (window.fpHelp ? window.fpHelp('signin', T('How sign-in works'), [esc(T('Sign in to keep your saved books, reading lists, tags and history on every device.')),
        esc(T('No password: we email you a link.'))]) : '') + '</p></div>' +
      '<div class="signin card">' + (sentTo
        ? '<p>' + esc(T('We sent a sign-in link to {email}. Open it on this device, or type the 6-digit code from the email here.', {email: sentTo})) + '</p>' +
          '<form id="codeform"><label class="eyebrow" for="code">' + esc(T('Code')) + '</label><div class="sbox"><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" pattern="[0-9 ]*"><button type="submit" class="btn sm">' + esc(T('Sign in')) + '</button></div><div id="ts"></div></form>' +
          '<p class="sm"><button type="button" class="linkish" id="again">' + esc(T('Use a different email')) + '</button></p>'
        : '<form id="mailform" novalidate><label class="eyebrow" for="email">' + esc(T('Email')) + '</label><div class="sbox"><input id="email" type="email" autocomplete="email" required maxlength="254"><button type="submit" class="btn sm">' + esc(T('Send link')) + '</button></div><div id="ts"></div></form>') +
      '<p class="msg" role="status" aria-live="polite"></p>' +
      '<p class="fine">' + esc(T('We keep your email address and the books you save, nothing else. Accounts are for readers 13 and over.')) + ' <a href="' + BASE + 'privacy/">' + esc(T('Privacy')) + '</a></p></div>' +
      '<section class="sec" id="localsaved"></section>';
    var msg = acct.querySelector('.msg');
    var say = function (s, bad) { msg.textContent = s; msg.classList.toggle('bad', !!bad); };
    if (sentTo) {
      document.getElementById('code').focus();
      tsToken = ''; turnstile(document.getElementById('ts'));
      document.getElementById('again').addEventListener('click', function () { drawSignIn(); });
      document.getElementById('codeform').addEventListener('submit', function (e) {
        e.preventDefault();
        var code = document.getElementById('code').value.replace(/\D/g, '');
        if (code.length < 6) { say(T('Please type the 6-digit code from the email.'), true); return; }
        if (TS_KEY && !tsToken) { say(T('One moment: checking this browser…')); return; }
        say(T('Signing in…'));
        sb.auth.verifyOtp({email: sentTo, token: code, type: 'email', options: {captchaToken: tsToken || undefined}}).then(function (r) {
          if (tsWidget != null && window.turnstile) { window.turnstile.reset(tsWidget); tsToken = ''; }
          if (r.error) { say(T('That code didn’t work. Check it, or send a new link.'), true); return; }
          user = r.data.user; fpEvent('sign-in: code');
          return Promise.resolve(mergeLocal()).then(function () { return loadFavs(); }).then(drawAccount);
        });
      });
    } else {
      turnstile(document.getElementById('ts'));
      document.getElementById('mailform').addEventListener('submit', function (e) {
        e.preventDefault();
        var email = document.getElementById('email').value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say(T('That email address doesn’t look right. Please check it.'), true); return; }
        if (TS_KEY && !tsToken) { say(T('One moment: checking this browser…')); return; }
        say(T('Sending…'));
        sb.auth.signInWithOtp({email: email, options: {emailRedirectTo: location.origin + location.pathname + location.search.replace(/[?&]code=[^&]*/, ''), shouldCreateUser: true, captchaToken: tsToken || undefined}}).then(function (r) {
          if (tsWidget != null && window.turnstile) { window.turnstile.reset(tsWidget); tsToken = ''; }
          if (r.error) { say(r.error.status === 429 ? T('Too many tries. Please wait a minute and try again.') : T('We couldn’t send the email. Please try again.'), true); return; }
          fpEvent('sign-in: link sent');
          drawSignIn(email);
        });
      });
    }
    // what this browser has saved while signed out
    if (l.f.length || l.r.length) books().then(function (cat) {
      var box = document.getElementById('localsaved');
      if (!box) return;
      box.innerHTML = (l.f.length ? '<div class="sec-h"><h2>' + esc(T('Saved in this browser')) + '</h2></div><ul class="recs">' + l.f.map(function (id) { return rowHtml(cat[id], id); }).join('') + '</ul>' : '') +
        (l.r.length ? '<div class="sec-h"><h2>' + esc(T('Recently read')) + '</h2></div><ul class="recs">' + l.r.map(function (r) { return rowHtml(cat[r[0]], r[0]); }).join('') + '</ul>' : '') +
        '<p class="fine">' + esc(T('These are kept in this browser only. Sign in and they join your account.')) + '</p>';
      addStars(box);
    });
  }

  // ---------- a reading list (/list/?id=) ----------
  function listPage() {
    var box = document.getElementById('list');
    if (!box) return;
    var id = new URLSearchParams(location.search).get('id');
    start().then(function () {
      if (!signedIn()) { location.replace(BASE + 'account/'); return; }
      return Promise.all([loadListsLabels(true), books()]).then(function (r) { drawList(box, id, r[1]); });
    }).catch(function () { box.innerHTML = '<p>' + esc(T('That didn’t load. Please try again.')) + '</p>'; });
  }
  function drawList(box, id, cat) {
    var l = lists.filter(function (x) { return x.id === id; })[0];
    if (!l) { box.innerHTML = '<div class="ph"><h1>' + esc(T('List not found')) + '</h1><p class="sub"><a href="' + BASE + 'account/#lists">' + esc(T('My reading lists')) + ' →</a></p></div>'; return; }
    document.title = l.name + ' · Foggy Press';
    l.items.sort(function (a, b) { return a.position - b.position; });
    box.innerHTML = '<div class="ph"><span class="crumb"><a href="' + BASE + 'account/#lists">' + esc(T('My reading lists')) + '</a></span>' +
      '<h1><input class="title-edit" value="' + esc(l.name) + '" maxlength="200" aria-label="' + esc(T('List name')) + '"></h1>' +
      '<p class="sub"><input class="note-edit" value="' + esc(l.note) + '" maxlength="200" placeholder="' + esc(T('Add a note about this list')) + '" aria-label="' + esc(T('Note')) + '"></p>' +
      '<p class="mono sm">' + esc(T(l.items.length === 1 ? '{n} book' : '{n} books', {n: l.items.length})) + '</p></div>' +
      (l.items.length ? '<ol class="recs listitems">' + l.items.map(function (it, i) {
        return rowHtml(cat[it.book_id], it.book_id, '<span class="itemctl"><input class="inote" value="' + esc(it.note) + '" maxlength="200" placeholder="' + esc(T('Note')) + '" aria-label="' + esc(T('Note')) + '">' +
          '<button type="button" data-mv="-1"' + (i ? '' : ' disabled') + ' aria-label="' + esc(T('Move up')) + '">↑</button><button type="button" data-mv="1"' + (i < l.items.length - 1 ? '' : ' disabled') + ' aria-label="' + esc(T('Move down')) + '">↓</button>' +
          '<button type="button" data-rm aria-label="' + esc(T('Remove from list')) + '" title="' + esc(T('Remove from list')) + '">×</button></span>');
      }).join('') + '</ol>' : '<p class="empty">' + esc(T('This list is empty. Use the ▾ next to Save on any book to add it.')) + '</p>') +
      '<p class="btns"><button type="button" class="btn ghost sm danger" id="dellist">' + esc(T('Delete this list')) + '</button></p>';
    var upd = function (patch) { return q(sb.from('lists').update(patch).eq('id', l.id)).then(function () { for (var k in patch) l[k] = patch[k]; }, fail); };
    box.querySelector('.title-edit').addEventListener('change', function () { var v = this.value.trim(); if (v) upd({name: v}); else this.value = l.name; });
    box.querySelector('.note-edit').addEventListener('change', function () { upd({note: this.value.trim()}); });
    box.querySelectorAll('li.rec').forEach(function (li) {
      var bid = li.dataset.id, it = l.items.filter(function (x) { return x.book_id === bid; })[0];
      li.querySelector('.inote').addEventListener('change', function () { q(sb.from('list_items').update({note: this.value.trim()}).eq('list_id', l.id).eq('book_id', bid)).then(function () {}, fail); });
      li.querySelectorAll('[data-mv]').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = l.items.indexOf(it), j = i + +b.dataset.mv, other = l.items[j];
          if (!other) return;
          var a = it.position, c = other.position;
          if (a === c) { c = a + (+b.dataset.mv); }
          Promise.all([q(sb.from('list_items').update({position: c}).eq('list_id', l.id).eq('book_id', it.book_id)), q(sb.from('list_items').update({position: a}).eq('list_id', l.id).eq('book_id', other.book_id))])
            .then(function () { it.position = c; other.position = a; drawList(box, id, cat); var f = box.querySelector('li.rec[data-id="' + bid + '"] [data-mv="' + b.dataset.mv + '"]'); f && !f.disabled && f.focus(); }, fail);
        });
      });
      li.querySelector('[data-rm]').addEventListener('click', function () { putOnList(l.id, bid, false).then(function () { drawList(box, id, cat); }); });
    });
    confirmBtn(document.getElementById('dellist'), T('Press again to delete this list'), function () {
      q(sb.from('lists').delete().eq('id', l.id)).then(function () { location.href = BASE + 'account/#lists'; }, fail);
    });
    addStars(box);
  }

  // ---------- start ----------
  function changed() {
    lists = labels = labelBooks = null;
    loadFavs().then(function () { paintStars(); continueRow(); if (acct) drawAccount(); });
  }
  var hasSession = !!ckRaw('fp-auth.n') || /[?&]code=/.test(location.search);
  var boot = hasSession || document.getElementById('acct') || document.getElementById('list') ? start() : Promise.resolve();
  boot.then(loadFavs).then(function () {
    addStars();
    continueRow();
    readPage();
    accountPage();
    listPage();
    if (/[?&]deleted=1/.test(location.search)) toast(T('Your account and everything in it were deleted.'));
  });
  document.addEventListener('fp-lang', function () {
    document.querySelectorAll('.savebox .more').forEach(function (b) { b.setAttribute('aria-label', T('Lists and tags')); b.title = T('Lists and tags'); });
    paintStars(); continueRow(); if (acct && sb) { if (signedIn()) drawAccount(); else drawSignIn(sentEmail); }
    var lb = document.getElementById('list'); if (lb && signedIn() && lists) books().then(function (cat) { drawList(lb, new URLSearchParams(location.search).get('id'), cat); });
  });
  window.fpAccount = {
    store: store, signedIn: signedIn, ready: start, books: books, toast: toast,
    hasSession: function () { return !!ckRaw('fp-auth.n'); },
    client: function () { return sb; },
    // the reader's current access token (refreshed if it has run out), for calls to the ask function
    token: function () { return start().then(function () { return sb ? sb.auth.getSession() : null; }).then(function (r) { return r && r.data.session ? r.data.session.access_token : null; }); },
    star: function (box) { addStars(box); }
  };
})();
