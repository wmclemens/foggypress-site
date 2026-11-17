// Ask Foggy Press: questions about the books, answered by an AI model from the catalog and the book texts
// (supabase/functions/ask). Places:
//  - the home page (#ask with data-home): the chat at the top, above the featured collections.
//  - /ask/: the Ask page, with starter questions, the conversation and past chats (#past).
//  - read-online pages: the "Ask about this book" drawer.
//  - 1911 Britannica article pages (body data-article): the same drawer, "Ask about this article".
// Turned on by <meta name="fp-ask" content="<function url>"> (the build writes it when ASK_ON is set) and needs
// assets/account.js. Signed-in readers ask with their account (daily limit per account, past chats kept).
// Anyone else asks as a guest once the function allows guests (it has the Turnstile secret): the page gets a
// Turnstile token (the invisible "are you human" check), the function answers with a pass good for a few hours,
// and the guest's daily limit is per internet address. Every answer can get a thumbs up or down.
(function () {
  var meta = document.querySelector('meta[name="fp-ask"]'), acc = window.fpAccount;
  if (!meta || !acc) return;
  var FN = meta.content, KEY = (document.querySelector('meta[name="fp-account"]').content.split('|')[1] || '');
  var T = window.fpT || function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); };
  var TS_KEY = (document.querySelector('meta[name="fp-account"]').content.split('|')[2] || '');
  var me = document.currentScript && document.currentScript.src;
  var BASE = me ? me.replace(/assets\/ask\.js(\?.*)?$/, '') : '/';
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  var UP = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 7v7H2.5V7H5Zm0 0 2.6-5c1 0 1.6.7 1.4 1.7L8.6 6h4c.8 0 1.4.8 1.2 1.6l-1.2 5.2c-.2.7-.8 1.2-1.5 1.2H5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  var DOWN = UP.replace('aria-hidden="true"', 'aria-hidden="true" style="transform:scaleY(-1)"');
  var SEND = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var STARTERS = [['Find me a book', 'Something like Treasure Island, but true'], ['Explain a book', 'What is Walden really about?'],
    ['Find a passage', 'Where does Ishmael say why he goes to sea?'], ['Compare', 'How do the Grant biographies differ?']];
  var BOOK_STARTERS = ['What is this book about?', 'Who are the main characters?', 'What should I know before I start?'];
  var ARTICLE_STARTERS = ['Sum up this article', 'What has changed since 1911?', 'Explain the hardest part simply'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  function inline(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>'); }
  function ev(name) { if (window.fpEvent) window.fpEvent(name); }
  function readLink(b, extra) { return (b.rd || (BASE + 'read/' + encodeURIComponent(b.id) + '/')) + (extra || ''); }

  // ---------- state ----------
  var page = document.getElementById('ask'), home = !!(page && page.hasAttribute('data-home')), bookId = document.body.dataset.book || '';
  var articleId = document.body.dataset.article || '', articleTitle = document.body.dataset.title || '', here = bookId || (articleId && 'eb:' + articleId);
  var cat = {}, msgs = [], chatId = '', chatKey = '', status = null, busy = false, signed = false, guests = false, drawer = null;
  var PLACE = home ? 'home' : page ? 'ask' : articleId ? 'article' : 'book';
  function canAsk() { return signed || guests; }

  // ---------- talking to the ask function ----------
  // the guest pass (from the function, after the Turnstile check) is kept in this browser until it runs out
  function getPass() {
    try { var p = localStorage.getItem('fp-ask-pass') || ''; return +p.split('.')[0] > Date.now() / 1000 + 60 ? p : ''; } catch (e) { return ''; }
  }
  function setPass(p) { try { if (p) localStorage.setItem('fp-ask-pass', p); else localStorage.removeItem('fp-ask-pass'); } catch (e) {} }
  // Turnstile: usually invisible; when Cloudflare wants a click, the box shows at the bottom of the screen
  var tsBox = null, tsId = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    return new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true;
      s.onload = function () { ok(); }; s.onerror = bad; document.head.appendChild(s);
    });
  }
  function human() {
    if (!TS_KEY) return Promise.reject(new Error('no turnstile'));
    return loadTurnstile().then(function () {
      if (!tsBox) {
        tsBox = document.createElement('div'); tsBox.className = 'askts'; tsBox.hidden = true;
        tsBox.innerHTML = '<span>' + esc(T('Checking that you’re a person…')) + '</span><div></div>';
        document.body.appendChild(tsBox);
      }
      if (tsId != null) { try { window.turnstile.remove(tsId); } catch (e) {} tsId = null; }
      return new Promise(function (ok, bad) {
        var done = false, end = function (f, v) { if (done) return; done = true; tsBox.hidden = true; f(v); };
        setTimeout(function () { end(bad, new Error('timeout')); }, 60000);
        tsId = window.turnstile.render(tsBox.lastChild, {sitekey: TS_KEY, appearance: 'interaction-only', action: 'ask',
          callback: function (t) { end(ok, t); }, 'error-callback': function () { end(bad, new Error('turnstile')); },
          'before-interactive-callback': function () { tsBox.hidden = false; }, 'after-interactive-callback': function () { tsBox.hidden = true; }});
      });
    });
  }
  function post(body, headers) {
    return fetch(FN, {method: 'POST', headers: Object.assign({'apikey': KEY, 'Content-Type': 'application/json'}, headers || {}), body: JSON.stringify(body)})
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return {status: r.status, body: b}; }); })
      .catch(function () { return {status: 0, body: {error: 'network'}}; });
  }
  // one call to the function, as the reader (their token) or as a guest (the pass, or a fresh Turnstile token)
  function call(body, fresh) {
    if (signed) return acc.token().then(function (tok) {
      if (!tok) return {status: 401, body: {error: 'signin'}};
      return post(body, {'Authorization': 'Bearer ' + tok});
    }, function () { return {status: 0, body: {error: 'network'}}; });
    var pass = fresh ? '' : getPass();
    return (pass ? Promise.resolve('') : human()).then(function (ts) {
      return post(Object.assign({}, body, pass ? {pass: pass} : {ts: ts}));
    }, function () { return {status: 403, body: {error: 'check'}}; }).then(function (r) {
      if (r.body && r.body.pass) setPass(r.body.pass);
      if (r.status === 403 && r.body.error === 'check' && pass && !fresh) { setPass(''); return call(body, true); }   // the pass ran out or the address changed
      return r;
    });
  }
  function ask(question) {
    return call({question: question, chat_id: chatId || undefined, chat_key: chatKey || undefined, book_id: bookId || undefined,
      article_id: articleId || undefined, place: PLACE, tz: TZ, lang: window.fpLang ? window.fpLang() : 'en'});
  }
  function loadStatus() {
    var sb = acc.client();
    if (sb && acc.signedIn()) return sb.rpc('ask_status', {p_tz: TZ}).then(function (r) { status = r.error ? null : r.data; return status; });
    // signed out: may guests ask, and how many questions are left from here today
    return post({op: 'status', tz: TZ}).then(function (r) {
      guests = r.status === 200 && !!r.body.guests && !!TS_KEY;
      status = guests ? r.body : null;
      return status;
    });
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
    if (b.t === 'request') {
      return '<p class="reqlink"><a class="btn ghost sm" href="' + BASE + 'request/?title=' + encodeURIComponent(b.title) + (b.author ? '&author=' + encodeURIComponent(b.author) : '') + '">' +
        esc(T('Request this book')) + ': ' + esc(b.title) + ' →</a></p>';
    }
    if (b.t === 'article') {
      return '<ul class="recs cards"><li class="rec"><a class="main" href="' + esc(b.url) + '"><span class="t">' + esc(b.title) + '</span><span class="a">' + esc(T('Encyclopædia Britannica, 1911')) + '</span>' +
        (b.why ? '<span class="d">' + inline(b.why) + '</span>' : '') + '</a><span class="m mono">' + esc(T('Vol. {v}', {v: b.v})) + (b.p ? ', p. ' + esc(b.p) : '') + '</span>' +
        '<span class="acts"><a class="act" href="' + esc(b.url) + '">' + esc(T('Read article')) + '</a></span></li></ul>';
    }
    if (b.t === 'aquote') {
      var hereA = articleId && b.id === articleId, at = b.url + '?q=' + encodeURIComponent(b.q) + (b.ch ? '#' + encodeURIComponent(b.ch) : '');
      return '<blockquote class="qt">' + esc(b.text) + '</blockquote><div class="src"><span>' + esc(hereA ? T('This article') : b.title + ' · ' + T('Britannica 1911')) + '</span>' +
        '<a href="' + esc(at) + '" data-ask-go>' + esc(hereA ? T('Show in article') : T('Open at this passage')) + ' →</a></div>';
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
  function rateHtml(m) {
    if (!m.mid) return '';
    var b = function (v, icon, label) { return '<button type="button" class="thumb" data-ask-rate="' + v + '" aria-pressed="' + (m.rating === v) + '" aria-label="' + esc(T(label)) + '" title="' + esc(T(label)) + '">' + icon + '</button>'; };
    return '<div class="fb" data-mid="' + m.mid + '"><span>' + esc(T('Helpful?')) + '</span>' + b(1, UP, 'Good answer') + b(-1, DOWN, 'Not a good answer') +
      (m.rating === -1 && !m.noted ? '<form class="fbnote" data-ask-note><input maxlength="500" placeholder="' + esc(T('What was wrong? (optional)')) + '" aria-label="' + esc(T('What was wrong? (optional)')) + '"><button type="submit" class="linkish">' + esc(T('Send')) + '</button></form>' : '') +
      (m.noted || m.rating === 1 ? '<span class="fbthanks">' + esc(T('Thanks for telling us.')) + '</span>' : '') + '</div>';
  }
  function convoHtml() {
    return msgs.map(function (m) {
      if (m.role === 'user') return '<div class="askq">' + esc(m.content) + '</div>';
      if (m.wait) return '<div class="ans"><span class="by">Foggy Press</span><span class="typing" role="status" aria-label="' + esc(T('Thinking')) + '"><i></i><i></i><i></i></span></div>';
      if (m.err) return '<div class="ans"><p class="bad">' + esc(T(m.err)) + '</p></div>';
      return answerHtml(m.blocks || []).replace(/<\/div>$/, rateHtml(m) + '</div>');
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
    if (status.guestsFull) return '<div class="limit"><b>' + esc(T('Many people are asking today.')) + '</b><span>' + esc(T('Sign in to keep asking, or come back tomorrow.')) + ' <a href="' + BASE + 'account/?next=ask">' + esc(T('Sign in')) + ' →</a></span></div>';
    if (status.left <= 0) return '<div class="limit"><b>' + esc(T('That’s {n} questions for today.', {n: status.limit})) + '</b><span>' + esc(T('Ask again tomorrow (resets at midnight). Search and reading are unlimited.')) + '</span></div>';
    return '';
  }
  function composerHtml(ph) {
    var off = !canAsk() || blocked() || busy;
    return '<div class="composer"><form class="cbox" data-ask-form><textarea rows="1" maxlength="1000" placeholder="' + esc(!canAsk() ? T('Sign in to ask a question') : blocked() ? T('Back tomorrow') : ph) + '" aria-label="' + esc(T('Your question')) + '"' + (off && !busy ? ' disabled' : '') + '></textarea>' +
      '<button class="send" type="submit" aria-label="' + esc(T('Send')) + '"' + (off ? ' disabled' : '') + '>' + SEND + '</button></form>' +
      '<div class="cmeta"><span data-ask-left>' + esc(canAsk() ? leftText() : T('Sign in to ask')) + '</span><span>' + esc(T('AI answers · quotes link to the text so you can check them')) + '</span></div>' +
      (!signed && guests ? '<p class="cguest">' + esc(T('No account needed.')) + ' <a href="' + BASE + 'account/?next=ask">' + esc(T('Sign in to keep your chats and ask more each day.')) + '</a></p>' : '') + '</div>';
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
    if (home) return drawHome();
    var past = location.hash === '#past';
    var head = '<div class="ask-h"><h1>' + esc(T('Ask Foggy Press')) + '</h1>' + (signed ? '<div class="who">' +
      (past ? '<a href="#">' + esc(T('Back to the chat')) + '</a>' : '<a href="#past">' + esc(T('Past chats')) + '</a>') +
      '<button type="button" class="linkish" data-ask-new>' + esc(T('New chat')) + '</button></div>' : '') + '</div>';
    if (past && signed) { page.innerHTML = head + '<div id="past"><p class="sub">' + esc(T('Loading…')) + '</p></div>'; drawPast(); return; }
    var lede = '<p class="lede">' + esc(T('Ask for a book recommendation, an explanation of a book, or help finding a passage. Answers come only from the {n} books on Foggy Press, and every quote links to the page it came from.', {n: Object.keys(cat).length})) + '</p>';
    page.innerHTML = head + (msgs.length ? '' : lede + startersHtml()) + (canAsk() ? '' : gateHtml()) +
      '<div class="convo" aria-live="polite">' + convoHtml() + '</div>' + noticeHtml() + composerHtml(T('Ask about a book, an author or a subject, or get recommendations'));
    acc.star(page);
    wireComposer(page);
  }
  // the home page: the chat at the top, above the featured collections
  function drawHome() {
    var links = (signed ? '<a href="' + BASE + 'ask/#past">' + esc(T('Past chats')) + '</a>' : '') +
      (msgs.length ? '<button type="button" class="linkish" data-ask-new>' + esc(T('New chat')) + '</button>' : '<a href="' + BASE + 'ask/">' + esc(T('Open the Ask page')) + ' →</a>');
    page.innerHTML = '<div class="sec-h"><h2>' + esc(T('Ask Foggy Press')) + '</h2><div class="who">' + links + '</div></div>' +
      // no starter questions here (Will, 17 Nov 2026: they took up a lot of space); the Ask page keeps them
      (msgs.length ? '' : '<p class="lede">' + esc(T('Ask for a book recommendation, an explanation of a book, or help finding a passage. Answers come only from the {n} books on Foggy Press, and every quote links to the page it came from.', {n: Object.keys(cat).length.toLocaleString(window.fpLang ? window.fpLang() : undefined)})) + '</p>') +
      (canAsk() ? '' : gateHtml()) + '<div class="convo" aria-live="polite">' + convoHtml() + '</div>' + noticeHtml() + composerHtml(T('Ask about a book, an author or a subject, or get recommendations'));
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
    var get = function (cols) { return sb.from('chat_messages').select(cols).eq('chat_id', id).order('id', {ascending: true}).limit(200); };
    return get('id,role,content,blocks,rating').then(function (r) { return r.error ? get('id,role,content,blocks') : r; }).then(function (r) {
      if (r.error || !r.data || !r.data.length) return false;
      chatId = id; chatKey = '';
      msgs = r.data.map(function (m) { return m.role === 'user' ? {role: 'user', content: m.content} : {role: 'assistant', blocks: m.blocks, mid: m.id, rating: m.rating || 0}; });
      return true;
    });
  }

  // ---------- the drawer on read pages ----------
  function drawDrawer() {
    var b = articleId ? {t: articleTitle} : (cat[bookId] || {t: ''});
    var label = articleId ? T('Ask about this article') : T('Ask about this book');
    if (!drawer) {
      drawer = document.createElement('aside');
      drawer.className = 'drawer'; drawer.id = 'askdrawer'; drawer.hidden = true;
      document.body.appendChild(drawer);
    }
    drawer.setAttribute('aria-label', label);
    var body = msgs.length ? convoHtml() : '<div class="dstart">' + (articleId ? ARTICLE_STARTERS : BOOK_STARTERS).map(function (q) { return '<button type="button" data-ask-q="' + esc(T(q)) + '">' + esc(T(q)) + '</button>'; }).join('') + '</div>';
    drawer.innerHTML = '<div class="dh"><div><b>' + esc(label) + '</b><span>' + esc(articleId ? T('Answers come from the 1911 text') : T('Answers come from this book’s text')) + '</span></div>' +
      '<span class="dacts">' + (msgs.length ? '<button type="button" class="linkish" data-ask-new>' + esc(T('New chat')) + '</button>' : '') +
      '<button class="x" type="button" data-ask-close aria-label="' + esc(T('Close')) + '">×</button></span></div>' +
      '<div class="db" aria-live="polite">' + (canAsk() ? '' : gateHtml()) + body + noticeHtml() + '</div>' + composerHtml(T('Ask about {title}', {title: b.t}));
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
  // (a guest's chat isn't in an account, so its messages are kept with it for this browser tab)
  function keep() { try { sessionStorage.setItem('fp-ask-' + here, JSON.stringify({c: chatId, k: chatKey, o: drawer && !drawer.hidden, m: signed ? undefined : msgs.filter(function (m) { return !m.wait && !m.err; }).slice(-20)})); } catch (e) {} }
  function kept() { try { return JSON.parse(sessionStorage.getItem('fp-ask-' + here) || 'null'); } catch (e) { return null; } }

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
    if (!canAsk()) { location.href = BASE + 'account/?next=ask'; return; }
    if (blocked()) return;
    busy = true;
    msgs.push({role: 'user', content: q.slice(0, 1000)}, {role: 'assistant', wait: true});
    redraw();
    scrollEnd();
    ev((articleId ? 'ask: article' : bookId ? 'ask: book' : home ? 'ask: home' : 'ask') + (signed ? '' : ' (guest)'));
    ask(q.slice(0, 1000)).then(function (r) {
      busy = false;
      var last = msgs[msgs.length - 1], b = r.body || {};
      last.wait = false;
      if (r.status === 200) {
        last.blocks = b.blocks || []; last.mid = b.message_id || 0; last.rating = 0; chatId = b.chat_id || chatId; chatKey = b.chat_key || chatKey;
        if (status) status.left = b.left;
        if (page && !home && signed) try { history.replaceState(null, '', '?c=' + chatId); } catch (e) {}
        keep();
      } else if (r.status === 401) {
        signed = false; guests = false; msgs.splice(-2, 2);
      } else if (r.status === 429) {
        msgs.splice(-2, 2);
        status = {limit: b.limit || (status && status.limit) || 20, left: 0, open: b.error !== 'paused', guestsFull: b.error === 'guests'};
      } else {
        last.err = r.status === 503 ? 'Ask is busy right now. Please try again in a minute.' : r.status === 0 ? 'You seem to be offline. Please try again.' :
          r.status === 403 ? 'We couldn’t check this browser. Please try again.' : 'Something went wrong. Please try again.';
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
    var t = e.target.closest && e.target.closest('[data-ask-q],[data-ask-new],[data-ask-close],[data-ask-del],[data-ask-delall],#rbask,[data-ask-go],[data-ask-rate]');
    if (!t) return;
    if (t.hasAttribute('data-ask-rate')) { rate(+t.closest('.fb').dataset.mid, +t.getAttribute('data-ask-rate')); return; }
    if (t.id === 'rbask') { setDrawer(!drawer || drawer.hidden); return; }
    if (t.hasAttribute('data-ask-go')) { keep(); return; }   // follow the link; the drawer comes back after the page loads
    if (t.hasAttribute('data-ask-close')) { setDrawer(false); return; }
    if (t.hasAttribute('data-ask-q')) { submit(t.getAttribute('data-ask-q')); return; }
    if (t.hasAttribute('data-ask-new')) {
      msgs = []; chatId = ''; chatKey = ''; keep();
      if (page && !home) { try { history.replaceState(null, '', location.pathname); } catch (er) {} if (location.hash) location.hash = ''; }
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
  // thumbs up or down: pressing the same thumb again takes it back
  function rate(mid, v, note) {
    var m = msgs.filter(function (x) { return x.mid === mid; })[0];
    if (!m || !chatId) return;
    var was = [m.rating, m.noted], next = note != null ? -1 : m.rating === v ? 0 : v;
    m.rating = next; if (note != null) m.noted = true; else m.noted = false;
    redraw();
    if (note == null && next) ev(next > 0 ? 'ask: thumbs up' : 'ask: thumbs down');
    call({op: 'rate', chat_id: chatId, chat_key: chatKey || undefined, message_id: mid, rating: next, note: note || undefined, tz: TZ}).then(function (r) {
      if (r.status === 200) return;
      m.rating = was[0]; m.noted = was[1]; redraw();
      acc.toast(T('That didn’t save. Please try again.'));
    });
    if (next === -1 && note == null) setTimeout(function () { var i = document.querySelector('.fb[data-mid="' + mid + '"] input'); if (i) i.focus(); }, 0);
  }
  document.addEventListener('submit', function (e) {
    var f = e.target.closest && e.target.closest('[data-ask-note]');
    if (!f) return;
    e.preventDefault();
    var v = f.querySelector('input').value.trim();
    var mid = +f.closest('.fb').dataset.mid;
    if (!v) { var m = msgs.filter(function (x) { return x.mid === mid; })[0]; if (m) { m.noted = true; redraw(); } return; }
    rate(mid, -1, v.slice(0, 500));
  });
  addEventListener('hashchange', function () { if (page && !home) drawPage(); });
  document.addEventListener('fp-lang', redraw);

  // ---------- start ----------
  // read pages load the sign-in library and the catalog only when the drawer is first opened (or was left open)
  var booted = null;
  function boot() {
    if (!booted) booted = (acc.hasSession() || (page && !home) ? acc.ready() : Promise.resolve()).then(function () {
      signed = acc.signedIn();
      return Promise.all([acc.books().then(function (c) { cat = c; }), loadStatus()]);
    });
    return booted;
  }
  if (page) {
    boot().then(function () {
      var c = home ? '' : new URLSearchParams(location.search).get('c');
      return (signed && c ? openChat(c) : Promise.resolve()).then(drawPage);
    });
  } else if (here) {
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
      if (k && k.o) boot().then(function () { if (!signed && k.c && k.k && k.m) { chatId = k.c; chatKey = k.k; msgs = k.m; } return signed && k.c ? openChat(k.c) : null; }).then(function () { drawDrawer(); setDrawer(true); });
    }
  }
})();
