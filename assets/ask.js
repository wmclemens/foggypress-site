// Ask Foggy Press: questions about the books, answered by an AI model from the catalog and the book texts
// (supabase/functions/ask). Two places:
//  - /ask/: the Ask page, with starter questions, the conversation and past chats (#past).
//  - read-online pages: the "Ask about this book" drawer.
// Turned on by <meta name="fp-ask" content="<function url>"> (the build writes it when ASK_ON is set) and needs
// assets/account.js: asking needs a signed-in reader, so the daily limit is per person.
(function () {
  var meta = document.querySelector('meta[name="fp-ask"]'), acc = window.fpAccount;
  if (!meta || !acc) return;
  var FN = meta.content, KEY = (document.querySelector('meta[name="fp-account"]').content.split('|')[1] || '');
  var T = window.fpT || function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); };
  var me = document.currentScript && document.currentScript.src;
  var BASE = me ? me.replace(/assets\/ask\.js(\?.*)?$/, '') : '/';
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  var SEND = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var STARTERS = [['Find me a book', 'Something like Treasure Island, but true'], ['Explain a book', 'What is Walden really about?'],
    ['Find a passage', 'Where does Ishmael say why he goes to sea?'], ['Compare', 'How do the Grant biographies differ?']];
  var BOOK_STARTERS = ['What is this book about?', 'Who are the main characters?', 'What should I know before I start?'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  function inline(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>'); }
  function ev(name) { if (window.fpEvent) window.fpEvent(name); }
  function readLink(b, extra) { return (b.rd || (BASE + 'read/' + encodeURIComponent(b.id) + '/')) + (extra || ''); }

  // ---------- state ----------
  var page = document.getElementById('ask'), bookId = document.body.dataset.book || '';
  var cat = {}, msgs = [], chatId = '', status = null, busy = false, signed = false, drawer = null;

  // ---------- talking to the ask function ----------
  function ask(question) {
    return acc.token().then(function (tok) {
      if (!tok) return {status: 401, body: {error: 'signin'}};
      return fetch(FN, {method: 'POST', headers: {'Authorization': 'Bearer ' + tok, 'apikey': KEY, 'Content-Type': 'application/json'},
        body: JSON.stringify({question: question, chat_id: chatId || undefined, book_id: bookId || undefined, tz: TZ, lang: window.fpLang ? window.fpLang() : 'en'})})
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return {status: r.status, body: b}; }); });
    }).catch(function () { return {status: 0, body: {error: 'network'}}; });
  }
  function loadStatus() {
    var sb = acc.client();
    if (!sb || !acc.signedIn()) return Promise.resolve(null);
    return sb.rpc('ask_status', {p_tz: TZ}).then(function (r) { status = r.error ? null : r.data; return status; });
  }

  // ---------- drawing ----------
  function blockHtml(b) {
    var bk = cat[b.id];
    if (b.t === 'p') return '<p>' + inline(b.text) + '</p>';
    if (b.t === 'book') {
      if (!bk) return '';
      var acts = (bk.read ? '<a class="act" href="' + esc(readLink(bk)) + '">' + esc(T('Read online')) + '</a>' : '') +
        '<a class="act" href="' + esc(bk.pdf) + '" data-goatcounter-click="pdf-' + esc(bk.id) + '" data-goatcounter-title="' + esc(bk.t) + '">' + esc(T('Print this book')) + '</a>';
      return '<li class="rec" data-id="' + esc(bk.id) + '"><a class="main" href="' + esc(bk.read ? readLink(bk) : bk.pdf) + '"><span class="t">' + esc(bk.t) + '</span><span class="a">' + esc(bk.a) +
        (bk.tr ? ' · ' + esc(T('tr.')) + ' ' + esc(bk.tr) : '') + '</span>' + (b.why ? '<span class="d">' + inline(b.why) + '</span>' : '') + '</a>' +
        '<span class="m mono">' + esc(bk.d || '') + '</span><span class="acts">' + acts + '</span></li>';
    }
    if (b.t === 'quote') {
      var here = bookId && b.id === bookId, where = readLink(bk || {id: b.id}, '?q=' + encodeURIComponent(b.q) + (b.ch ? '#' + encodeURIComponent(b.ch) : ''));
      return '<blockquote class="qt">' + esc(b.text) + '</blockquote><div class="src"><span>' + (here ? '' : esc(bk ? bk.t : b.id) + ' · ') + esc(b.head) + '</span>' +
        '<a href="' + esc(where) + '" data-ask-go>' + esc(here ? T('Show in book') : T('Open at this passage')) + ' →</a></div>';
    }
    return '';
  }
  function answerHtml(blocks) {
    var out = '', cards = '';
    blocks.forEach(function (b) {
      if (b.t === 'book') { cards += blockHtml(b); return; }
      if (cards) { out += '<ul class="recs cards">' + cards + '</ul>'; cards = ''; }
      out += blockHtml(b);
    });
    if (cards) out += '<ul class="recs cards">' + cards + '</ul>';
    return '<div class="ans"><span class="by">Foggy Press</span>' + out + '</div>';
  }
  function convoHtml() {
    return msgs.map(function (m) {
      if (m.role === 'user') return '<div class="askq">' + esc(m.content) + '</div>';
      if (m.wait) return '<div class="ans"><span class="by">Foggy Press</span><span class="typing" role="status" aria-label="' + esc(T('Thinking')) + '"><i></i><i></i><i></i></span></div>';
      if (m.err) return '<div class="ans"><p class="bad">' + esc(T(m.err)) + '</p></div>';
      return answerHtml(m.blocks || []);
    }).join('');
  }
  function leftText() {
    if (!status) return '';
    return status.open === false ? T('Ask is paused for now') : T('{n} of {m} questions left today', {n: status.left, m: status.limit});
  }
  function blocked() { return status && (status.open === false || status.left <= 0); }
  function noticeHtml() {
    if (!status) return '';
    if (status.open === false) return '<div class="limit"><b>' + esc(T('Ask is paused for the rest of the month.')) + '</b><span>' + esc(T('It has reached its monthly budget. Search and reading still work.')) + '</span></div>';
    if (status.left <= 0) return '<div class="limit"><b>' + esc(T('That’s {n} questions for today.', {n: status.limit})) + '</b><span>' + esc(T('Ask again tomorrow (resets at midnight). Search and reading are unlimited.')) + '</span></div>';
    return '';
  }
  function composerHtml(ph) {
    var off = !signed || blocked() || busy;
    return '<div class="composer"><form class="cbox" data-ask-form><textarea rows="1" maxlength="1000" placeholder="' + esc(!signed ? T('Sign in to ask a question') : blocked() ? T('Back tomorrow') : ph) + '" aria-label="' + esc(T('Your question')) + '"' + (off && !busy ? ' disabled' : '') + '></textarea>' +
      '<button class="send" type="submit" aria-label="' + esc(T('Send')) + '"' + (off ? ' disabled' : '') + '>' + SEND + '</button></form>' +
      '<div class="cmeta"><span data-ask-left>' + esc(signed ? leftText() : T('Sign in to ask')) + '</span><span>' + esc(T('AI answers · quotes link to the text so you can check them')) + '</span></div></div>';
  }
  function gateHtml() {
    return '<div class="gate"><h2>' + esc(T('Sign in to ask')) + '</h2><p>' + esc(T('Asking is free. Signing in keeps it fair: everyone gets {n} questions a day.', {n: 20})) + '</p>' +
      '<a class="btn" href="' + BASE + 'account/?next=ask">' + esc(T('Sign in with your email')) + '</a>' +
      '<p class="fine">' + esc(T('No password: we email you a link.')) + ' <a href="' + BASE + 'privacy/">' + esc(T('Privacy')) + '</a></p></div>';
  }
  function startersHtml() {
    return '<div class="starters">' + STARTERS.map(function (s) {
      return '<button class="starter" type="button" data-ask-q="' + esc(T(s[1])) + '"><b>' + esc(T(s[0])) + '</b><span>' + esc(T(s[1])) + '</span></button>';
    }).join('') + '</div>';
  }

  // ---------- the Ask page ----------
  function drawPage() {
    var past = location.hash === '#past';
    var head = '<div class="ask-h"><h1>' + esc(T('Ask Foggy Press')) + '</h1>' + (signed ? '<div class="who">' +
      (past ? '<a href="#">' + esc(T('Back to the chat')) + '</a>' : '<a href="#past">' + esc(T('Past chats')) + '</a>') +
      '<button type="button" class="linkish" data-ask-new>' + esc(T('New chat')) + '</button></div>' : '') + '</div>';
    if (past && signed) { page.innerHTML = head + '<div id="past"><p class="sub">' + esc(T('Loading…')) + '</p></div>'; drawPast(); return; }
    var lede = '<p class="lede">' + esc(T('Ask for a book recommendation, an explanation of a book, or help finding a passage. Answers come only from the {n} books on Foggy Press, and every quote links to the page it came from.', {n: Object.keys(cat).length})) + '</p>';
    page.innerHTML = head + (msgs.length ? '' : lede + startersHtml()) + (signed ? '' : gateHtml()) +
      '<div class="convo" aria-live="polite">' + convoHtml() + '</div>' + noticeHtml() + composerHtml(T('Ask about a book, an author or a subject'));
    acc.star(page);
    wireComposer(page);
  }
  function drawPast() {
    var box = document.getElementById('past'), sb = acc.client();
    sb.from('chats').select('id,title,updated_at').order('updated_at', {ascending: false}).limit(200).then(function (r) {
      if (!box.isConnected) return;
      var rows = r.data || [];
      if (!rows.length) { box.innerHTML = '<p class="sub">' + esc(T('No past chats yet.')) + '</p>'; return; }
      box.innerHTML = '<div class="sec-h"><h2>' + esc(T('Past chats')) + '</h2><button type="button" class="linkish" data-ask-delall>' + esc(T('Delete all')) + '</button></div><ul class="chatlist">' +
        rows.map(function (c) {
          return '<li><a class="t" href="?c=' + esc(c.id) + '">' + esc(c.title || T('Untitled chat')) + '</a><span class="d mono">' + esc(when(c.updated_at)) + '</span>' +
            '<button type="button" data-ask-del="' + esc(c.id) + '">' + esc(T('Delete')) + '</button></li>';
        }).join('') + '</ul><p class="fine">' + esc(T('Chats are kept in your account until you delete them.')) + '</p>';
    });
  }
  function when(ts) {
    var d = new Date(ts), now = new Date(), day = 864e5, t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (d.getTime() >= t0) return T('Today');
    if (d.getTime() >= t0 - day) return T('Yesterday');
    try { return d.toLocaleDateString(window.fpLang ? window.fpLang() : undefined, {day: 'numeric', month: 'short'}); } catch (e) { return d.toDateString(); }
  }
  function openChat(id) {
    var sb = acc.client();
    return sb.from('chat_messages').select('role,content,blocks').eq('chat_id', id).order('id', {ascending: true}).limit(200).then(function (r) {
      if (r.error || !r.data || !r.data.length) return false;
      chatId = id;
      msgs = r.data.map(function (m) { return m.role === 'user' ? {role: 'user', content: m.content} : {role: 'assistant', blocks: m.blocks}; });
      return true;
    });
  }

  // ---------- the drawer on read pages ----------
  function drawDrawer() {
    var b = cat[bookId] || {t: ''};
    if (!drawer) {
      drawer = document.createElement('aside');
      drawer.className = 'drawer'; drawer.id = 'askdrawer'; drawer.hidden = true;
      document.body.appendChild(drawer);
    }
    drawer.setAttribute('aria-label', T('Ask about this book'));
    var body = msgs.length ? convoHtml() : '<div class="dstart">' + BOOK_STARTERS.map(function (q) { return '<button type="button" data-ask-q="' + esc(T(q)) + '">' + esc(T(q)) + '</button>'; }).join('') + '</div>';
    drawer.innerHTML = '<div class="dh"><div><b>' + esc(T('Ask about this book')) + '</b><span>' + esc(T('Answers come from this book’s text')) + '</span></div>' +
      '<span class="dacts">' + (msgs.length ? '<button type="button" class="linkish" data-ask-new>' + esc(T('New chat')) + '</button>' : '') +
      '<button class="x" type="button" data-ask-close aria-label="' + esc(T('Close')) + '">×</button></span></div>' +
      '<div class="db" aria-live="polite">' + (signed ? '' : gateHtml()) + body + noticeHtml() + '</div>' + composerHtml(T('Ask about {title}', {title: b.t}));
    acc.star(drawer);
    wireComposer(drawer);
    var db = drawer.querySelector('.db'); db.scrollTop = db.scrollHeight;
  }
  function setDrawer(open) {
    if (open && !drawer) drawDrawer();
    if (!drawer) return;
    drawer.hidden = !open;
    document.body.classList.toggle('asking', open);
    var btn = document.getElementById('rbask'); if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    keep();
    if (open) { var ta = drawer.querySelector('textarea'); if (ta && !ta.disabled && matchMedia('(min-width: 760px)').matches) ta.focus(); }
  }
  // the drawer stays open, on the same chat, when a quote link reloads the page
  function keep() { try { sessionStorage.setItem('fp-ask-' + bookId, JSON.stringify({c: chatId, o: drawer && !drawer.hidden})); } catch (e) {} }
  function kept() { try { return JSON.parse(sessionStorage.getItem('fp-ask-' + bookId) || 'null'); } catch (e) { return null; } }

  function redraw() { if (page) drawPage(); else if (drawer) drawDrawer(); }

  // ---------- asking ----------
  function wireComposer(root) {
    var form = root.querySelector('[data-ask-form]'); if (!form) return;
    var ta = form.querySelector('textarea');
    function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 144) + 'px'; }
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : submit(ta.value); } });
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(ta.value); });
  }
  function submit(text) {
    var q = String(text || '').trim();
    if (!q || busy) return;
    if (!signed) { location.href = BASE + 'account/?next=ask'; return; }
    if (blocked()) return;
    busy = true;
    msgs.push({role: 'user', content: q.slice(0, 1000)}, {role: 'assistant', wait: true});
    redraw();
    scrollEnd();
    ev(bookId ? 'ask: book' : 'ask');
    ask(q.slice(0, 1000)).then(function (r) {
      busy = false;
      var last = msgs[msgs.length - 1], b = r.body || {};
      last.wait = false;
      if (r.status === 200) {
        last.blocks = b.blocks || []; chatId = b.chat_id || chatId;
        if (status) status.left = b.left;
        if (page) try { history.replaceState(null, '', '?c=' + chatId); } catch (e) {}
        keep();
      } else if (r.status === 401) {
        signed = false; msgs.splice(-2, 2);
      } else if (r.status === 429) {
        msgs.splice(-2, 2);
        status = {limit: b.limit || (status && status.limit) || 20, left: 0, open: b.error !== 'paused'};
      } else {
        last.err = r.status === 503 ? 'Ask is busy right now. Please try again in a minute.' : r.status === 0 ? 'You seem to be offline. Please try again.' : 'Something went wrong. Please try again.';
        if (b.left != null && status) status.left = b.left;
      }
      redraw();
      scrollEnd();
    });
  }
  function scrollEnd() {
    var c = page ? page.querySelector('.convo') : drawer && drawer.querySelector('.db');
    if (!c) return;
    if (page) { var last = c.lastElementChild; if (last) last.scrollIntoView({block: 'nearest'}); } else c.scrollTop = c.scrollHeight;
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-ask-q],[data-ask-new],[data-ask-close],[data-ask-del],[data-ask-delall],#rbask,[data-ask-go]');
    if (!t) return;
    if (t.id === 'rbask') { setDrawer(!drawer || drawer.hidden); return; }
    if (t.hasAttribute('data-ask-go')) { keep(); return; }   // follow the link; the drawer comes back after the page loads
    if (t.hasAttribute('data-ask-close')) { setDrawer(false); return; }
    if (t.hasAttribute('data-ask-q')) { submit(t.getAttribute('data-ask-q')); return; }
    if (t.hasAttribute('data-ask-new')) {
      msgs = []; chatId = ''; keep();
      if (page) { try { history.replaceState(null, '', location.pathname); } catch (er) {} if (location.hash) location.hash = ''; }
      redraw(); return;
    }
    var sb = acc.client();
    if (t.hasAttribute('data-ask-del') || t.hasAttribute('data-ask-delall')) {
      // two presses: the first asks "Sure?"
      if (!t.dataset.armed) { t.dataset.armed = '1'; t.dataset.was = t.textContent; t.textContent = T('Delete? Press again'); setTimeout(function () { if (t.isConnected) { delete t.dataset.armed; t.textContent = t.dataset.was; } }, 4000); return; }
      var id = t.getAttribute('data-ask-del');
      var req = id ? sb.from('chats').delete().eq('id', id) : sb.from('chats').delete().not('id', 'is', null);
      req.then(function (r) {
        if (r.error) { acc.toast(T('That didn’t save. Please try again.')); return; }
        if (!id || id === chatId) { msgs = []; chatId = ''; }
        ev(id ? 'ask: delete chat' : 'ask: delete all chats');
        drawPage();
      });
    }
  });
  addEventListener('hashchange', function () { if (page) drawPage(); });
  document.addEventListener('fp-lang', redraw);

  // ---------- start ----------
  // read pages load the sign-in library and the catalog only when the drawer is first opened (or was left open)
  var booted = null;
  function boot() {
    if (!booted) booted = (page || acc.hasSession() ? acc.ready() : Promise.resolve()).then(function () {
      signed = acc.signedIn();
      return Promise.all([acc.books().then(function (c) { cat = c; }), loadStatus()]);
    });
    return booted;
  }
  if (page) {
    boot().then(function () {
      var c = new URLSearchParams(location.search).get('c');
      return (signed && c ? openChat(c) : Promise.resolve()).then(drawPage);
    });
  } else if (bookId) {
    var btn = document.getElementById('rbask');
    if (btn) {
      btn.hidden = false;
      btn.addEventListener('click', function (e) {
        if (drawer) return;
        e.stopPropagation();
        btn.disabled = true;
        boot().then(function () { btn.disabled = false; drawDrawer(); setDrawer(true); });
      });
      var k = kept();
      if (k && k.o) boot().then(function () { return signed && k.c ? openChat(k.c) : null; }).then(function () { drawDrawer(); setDrawer(true); });
    }
  }
})();
