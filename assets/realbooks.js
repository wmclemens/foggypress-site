// My Real Books (/real-books/): a signed-in reader's own catalogue of the paper books they own.
//  - The list: sortable; sorted by author, each author's books fold under the name, as on the By author page.
//  - Scanning: the page opens the phone's camera inside itself (getUserMedia). Each tap of the shutter adds a page to
//    the book being shot; "Next book" starts the next one. Each finished book's photos go to the scan function
//    (supabase/functions/scan), which reads them with Claude; the book is saved at once, marked "check this", and
//    the reader confirms it later. Photos stay in this page's memory only: never in the camera roll, never stored.
//  - Each book: notes, tags (starting from its Library of Congress subjects), year read, the reader's own fields,
//    and a link to the same book on Foggy Press when there is one. CSV export.
//  - Sort by Subject: the books grouped by Library of Congress class, then subclass (from the LC number, as on the site:
//    assets/lcc.json is catalog/lcc.json). A subject heading in a book's record finds every book with it.
// Turned on by <meta name="fp-scan" content="<function url>"> (build.py, REAL_BOOKS_ON) and needs assets/account.js.
(function () {
  var box = document.getElementById('realbooks'), acc = window.fpAccount;
  var meta = document.querySelector('meta[name="fp-scan"]'), acct = document.querySelector('meta[name="fp-account"]');
  if (!box || !acc || !meta || !acct) return;
  var FN = meta.content, KEY = acct.content.split('|')[1];
  var T = window.fpT || function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); };
  var me = document.currentScript && document.currentScript.src;
  var BASE = me ? me.replace(/assets\/realbooks\.js(\?.*)?$/, '') : '/';
  var COLS = 'id,title,subtitle,author_last,author_first,other_authors,contributors,publisher,place,year,edition,volume,isbn,language,subjects,lc_call,dewey,tags,year_read,notes,custom,catalog_id,source,needs_review,created_at,updated_at';
  var LONG = 1600, QUALITY = 0.85, MAX_PAGES = 4;

  var rows = null, fields = [], cat = {}, catIndex = null, LCC = null;
  var view = {sort: 'author', dir: 1, q: '', show: 'all', edit: null, allOpen: false};
  var msg = '';

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function sb() { return acc.client(); }
  function q(p) { return p.then(function (r) { if (r.error) throw r.error; return r.data; }); }
  function toast(s) { if (acc.toast) acc.toast(s); }
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function nat(a, b) { return String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'}); }
  function titleKey(t) { return fold(t).replace(/^(the|a|an)\s+/, '').replace(/[^\p{L}\p{N} ]/gu, '').trim(); }
  function authorName(r) { return [r.author_first, r.author_last].filter(Boolean).join(' '); }
  function authorKey(r) { return fold(r.author_last) + '|' + fold(r.author_first); }
  function readLabel(v) { return v === 'read' ? T('Read') : v || ''; }
  function slug(s) { return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'author'; }

  // ---------- Library of Congress class of a book, from its LC number (same rules as build/lc.py) ----------
  function lcSub(code) {
    if (!LCC) return '';
    var m = /^\s*([A-Z]+)\s*([\d.]*)/.exec(String(code || '').toUpperCase());
    if (!m) return '';
    var L = m[1], n = m[2] ? parseFloat(m[2]) : null;
    if (L === 'E') return n != null && n < 151 ? 'E-AM' : 'E-US';
    if (L === 'F') return n == null || n < 1000 ? 'F-US' : n < 1200 ? 'F-CA' : n < 1400 ? 'F-MX' : 'F-LA';
    if (LCC.subclasses[L]) return L;
    return LCC.subclasses[L[0]] ? L[0] : '';
  }
  function lcClass(key) { return key ? LCC.classes[LCC.subclasses[key]['class']] : ''; }
  function loadLcc() {
    return fetch(BASE + 'assets/lcc.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { LCC = j; }).catch(function () {});
  }

  // ---------- the same book on Foggy Press: title and author's last name match, ignoring "The", case and accents ----------
  function catalogMatch(r) {
    if (!catIndex) {
      catIndex = {};
      Object.keys(cat).forEach(function (id) { var b = cat[id]; catIndex[titleKey(b.t) + '|' + fold(b.al)] = id; });
    }
    var t = titleKey(r.title), last = fold(r.author_last);
    if (!t) return '';
    // "Abraham Lincoln: The Prairie Years and The War Years" is on Foggy Press as "Abraham Lincoln" too
    return catIndex[t + '|' + last] || (r.subtitle && catIndex[titleKey(r.title + ' ' + r.subtitle) + '|' + last]) || '';
  }
  function fpLink(r) {
    var b = r.catalog_id && cat[r.catalog_id];
    if (!b) return '';
    return b.read ? (b.rd || BASE + 'read/' + encodeURIComponent(b.id) + '/') : b.pdf;
  }

  // ---------- loading and saving ----------
  function load() {
    return Promise.all([
      q(sb().from('real_books').select(COLS).order('created_at', {ascending: false}).limit(20000)),
      q(sb().from('real_book_fields').select('name,position').order('position'))
    ]).then(function (r) { rows = r[0]; fields = r[1].map(function (f) { return f.name; }); return settle(); });
  }
  // books scanned before 28 Nov were all marked "to check": keep the mark only where the reading was in doubt
  function settle() {
    var ok = rows.filter(function (r) { return r.needs_review && r.source === 'photo' && !doubtful({title: r.title, unsure: (r.custom || {})._unsure}); });
    if (!ok.length) return;
    var parts = [];
    for (var i = 0; i < ok.length; i += 100) parts.push(ok.slice(i, i + 100));
    return Promise.all(parts.map(function (part) {
      return q(sb().from('real_books').update({needs_review: false}).in('id', part.map(function (r) { return r.id; })))
        .then(function () { part.forEach(function (r) { r.needs_review = false; }); });
    })).catch(function (e) { console.warn('settle', e); });
  }
  function clean(d) {
    var out = {};
    ['title', 'subtitle', 'author_last', 'author_first', 'other_authors', 'contributors', 'publisher', 'place', 'edition', 'volume', 'isbn', 'language', 'lc_call', 'dewey', 'notes', 'year_read', 'catalog_id']
      .forEach(function (k) { if (d[k] != null) out[k] = String(d[k]).trim(); });
    if ('year' in d) { var y = parseInt(d.year, 10); out.year = y >= 1000 && y <= 2200 ? y : null; }
    ['tags', 'subjects'].forEach(function (k) { if (d[k]) out[k] = d[k].filter(Boolean).slice(0, k === 'tags' ? 50 : 30); });
    if (d.custom) out.custom = d.custom;
    if ('needs_review' in d) out.needs_review = !!d.needs_review;
    if (d.source) out.source = d.source;
    return out;
  }
  function insert(d) { return q(sb().from('real_books').insert(clean(d)).select(COLS).single()).then(function (row) { rows.unshift(row); return row; }); }
  function update(id, d) {
    return q(sb().from('real_books').update(clean(d)).eq('id', id).select(COLS).single()).then(function (row) {
      rows = rows.map(function (x) { return x.id === id ? row : x; }); return row;
    });
  }
  function remove(id) { return q(sb().from('real_books').delete().eq('id', id)).then(function () { rows = rows.filter(function (x) { return x.id !== id; }); }); }

  // ---------- the list ----------
  var SORTS = {
    author: function (a, b) { return nat(fold(a.author_last), fold(b.author_last)) || nat(fold(a.author_first), fold(b.author_first)) || nat(titleKey(a.title), titleKey(b.title)) || nat(a.volume, b.volume); },
    title: function (a, b) { return nat(titleKey(a.title), titleKey(b.title)) || nat(a.volume, b.volume); },
    year: function (a, b) { return (a.year || 99999) - (b.year || 99999) || SORTS.author(a, b); },
    read: function (a, b) { return readRank(b) - readRank(a) || SORTS.author(a, b); },
    added: function (a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0; },
    subject: function (a, b) {
      var ka = lcSub(a.lc_call), kb = lcSub(b.lc_call);
      return (!ka - !kb) || nat(lcClass(ka), lcClass(kb)) || nat(ka ? LCC.subclasses[ka].name : '', kb ? LCC.subclasses[kb].name : '') || SORTS.author(a, b);
    }
  };
  function readRank(r) { return r.year_read === 'read' ? 1 : r.year_read ? +r.year_read : 0; }
  function matches(r) {
    if (view.show === 'review' && !r.needs_review) return false;
    if (view.show === 'read' && !r.year_read) return false;
    if (view.show === 'unread' && r.year_read) return false;
    if (view.show === 'fp' && !r.catalog_id) return false;
    if (!view.q) return true;
    var hay = fold([r.title, r.subtitle, authorName(r), r.other_authors, r.contributors, r.publisher, r.place, r.year, r.edition, r.volume, r.isbn,
      (r.tags || []).join(' '), (r.subjects || []).join(' '), r.notes, readLabel(r.year_read)].concat(Object.keys(r.custom || {}).map(function (k) { return r.custom[k]; })).join(' '));
    return fold(view.q).split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }
  function rowHtml(r, withAuthor) {
    var link = fpLink(r);
    return '<li class="rbrow' + (r.needs_review ? ' check' : '') + '" data-id="' + esc(r.id) + '">' +
      '<button type="button" class="rbmain" data-edit="' + esc(r.id) + '"><span class="t">' + esc(r.title) + (r.volume ? ' <span class="v">' + esc(r.volume) + '</span>' : '') + '</span>' +
      (r.subtitle ? '<span class="st">' + esc(r.subtitle) + '</span>' : '') +
      (withAuthor && authorName(r) ? '<span class="a">' + esc(authorName(r)) + '</span>' : '') +
      '<span class="pub">' + esc([r.publisher, r.place].filter(Boolean).join(', ')) + '</span></button>' +
      '<span class="yr mono">' + esc(r.year || '') + '</span>' +
      '<span class="rd mono">' + (r.year_read ? esc(readLabel(r.year_read)) : '') + '</span>' +
      '<span class="fp">' + (r.needs_review ? '<span class="flag mono">' + esc(T('Check')) + '</span>' : '') +
      (link ? '<a class="act" href="' + esc(link) + '">' + esc(T('On Foggy Press')) + '</a>' : '') + '</span></li>';
  }
  function head(sub) {
    return '<div class="ph"><span class="crumb"><a href="' + BASE + '">' + esc(T('Home')) + '</a></span><h1>' + esc(T('My Real Books')) + '</h1>' +
      '<p class="sub">' + sub + (window.fpHelp ? window.fpHelp('realbooks', T('How My Real Books works'), [
        esc(T('Photograph a book’s title page, and the back of it, and we fill in the details. You check them and add your own notes.')),
        esc(T('The camera opens in this page. Photos aren’t saved to your phone or kept by us: once a book is read, they are gone.')),
        esc(T('Your list is private to your account. Download it any time as a spreadsheet.'))]) : '') + '</p></div>';
  }
  function drawList() {
    var list = rows.filter(matches).sort(function (a, b) { return SORTS[view.sort](a, b) * view.dir; });
    var read = rows.filter(function (r) { return r.year_read; }).length, review = rows.filter(function (r) { return r.needs_review; }).length;
    var sub = esc(rows.length === 1 ? T('{n} book', {n: 1}) : T('{n} books', {n: rows.length})) + (read ? ' · ' + esc(T('{n} read', {n: read})) : '');
    var bar = '<div class="rbbar"><button type="button" class="btn" id="rb-scan">' + esc(T('Scan books')) + '</button>' +
      '<button type="button" class="btn ghost" id="rb-new">' + esc(T('Type one in')) + '</button>' +
      (rows.length ? '<button type="button" class="btn ghost" id="rb-csv">' + esc(T('Download as a spreadsheet')) + '</button>' : '') + '</div>';
    if (!rows.length) {
      box.innerHTML = head(esc(T('A list of the books you own, made by photographing their title pages.'))) + bar +
        '<p class="rbempty">' + esc(T('No books yet. Press “Scan books” and point your phone at a book’s title page.')) + '</p>';
      return;
    }
    var pair = review ? volumePairs() : [];
    var tools = '<div class="rbtools"><input type="search" id="rb-q" placeholder="' + esc(T('Find in my books')) + '" value="' + esc(view.q) + '" aria-label="' + esc(T('Find in my books')) + '">' +
      '<select id="rb-show" aria-label="' + esc(T('Show')) + '">' + [['all', 'All books'], ['review', 'To check'], ['read', 'Read'], ['unread', 'Not read'], ['fp', 'On Foggy Press']]
        .map(function (o) { return '<option value="' + o[0] + '"' + (view.show === o[0] ? ' selected' : '') + '>' + esc(T(o[1])) + '</option>'; }).join('') + '</select></div>' +
      '<div class="sortbar"><span class="eyebrow">' + esc(T('Sort by')) + '</span><div class="seg" role="group" aria-label="' + esc(T('Sort books')) + '">' +
      [['author', 'Author'], ['title', 'Title']].concat(LCC ? [['subject', 'Subject']] : []).concat([['year', 'Year'], ['read', 'Year read'], ['added', 'Added']]).map(function (o) {
        var on = view.sort === o[0];
        return '<button type="button" data-sort="' + o[0] + '" aria-pressed="' + on + '">' + esc(T(o[1])) + (on ? (view.dir > 0 ? ' ↑' : ' ↓') : '') + '</button>';
      }).join('') + '</div></div>';
    var note = review || pair.length ? '<div class="rbcheck">' + (review ? '<p>' + esc(review === 1 ? T('1 book to check: we read it from photos, so please look it over.') : T('{n} books to check: we read them from photos, so please look them over.', {n: review})) + '</p>' +
      '<p class="btns">' + (view.show !== 'review' ? '<button type="button" class="btn sm" id="rb-review">' + esc(T('Show them')) + '</button>' : '') +
      '<button type="button" class="btn ghost sm" id="rb-okall">' + esc(T('They’re all right')) + '</button></p>' : '') +
      pair.map(function (p) {
        return '<p class="rbpair">' + esc(T('“{title}” {a} and {b} look like one set.', {title: p[0].title, a: p[0].volume, b: p[1].volume})) +
          ' <button type="button" class="linkish" data-join="' + esc(p[0].id + ',' + p[1].id) + '">' + esc(T('Make them one record')) + '</button></p>';
      }).join('') + '</div>' : '';
    var body;
    if (!list.length) body = '<p class="rbempty">' + esc(T('No books match.')) + '</p>';
    else if (view.sort === 'author') {
      var groups = [], used = {};
      list.forEach(function (r) {
        var k = authorKey(r);
        if (groups.length && groups[groups.length - 1].k === k) groups[groups.length - 1].rows.push(r); else groups.push({k: k, rows: [r]});
      });
      var cur = null, parts = [];
      groups.forEach(function (g) {
        var r0 = g.rows[0], letter = (fold(r0.author_last || r0.title)[0] || '#').toUpperCase();
        if (letter !== cur) { parts.push('<div class="letter">' + esc(letter) + '</div>'); cur = letter; }
        var id = 'au-' + slug(r0.author_last + ' ' + r0.author_first);
        while (used[id]) id += '-x';
        used[id] = 1;
        var open = view.allOpen || view.q || view.show !== 'all' || groups.length === 1;
        parts.push('<details class="augrp" id="' + esc(id) + '"' + (open ? ' open' : '') + '><summary><span class="n">' + esc(authorName(r0) || T('No author')) + '</span>' +
          '<span class="c mono">' + esc(g.rows.length === 1 ? T('{n} book', {n: 1}) : T('{n} books', {n: g.rows.length})) + '</span></summary>' +
          '<ul class="rbrows">' + g.rows.map(function (r) { return rowHtml(r, false); }).join('') + '</ul></details>');
      });
      body = '<div class="aubar"><span class="mono">' + esc(groups.length === 1 ? T('1 author') : T('{n} authors', {n: groups.length})) + '</span>' +
        '<button type="button" class="chip" id="rb-all">' + esc(T(view.allOpen ? 'Collapse all' : 'Expand all')) + '</button></div>' + parts.join('');
    } else if (view.sort === 'subject') {
      var sg = [], cls = null, out = [];
      list.forEach(function (r) {
        var k = lcSub(r.lc_call);
        if (sg.length && sg[sg.length - 1].k === k) sg[sg.length - 1].rows.push(r); else sg.push({k: k, rows: [r]});
      });
      sg.forEach(function (g) {
        var c = g.k ? lcClass(g.k) : T('No Library of Congress class');
        if (c !== cls) { out.push('<div class="letter">' + esc(c) + '</div>'); cls = c; }
        var open = view.allOpen || view.q || view.show !== 'all' || sg.length === 1;
        out.push('<details class="augrp"' + (open ? ' open' : '') + '><summary><span class="n">' + esc(g.k ? LCC.subclasses[g.k].name : T('Add an LC number to place these')) + '</span>' +
          '<span class="c mono">' + esc(g.rows.length === 1 ? T('{n} book', {n: 1}) : T('{n} books', {n: g.rows.length})) + '</span></summary>' +
          '<ul class="rbrows">' + g.rows.map(function (r) { return rowHtml(r, true); }).join('') + '</ul></details>');
      });
      body = '<div class="aubar"><span class="mono">' + esc(T('{n} subclasses', {n: sg.filter(function (g) { return g.k; }).length})) + '</span>' +
        '<button type="button" class="chip" id="rb-all">' + esc(T(view.allOpen ? 'Collapse all' : 'Expand all')) + '</button></div>' + out.join('');
    } else {
      body = '<ul class="rbrows flat">' + list.map(function (r) { return rowHtml(r, true); }).join('') + '</ul>';
    }
    box.innerHTML = head(sub) + bar + note + tools + body;
    var qi = document.getElementById('rb-q');
    if (qi && view.focus) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); view.focus = false; }
  }
  // Vol. I and Vol. II of one work, both scanned in the last day: offer to keep one record for the set
  function volumePairs() {
    var out = [], seen = {}, since = new Date(Date.now() - 864e5).toISOString();
    rows.filter(function (r) { return r.volume && r.source === 'photo' && String(r.created_at) > since && !/^vols\./i.test(r.volume); }).forEach(function (r) {
      var k = titleKey(r.title) + '|' + fold(r.author_last);
      if (seen[k] && seen[k].volume !== r.volume) out.push([seen[k], r]); else if (!seen[k]) seen[k] = r;
    });
    return out;
  }
  function joinSet(a, b) {
    var vols = [a.volume, b.volume].sort(nat);
    var roman = vols.map(function (v) { return v.replace(/^vol(ume)?\.?\s*/i, ''); });
    var d = {volume: 'Vols. ' + roman.join(', ')};
    if (!a.notes && b.notes) d.notes = b.notes;
    return update(a.id, d).then(function () { return remove(b.id); });
  }

  // ---------- one book: edit, confirm, delete ----------
  var EDIT_FIELDS = [
    ['title', 'Title'], ['subtitle', 'Subtitle'], ['author_first', 'Author’s first names'], ['author_last', 'Author’s last name'],
    ['other_authors', 'Other authors'], ['contributors', 'Editors, translators, illustrators'], ['publisher', 'Publisher'], ['place', 'Place'],
    ['year', 'Year'], ['edition', 'Edition'], ['volume', 'Volume'], ['isbn', 'ISBN'], ['language', 'Language'], ['lc_call', 'Library of Congress number'], ['dewey', 'Dewey number']
  ];
  function yearOptions(v) {
    var now = new Date().getFullYear(), o = '<option value=""' + (!v ? ' selected' : '') + '>' + esc(T('Not read')) + '</option>' +
      '<option value="read"' + (v === 'read' ? ' selected' : '') + '>' + esc(T('Read')) + '</option>';
    for (var y = now; y >= 1971; y--) o += '<option value="' + y + '"' + (v === String(y) ? ' selected' : '') + '>' + y + '</option>';
    if (v && v !== 'read' && +v < 1971) o += '<option value="' + esc(v) + '" selected>' + esc(v) + '</option>';
    return o;
  }
  function drawEdit() {
    var r = view.edit === 'new' ? {title: '', tags: [], subjects: [], custom: {}, year_read: '', unsure: []} : rows.filter(function (x) { return x.id === view.edit; })[0];
    if (!r) { view.edit = null; drawList(); return; }
    var unsure = (r.custom && r.custom['_unsure']) || [];
    var f = function (k, label) {
      var v = r[k] == null ? '' : r[k], wide = k === 'title' || k === 'subtitle' || k === 'contributors' || k === 'publisher';
      return '<div class="fld' + (wide ? ' wide' : '') + (unsure.indexOf(k) >= 0 || (k.indexOf('author') === 0 && unsure.indexOf('author') >= 0) ? ' unsure' : '') + '"><label for="rf-' + k + '">' + esc(T(label)) + '</label>' +
        '<input id="rf-' + k + '" name="' + k + '"' + (k === 'year' ? ' inputmode="numeric" maxlength="4"' : '') + (k === 'title' ? ' required' : '') + ' value="' + esc(v) + '"></div>';
    };
    var custom = fields.map(function (name, i) {
      return '<div class="fld own"><label for="rc-' + i + '">' + esc(name) + '</label><input id="rc-' + i + '" data-own="' + esc(name) + '" value="' + esc((r.custom || {})[name] || '') + '"></div>';
    }).join('');
    var link = r.id ? fpLink(r) : '';
    box.innerHTML = '<div class="ph"><span class="crumb"><a href="#" id="rb-back">' + esc(T('My Real Books')) + '</a></span><h1>' + esc(r.title || T('Add a book')) + '</h1>' +
      (r.needs_review ? '<p class="sub">' + esc(T('We read this from your photos. Fix anything that’s wrong, then press Save.')) + (unsure.length ? ' ' + esc(T('Fields we weren’t sure about are marked.')) : '') + '</p>' : '') + '</div>' +
      '<form class="cform rbform" id="rbform" novalidate>' + EDIT_FIELDS.map(function (x) { return f(x[0], x[1]); }).join('') +
      '<div class="fld"><label for="rf-year_read">' + esc(T('Year read')) + '</label><select id="rf-year_read" name="year_read">' + yearOptions(r.year_read) + '</select></div>' +
      '<div class="fld wide"><label for="rf-tags">' + esc(T('Tags (separate with commas)')) + '</label><input id="rf-tags" name="tags" value="' + esc((r.tags || []).join(', ')) + '"></div>' +
      '<div class="fld wide"><label for="rf-notes">' + esc(T('Notes')) + '</label><textarea id="rf-notes" name="notes" rows="4" maxlength="5000">' + esc(r.notes || '') + '</textarea></div>' +
      custom +
      '<div class="fld wide addown"><label for="rf-newfield">' + esc(T('Add your own field')) + '</label><span class="row"><input id="rf-newfield" maxlength="60" placeholder="' + esc(T('e.g. Purchase price, Signed, Where bought')) + '">' +
      '<button type="button" class="btn ghost sm" id="rb-addfield">' + esc(T('Add')) + '</button></span><span class="formnote">' + esc(T('It appears on all your books.')) + '</span></div>' +
      ((r.subjects || []).length ? '<div class="fld wide"><span class="lbl">' + esc(T('Library of Congress subjects')) + '</span><ul class="subj">' + r.subjects.map(function (s) { return '<li><button type="button" class="linkish" data-subj="' + esc(s) + '">' + esc(s.replace(/\s*--\s*/g, ' › ')) + '</button></li>'; }).join('') + '</ul></div>' : '') +
      (lcSub(r.lc_call) ? '<div class="fld wide"><span class="lbl">' + esc(T('Library of Congress class')) + '</span><p class="lcclass">' + esc(lcClass(lcSub(r.lc_call)) + ' › ' + LCC.subclasses[lcSub(r.lc_call)].name) + '</p></div>' : '') +
      (link ? '<div class="fld wide"><span class="lbl">' + esc(T('On Foggy Press')) + '</span><span><a class="act" href="' + esc(link) + '">' + esc(cat[r.catalog_id].t) + '</a> <button type="button" class="linkish" id="rb-unlink">' + esc(T('Not the same book')) + '</button></span></div>' : '') +
      '<div class="cf-row"><button class="btn" type="submit">' + esc(T('Save')) + '</button> <button type="button" class="btn ghost" id="rb-cancel">' + esc(T('Cancel')) + '</button>' +
      (r.id ? ' <button type="button" class="btn ghost danger" id="rb-del">' + esc(T('Delete this book')) + '</button>' : '') + '</div>' +
      '<p class="formnote" role="status" aria-live="polite">' + esc(msg) + '</p></form>';
    msg = '';
    window.scrollTo(0, 0);
    var form = document.getElementById('rbform');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var el = form.elements, d = {};
      EDIT_FIELDS.forEach(function (x) { d[x[0]] = el[x[0]].value; });
      if (!d.title.trim()) { el.title.focus(); return; }
      d.year_read = el.year_read.value;
      d.notes = el.notes.value;
      d.tags = el.tags.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var c = {};
      Object.keys(r.custom || {}).forEach(function (k) { if (k !== '_unsure' && fields.indexOf(k) < 0) c[k] = r.custom[k]; });
      form.querySelectorAll('[data-own]').forEach(function (i) { if (i.value.trim()) c[i.dataset.own] = i.value.trim().slice(0, 500); });
      d.custom = c;
      d.needs_review = false;
      // a changed title or author: look for the book on Foggy Press again (unless the reader said it isn't the same)
      if (!r.id || d.title !== r.title || d.author_last !== r.author_last) d.catalog_id = catalogMatch(d);
      if (r._unlinked) d.catalog_id = '';
      var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      (r.id ? update(r.id, d) : insert(Object.assign(d, {source: 'typed'}))).then(function () {
        toast(T('Saved.')); view.edit = null; drawList();
      }).catch(function (er) { console.warn(er); btn.disabled = false; msg = T('That didn’t save. Please try again.'); drawEdit(); });
    });
    document.getElementById('rb-back').addEventListener('click', function (e) { e.preventDefault(); view.edit = null; drawList(); });
    document.getElementById('rb-cancel').addEventListener('click', function () { view.edit = null; drawList(); });
    var un = document.getElementById('rb-unlink');
    if (un) un.addEventListener('click', function () { r._unlinked = true; un.parentNode.textContent = T('The link will be removed when you save.'); });
    var del = document.getElementById('rb-del');
    if (del) del.addEventListener('click', function () {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = T('Delete? Press again'); return; }
      remove(r.id).then(function () { toast(T('Deleted.')); view.edit = null; drawList(); });
    });
    document.getElementById('rb-addfield').addEventListener('click', function () {
      var i = document.getElementById('rf-newfield'), name = i.value.trim().slice(0, 60);
      if (!name || name === '_unsure' || fields.indexOf(name) >= 0) { i.focus(); return; }
      q(sb().from('real_book_fields').insert({name: name, position: fields.length})).then(function () {
        // keep what was typed so far in the form
        var keep = {};
        EDIT_FIELDS.concat([['year_read'], ['tags'], ['notes']]).forEach(function (x) { keep[x[0]] = form.elements[x[0]].value; });
        form.querySelectorAll('[data-own]').forEach(function (o) { (r.custom = r.custom || {})[o.dataset.own] = o.value; });
        fields.push(name);
        Object.assign(r, keep, {tags: keep.tags.split(',').map(function (s) { return s.trim(); }).filter(Boolean)});
        drawEdit();
        var n = box.querySelector('[data-own="' + name.replace(/"/g, '\\"') + '"]'); if (n) n.focus();
      }).catch(function () { toast(T('That didn’t save. Please try again.')); });
    });
  }

  // ---------- spreadsheet ----------
  function csv() {
    var cols = EDIT_FIELDS.concat([['subjects', 'Library of Congress subjects'], ['tags', 'Tags'], ['year_read', 'Year read'], ['notes', 'Notes']]);
    var cell = function (v) { v = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v); return /[",\n\r]/.test(v) || /^[=+\-@]/.test(v) ? '"' + v.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"' : v; };
    var head = cols.map(function (c) { return T(c[1]); }).concat(fields, [T('On Foggy Press'), T('Added')]);
    var lines = [head.map(cell).join(',')];
    rows.slice().sort(SORTS.author).forEach(function (r) {
      lines.push(cols.map(function (c) { return cell(c[0] === 'year_read' ? readLabel(r.year_read) : r[c[0]]); })
        .concat(fields.map(function (f) { return cell((r.custom || {})[f]); }), [cell(r.catalog_id ? new URL(fpLink(r), location.href).href : ''), cell(String(r.created_at || '').slice(0, 10))]).join(','));
    });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8'}));
    a.download = 'my-real-books.csv'; document.body.appendChild(a); a.click(); a.remove();
    if (window.fpEvent) window.fpEvent('real books csv');
  }

  // ---------- the camera ----------
  var cam = null;   // {stream, video, books: [{photos: [...], state, n, why}], cur}
  function camOpen() {
    var o = document.createElement('div');
    o.className = 'rbcam'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', T('Scan books'));
    o.innerHTML = '<div class="rbcam-top"><span class="rbcam-count mono" id="cam-count"></span><span class="rbcam-book" id="cam-book"></span><button type="button" class="rbcam-done" id="cam-done">' + esc(T('Done')) + '</button></div>' +
      '<div class="rbcam-view"><video id="cam-video" playsinline muted autoplay></video><div class="rbcam-frame" aria-hidden="true"></div>' +
      '<p class="rbcam-banner" id="cam-banner" aria-hidden="true"></p><p class="rbcam-msg" id="cam-msg" role="status" aria-live="polite"></p><canvas id="cam-canvas" hidden></canvas></div>' +
      '<div class="rbcam-tray" id="cam-tray"></div>' +
      '<div class="rbcam-ctl"><label class="rbcam-file"><input type="file" accept="image/*" multiple id="cam-file"><span>' + esc(T('Photos')) + '</span></label>' +
      '<button type="button" class="rbcam-shutter" id="cam-shot" aria-label="' + esc(T('Take a photo of this page')) + '"></button>' +
      '<button type="button" class="rbcam-next" id="cam-next">' + esc(T('Next book')) + '</button></div>';
    document.body.appendChild(o);
    document.documentElement.classList.add('rbcam-on');
    cam = {el: o, video: o.querySelector('video'), books: [{photos: [], state: 'shooting', pending: 0, no: 1}], cur: 0, busy: 0, nos: 1};
    drawTray(); camHint();
    o.querySelector('#cam-shot').addEventListener('click', shoot);
    o.querySelector('#cam-next').addEventListener('click', nextBook);
    o.querySelector('#cam-done').addEventListener('click', camClose);
    o.querySelector('#cam-file').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    o.querySelector('#cam-tray').addEventListener('click', trayClick);
    o.addEventListener('keydown', function (e) { if (e.key === 'Escape') camClose(); });
    o.querySelector('#cam-done').focus();
    // how many scans are left today (shown only when it is getting low), and whether scanning is open
    q(sb().rpc('scan_status', {p_tz: tz()})).then(function (s) {
      if (s && !s.open) say(T('Scanning is paused for now. You can still type books in.'));
      else if (s && s.left != null && s.left <= 20) say(T('{n} scans left today.', {n: s.left}));
    }).catch(function () {});
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { noCamera(); return; }
    camStart();
    document.addEventListener('visibilitychange', camWake);
  }
  function camStart() {
    var c = cam;
    if (!c || c.starting) return;
    c.starting = true;
    navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 2560}, height: {ideal: 1920}}}).then(function (s) {
      c.starting = false;
      if (cam !== c) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      if (c.stream) c.stream.getTracks().forEach(function (t) { t.stop(); });
      c.stream = s; c.video.srcObject = s;
      // phones stop the camera when the screen sleeps or another app takes it: start it again when that happens
      s.getVideoTracks().forEach(function (t) { t.addEventListener('ended', function () { if (cam === c && c.stream === s && !document.hidden) camStart(); }); });
      var p = c.video.play(); if (p && p.catch) p.catch(function () {});
    }).catch(function (e) { c.starting = false; console.warn('camera', e); if (cam === c && !c.stream) noCamera(e && e.name === 'NotAllowedError'); });
  }
  // back from the lock screen or another app: the old picture is frozen or black, so get a fresh one
  function camWake() {
    if (!cam || document.hidden || cam.el.classList.contains('nocam')) return;
    var t = cam.stream && cam.stream.getVideoTracks()[0];
    if (!t || t.readyState === 'ended' || t.muted) camStart();
    else { var p = cam.video.play(); if (p && p.catch) p.catch(function () {}); }
  }
  function noCamera(denied) {
    cam.el.classList.add('nocam');
    say(denied ? T('The camera is blocked for this site. Allow it in your browser’s settings, or choose photos instead.') : T('No camera here. Choose photos of the pages instead.'));
  }
  function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }
  function say(s) { if (cam) cam.el.querySelector('#cam-msg').textContent = s || ''; }
  function camHint() {
    var b = cam.books[cam.cur], n = b.photos.length + b.pending;
    cam.el.querySelector('#cam-book').textContent = T('Book {n}', {n: b.no});
    cam.el.querySelector('#cam-next').classList.toggle('off', !n);
    if (b.pending && !b.photos.length) return;
    say(!b.photos.length ? T('Photograph the title page. Then the back of it, if it has the date or publisher.') :
      b.photos.length < MAX_PAGES ? T('Page {n} of this book. Add another page, or press Next book.', {n: b.photos.length}) : T('That’s 4 pages. Press Next book.'));
  }
  function camClose() {
    if (!cam) return;
    var c = cam;
    var bad = c.books.filter(function (b) { return b.state === 'error'; }).length;
    if (bad && !c.warned) {
      c.warned = true;
      say(bad === 1 ? T('1 book didn’t scan. Press Try again or Retake, or Done again to leave it.') : T('{n} books didn’t scan. Press Try again or Retake, or Done again to leave them.', {n: bad}));
      return;
    }
    var pending = c.books.some(function (b) { return b.state === 'shooting' && (b.photos.length || b.pending); });
    if (pending) nextBook();
    document.removeEventListener('visibilitychange', camWake);
    if (c.stream) c.stream.getTracks().forEach(function (t) { t.stop(); });
    var waiting = c.books.filter(function (b) { return b.state === 'reading' || b.state === 'queued'; }).length;
    // books still being read finish in the background and appear in the list
    c.el.remove(); document.documentElement.classList.remove('rbcam-on');
    c.closed = true; cam = null;
    drawList();
    if (waiting) toast(waiting === 1 ? T('1 book is still being read. It will appear here in a moment.') : T('{n} books are still being read. They will appear here in a moment.', {n: waiting}));
    document.getElementById('rb-scan') && document.getElementById('rb-scan').focus();
  }
  // a frame from the camera, shrunk so its long side is at most LONG pixels: plenty to read type, small to send
  function grab(src, w, h) { return encode(frame(src, w, h)); }
  // copy the picture into a canvas: quick, so the photo is the page that was in view when the shutter was pressed
  function frame(src, w, h) {
    var s = Math.min(1, LONG / Math.max(w, h)), cw = Math.round(w * s), ch = Math.round(h * s);
    var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    cv.getContext('2d').drawImage(src, 0, 0, cw, ch);
    return cv;
  }
  // make the JPEG to send and the little picture for the tray: the slow part
  function encode(cv) {
    var cw = cv.width, ch = cv.height;
    // too dark to read? (the average brightness of a small copy)
    var sm = document.createElement('canvas'); sm.width = 32; sm.height = Math.max(1, Math.round(32 * ch / cw));
    var sx = sm.getContext('2d'); sx.drawImage(cv, 0, 0, sm.width, sm.height);
    var px = sx.getImageData(0, 0, sm.width, sm.height).data, sum = 0;
    for (var i = 0; i < px.length; i += 4) sum += px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
    var dark = sum / (px.length / 4) < 35;
    var data = cv.toDataURL('image/jpeg', QUALITY);
    var th = document.createElement('canvas'), ts = 96 / Math.max(cw, ch); th.width = Math.round(cw * ts); th.height = Math.round(ch * ts);
    th.getContext('2d').drawImage(cv, 0, 0, th.width, th.height);
    return {data: data.split(',')[1], thumb: th.toDataURL('image/jpeg', 0.7), dark: dark};
  }
  // The flash and buzz come first, the moment the shutter is pressed; the photo is made just after, so the screen
  // never sits frozen. It belongs to the book that was current when the shutter was pressed, even if Next book is
  // pressed before it is ready, and that book isn't sent until all its photos are made.
  function shoot() {
    var c = cam, v = c && c.video;
    if (!v || !v.videoWidth || v.readyState < 2) { say(T('The camera isn’t ready yet.')); camWake(); return; }
    var b = c.books[c.cur];
    if (b.photos.length + b.pending >= MAX_PAGES) { say(T('That’s 4 pages. Press Next book.')); return; }
    var cv = frame(v, v.videoWidth, v.videoHeight);
    b.pending++;
    c.el.classList.add('flash'); setTimeout(function () { c.el.classList.remove('flash'); }, 150);
    if (navigator.vibrate) navigator.vibrate(15);
    camHint();
    setTimeout(function () {
      var p = encode(cv);
      b.pending--;
      if (p.dark) {
        if (cam === c) say(T('Too dark to read. Turn on a light, or move closer to a window.'));
        // the book was already sent on with only this photo: take it back off the list
        var at = c.books.indexOf(b);
        if (b.state === 'queued' && !b.photos.length && !b.pending && at >= 0) { c.books.splice(at, 1); if (c.cur > at) c.cur--; }
      } else b.photos.push(p);
      if (cam === c) { drawTray(); camHint(); }
      pump(c);
    }, 30);
  }
  function addFiles(files) {
    var list = Array.prototype.slice.call(files || []).filter(function (f) { return /^image\//.test(f.type); });
    var b = cam.books[cam.cur];
    var next = function () {
      var f = list.shift();
      if (!f) { drawTray(); camHint(); return; }
      if (b.photos.length >= MAX_PAGES) { nextBook(); b = cam.books[cam.cur]; }
      var img = new Image(), u = URL.createObjectURL(f);
      img.onload = function () { b.photos.push(grab(img, img.naturalWidth, img.naturalHeight)); URL.revokeObjectURL(u); next(); };
      img.onerror = function () { URL.revokeObjectURL(u); next(); };
      img.src = u;
    };
    next();
  }
  function nextBook() {
    var b = cam.books[cam.cur];
    if (!b.photos.length && !b.pending) { say(T('Photograph a page first.')); return; }
    b.state = 'queued';
    cam.books.push({photos: [], state: 'shooting', pending: 0, no: ++cam.nos}); cam.cur = cam.books.length - 1;
    if (navigator.vibrate) navigator.vibrate([10, 60, 10]);
    banner(T('Book {n} is being read. Now the next book.', {n: b.no}));
    pump(cam); drawTray(); camHint();
  }
  // a big, short-lived note across the middle of the picture, so a press of Next book can't be missed
  function banner(s) {
    var el = cam.el.querySelector('#cam-banner');
    el.textContent = s; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(cam.bannerT); cam.bannerT = setTimeout(function () { el.classList.remove('show'); }, 1600);
  }
  function drawTray() {
    if (!cam) return;
    var t = cam.el.querySelector('#cam-tray');
    var done = cam.books.filter(function (b) { return b.state === 'done'; }).reduce(function (n, b) { return n + (b.n || 1); }, 0);
    cam.el.querySelector('#cam-count').textContent = done ? (done === 1 ? T('1 book added') : T('{n} books added', {n: done})) : '';
    t.innerHTML = cam.books.map(function (b, i) {
      if (!b.photos.length && !b.pending && b.state === 'shooting' && i !== cam.cur) return '';
      var st = {shooting: T('This book'), queued: T('Waiting'), reading: T('Reading…'), done: b.n > 1 ? T('{n} books', {n: b.n}) : (b.title || T('Added')), error: b.why || T('Didn’t work')}[b.state];
      var pics = b.photos.map(function (p, j) {
        return '<img src="' + p.thumb + '" alt="">' + (b.state === 'shooting' ? '<button type="button" class="x" data-drop="' + i + ',' + j + '" aria-label="' + esc(T('Remove this photo')) + '">×</button>' : '');
      }).join('') + new Array(b.pending + 1).join('<span class="ph"></span>');
      return '<div class="tb st-' + b.state + (i === cam.cur ? ' cur' : '') + '"><span class="pics">' + (pics || '<span class="ph empty"></span>') + '</span><span class="lab">' + esc(T('Book {n}', {n: b.no}) + ' · ' + st) + '</span>' +
        (b.state === 'error' ? '<span class="acts"><button type="button" data-retry="' + i + '">' + esc(T('Try again')) + '</button><button type="button" data-reshoot="' + i + '">' + esc(T('Retake')) + '</button></span>' : '') + '</div>';
    }).join('');
    t.scrollLeft = t.scrollWidth;
  }
  function trayClick(e) {
    var x = e.target.closest('[data-drop]'), r = e.target.closest('[data-retry]'), s = e.target.closest('[data-reshoot]');
    if (x) { var ij = x.dataset.drop.split(','); cam.books[+ij[0]].photos.splice(+ij[1], 1); drawTray(); camHint(); return; }
    if (r) { cam.books[+r.dataset.retry].state = 'queued'; pump(cam); drawTray(); }
    if (s) {
      // shoot this book again: drop its photos and make it the current one
      var i = +s.dataset.reshoot, cur = cam.books[cam.cur];
      if (!cur.photos.length) cam.books.splice(cam.cur, 1);
      var b = cam.books.splice(i, 1)[0]; b.photos = []; b.state = 'shooting'; b.why = ''; b.pending = 0;
      cam.books.push(b); cam.cur = cam.books.length - 1; drawTray(); camHint();
    }
  }
  // send waiting books to the scan function, two at a time; each one read is saved straight away
  function pump(c) {
    while (c.busy < 2) {
      var b = c.books.filter(function (x) { return x.state === 'queued' && !x.pending; })[0];
      if (!b) return;
      c.busy++; b.state = 'reading';
      scan(b).then(function (b) { return function (res) { b.state = 'done'; b.n = res.n; b.title = res.title; b.photos.forEach(function (p) { p.data = null; }); }; }(b),
        function (b) { return function (e) { b.state = 'error'; b.why = e.message; if (e.stop) c.books.forEach(function (x) { if (x.state === 'queued') { x.state = 'error'; x.why = e.message; } }); }; }(b))
        .then(function (b) { return function () {
          c.busy--;
          if (!c.closed) drawTray();
          else {
            if (!view.edit) drawList();
            if (b.state === 'error') { c.lost = (c.lost || 0) + 1; clearTimeout(c.lostT); c.lostT = setTimeout(function () { toast(c.lost === 1 ? T('1 book couldn’t be read. Please scan it again.') : T('{n} books couldn’t be read. Please scan them again.', {n: c.lost})); c.lost = 0; }, 800); }
          }
          pump(c);
        }; }(b));
    }
  }
  var WHY = {limit: 'That’s all the scans for today. Please come back tomorrow.', minute: 'Slow down a little: wait a minute, then try again.',
    paused: 'Scanning is paused for now. You can still type books in.', signin: 'Please sign in again.', busy: 'Too busy just now. Try again in a minute.',
    size: 'That photo is too large.', type: 'That isn’t a photo.', failed: 'Something went wrong. Please try again.'};
  function scan(b) {
    return acc.token().then(function (tok) {
      if (!tok) throw Object.assign(new Error(T(WHY.signin)), {stop: true});
      return fetch(FN, {method: 'POST', headers: {'apikey': KEY, 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'},
        body: JSON.stringify({photos: b.photos.map(function (p) { return p.data; }), tz: tz()})});
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw Object.assign(new Error(T(WHY[j.error] || WHY.failed)), {stop: j.error === 'limit' || j.error === 'paused' || j.error === 'signin'});
        if (j.not_a_book || !j.books || !j.books.length) throw new Error(T('No title page found. Retake it?'));
        var split = j.books.length > 1;
        return Promise.all(j.books.map(function (bk) { return insert(fromScan(bk, split)); })).then(function (saved) {
          if (window.fpEvent) window.fpEvent('real books scan');
          return {n: saved.length, title: saved[0].title};
        });
      });
    }, function (e) { if (e.stop) throw e; throw new Error(T(navigator.onLine === false ? 'No connection. Try again when you’re back online.' : WHY.failed)); });
  }
  // Ask the reader to check a book only when the reading is in doubt: no title, a printed field the model wasn't
  // sure of, or one set of photos that turned out to hold more than one book. A class or subject the model judged
  // (old books have no CIP block) doesn't count: it's marked in the form but isn't a misreading.
  var JUDGED = ['lc_call', 'subjects', 'dewey', 'language'];
  function doubtful(bk, split) {
    return split || !bk.title || (bk.unsure || []).some(function (f) { return JUDGED.indexOf(f) < 0; });
  }
  function fromScan(bk, split) {
    var d = {};
    ['title', 'subtitle', 'author_last', 'author_first', 'other_authors', 'contributors', 'publisher', 'place', 'year', 'edition', 'volume', 'isbn', 'language', 'lc_call', 'dewey']
      .forEach(function (k) { d[k] = bk[k] == null ? '' : bk[k]; });
    d.subjects = bk.subjects || []; d.tags = bk.tags || [];
    d.notes = bk.inscription ? T('Inscribed: {text}', {text: bk.inscription}) : '';
    d.custom = bk.unsure && bk.unsure.length ? {_unsure: bk.unsure} : {};
    d.catalog_id = catalogMatch(d);
    d.needs_review = doubtful(bk, split); d.source = 'photo';
    return d;
  }

  // ---------- events ----------
  box.addEventListener('click', function (e) {
    var t = e.target;
    var ed = t.closest('[data-edit]');
    if (ed) { view.edit = ed.dataset.edit; drawEdit(); return; }
    var sj = t.closest('[data-subj]');
    if (sj) { view.edit = null; view.q = sj.dataset.subj; view.show = 'all'; drawList(); window.scrollTo(0, 0); return; }
    var so = t.closest('[data-sort]');
    if (so) { var k = so.dataset.sort; view.dir = view.sort === k ? -view.dir : 1; view.sort = k; drawList(); return; }
    var jn = t.closest('[data-join]');
    if (jn) { var ids = jn.dataset.join.split(','), a = rows.filter(function (r) { return r.id === ids[0]; })[0], b = rows.filter(function (r) { return r.id === ids[1]; })[0];
      if (a && b) joinSet(a, b).then(drawList).catch(function () { toast(T('That didn’t save. Please try again.')); }); return; }
    switch (t.id) {
      case 'rb-scan': camOpen(); break;
      case 'rb-new': view.edit = 'new'; drawEdit(); break;
      case 'rb-csv': csv(); break;
      case 'rb-review': view.show = 'review'; drawList(); break;
      case 'rb-okall':
        q(sb().from('real_books').update({needs_review: false}).eq('needs_review', true)).then(function () {
          rows.forEach(function (r) { r.needs_review = false; }); if (view.show === 'review') view.show = 'all'; drawList();
        }); break;
      case 'rb-all': view.allOpen = !view.allOpen; box.querySelectorAll('details.augrp').forEach(function (d) { d.open = view.allOpen; });
        t.textContent = T(view.allOpen ? 'Collapse all' : 'Expand all'); break;
    }
  });
  box.addEventListener('input', function (e) { if (e.target.id === 'rb-q') { view.q = e.target.value; view.focus = true; drawList(); } });
  box.addEventListener('change', function (e) { if (e.target.id === 'rb-show') { view.show = e.target.value; drawList(); } });
  document.addEventListener('fp-lang', function () { if (rows) { if (view.edit) drawEdit(); else drawList(); } });

  function gate() {
    box.innerHTML = head(esc(T('A list of the books you own, made by photographing their title pages.'))) +
      '<div class="gate"><h2>' + esc(T('Sign in to start your list')) + '</h2>' +
      '<a class="btn" href="' + BASE + 'account/?next=real-books">' + esc(T('Sign in with your email')) + '</a>' +
      '<p class="fine">' + esc(T('No password: we email you a link.')) + ' <a href="' + BASE + 'privacy/">' + esc(T('Privacy')) + '</a></p></div>';
  }
  acc.ready().then(function () {
    if (!acc.signedIn()) { gate(); return; }
    return Promise.all([acc.books().then(function (c) { cat = c; catIndex = null; }).catch(function () {}), load(), loadLcc()]).then(function () {
      if (/[?&]scan=1/.test(location.search)) camOpen();
      drawList();
    });
  }).catch(function (e) {
    console.warn('My Real Books:', e);
    box.innerHTML = head('') + '<p class="rbempty">' + esc(T('Something went wrong. Please try again.')) + '</p>';
  });
  window.fpRealBooks = {match: function (r) { return catalogMatch(r); }};
})();
