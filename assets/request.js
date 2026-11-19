// Build me a book (/request/): a signed-in reader asks for a public-domain book that isn't on Foggy Press yet,
// and follows what happened to their requests. Requests go to the database (supabase/schema.sql request_book);
// a nightly job in the books repository builds them from approved sources and emails the reader.
(function () {
  var box = document.getElementById('request'), acc = window.fpAccount;
  if (!box || !acc) return;
  var T = window.fpT || function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); };
  var me = document.currentScript && document.currentScript.src;
  var BASE = me ? me.replace(/assets\/request\.js(\?.*)?$/, '') : '/';
  var params = new URLSearchParams(location.search);
  var draft = {title: params.get('title') || '', author: params.get('author') || '', url: '', note: ''};
  var cat = {}, rows = null, msg = '', bad = false;
  var STATUS = {new: 'Waiting', building: 'Being built', published: 'On the site', declined: 'Not possible', not_found: 'Not found in our sources'};
  var WHY = {title: 'Please give the book’s title.', source: 'That link isn’t one of our sources. Leave it empty, or use one of the sites listed.',
    duplicate: 'You’ve already asked for that book. It’s on its way.', day: 'That’s 3 requests for today. Please ask again tomorrow.',
    open: 'You have 10 requests waiting. Please wait for some to finish.'};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  function readLink(b) { return b.read ? (b.rd || BASE + 'read/' + encodeURIComponent(b.id) + '/') : b.pdf; }
  function when(ts) { try { return new Date(ts).toLocaleDateString(window.fpLang ? window.fpLang() : undefined, {day: 'numeric', month: 'short'}); } catch (e) { return ''; } }

  function load() {
    var sb = acc.client();
    if (!sb || !acc.signedIn()) { rows = []; return Promise.resolve(); }
    return sb.from('book_requests').select('id,title,author,status,book_id,reason,created_at').order('created_at', {ascending: false}).limit(100)
      .then(function (r) { rows = r.error ? [] : r.data; });
  }

  function draw() {
    var signed = acc.signedIn();
    var head = '<div class="ph"><span class="crumb"><a href="' + BASE + '">' + esc(T('Home')) + '</a></span><h1>' + esc(T('Request a book')) + '</h1>' +
      // less busy (19 Nov 2026): one line here; how requests work is in the "?" beside it
      '<p class="sub">' + esc(T('Ask for a public-domain book that isn’t on Foggy Press yet.')) +
      (window.fpHelp ? window.fpHelp('request', T('How requests work'), [
        esc(T('We look for it in our approved sources of public-domain books.')),
        esc(T('If we find an edition we can publish, we build it and email you when it’s on the site, usually within a few days. If we can’t, we email you why.')),
        esc(T('We email you when your book is ready, so requests need an account.'))]) : '') + '</p></div>';
    if (!signed) {
      box.innerHTML = head + '<div class="gate"><h2>' + esc(T('Sign in to request a book')) + '</h2>' +
        '<a class="btn" href="' + BASE + 'account/?next=request' + esc(location.search ? '&' + location.search.slice(1) : '') + '">' + esc(T('Sign in with your email')) + '</a>' +
        '<p class="fine">' + esc(T('No password: we email you a link.')) + ' <a href="' + BASE + 'privacy/">' + esc(T('Privacy')) + '</a></p></div>';
      return;
    }
    var list = rows && rows.length ? '<section class="sec"><div class="sec-h"><h2>' + esc(T('Your requests')) + '</h2></div><ul class="reqs">' + rows.map(function (r) {
      var b = r.status === 'published' && cat[r.book_id];
      return '<li class="req st-' + esc(r.status) + '"><span class="t">' + (b ? '<a href="' + esc(readLink(b)) + '">' + esc(r.title) + '</a>' : esc(r.title)) + '</span>' +
        '<span class="a">' + esc(r.author) + '</span><span class="st mono">' + esc(T(STATUS[r.status] || r.status)) + ' · ' + esc(when(r.created_at)) + '</span>' +
        (r.reason ? '<span class="why">' + esc(r.reason) + '</span>' : '') +
        (r.status === 'new' ? '<button type="button" class="linkish" data-withdraw="' + esc(r.id) + '">' + esc(T('Withdraw')) + '</button>' : '') + '</li>';
    }).join('') + '</ul></section>' : '';
    box.innerHTML = head +
      '<form class="cform reqform" id="reqform" novalidate>' +
      '<div class="fld"><label for="rq-title">' + esc(T('Title')) + '</label><input id="rq-title" name="title" required maxlength="300" value="' + esc(draft.title) + '"></div>' +
      '<div class="fld"><label for="rq-author">' + esc(T('Author')) + '</label><input id="rq-author" name="author" maxlength="200" value="' + esc(draft.author) + '"></div>' +
      '<div class="fld"><label for="rq-url">' + esc(T('Link (optional)')) + '</label><input id="rq-url" name="url" type="url" maxlength="500" inputmode="url" placeholder="https://www.gutenberg.org/ebooks/…" value="' + esc(draft.url) + '">' +
      '<span class="formnote">' + esc(T('A page for the book on Project Gutenberg, HathiTrust, the Internet Archive, Wikisource, Standard Ebooks, Faded Page or Google Books.')) + '</span></div>' +
      '<div class="fld"><label for="rq-note">' + esc(T('Note (optional)')) + '</label><textarea id="rq-note" name="note" maxlength="500" rows="3" placeholder="' + esc(T('Which edition or translation, if it matters')) + '">' + esc(draft.note) + '</textarea></div>' +
      '<div class="cf-row"><button class="btn" type="submit">' + esc(T('Request this book')) + '</button></div>' +
      '<p class="formnote' + (msg ? (bad ? ' bad' : ' ok') : '') + '" role="status" aria-live="polite">' + esc(msg) + '</p></form>' + list;
    var f = document.getElementById('reqform');
    f.addEventListener('input', function () { var el = f.elements; draft = {title: el.title.value, author: el.author.value, url: el.url.value, note: el.note.value}; });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = f.querySelector('button[type=submit]');
      if (draft.title.trim().length < 2) { msg = T(WHY.title); bad = true; draw(); return; }
      btn.disabled = true;
      acc.client().rpc('request_book', {p_title: draft.title, p_author: draft.author, p_url: draft.url.trim(), p_note: draft.note}).then(function (r) {
        var d = r.data || {};
        if (r.error || !d.ok) { msg = T(WHY[d.why] || 'Something went wrong. Please try again.'); bad = true; draw(); return; }
        if (window.fpEvent) window.fpEvent('request a book');
        msg = T('Thanks. We’ll email you when “{title}” is on the site, or if we can’t add it.', {title: draft.title.trim()}); bad = false;
        draft = {title: '', author: '', url: '', note: ''};
        try { history.replaceState(null, '', location.pathname); } catch (er) {}
        load().then(draw);
      });
    });
  }

  box.addEventListener('click', function (e) {
    var w = e.target.closest('[data-withdraw]'); if (!w) return;
    if (!w.dataset.armed) { w.dataset.armed = '1'; w.textContent = T('Withdraw? Press again'); return; }
    acc.client().from('book_requests').delete().eq('id', w.dataset.withdraw).then(function () { load().then(draw); });
  });
  document.addEventListener('fp-lang', function () { if (rows) draw(); });

  acc.ready().then(function () { return Promise.all([acc.books().then(function (c) { cat = c; }), load()]); }).then(draw);
})();
