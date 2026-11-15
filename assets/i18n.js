// Foggy Press language menu: translates the site's own words (not the books) into the languages below.
//  - Phrases live in /assets/i18n/<code>.json as {"English phrase": "translation"}. Counted phrases use {n}
//    (and {m}); a translation may be {"one": ..., "few": ..., "many": ..., "other": ...}, picked with the
//    language's plural rules. "@about" holds the About page's text as HTML.
//  - The page marks what to translate: data-t (the element's English text is the phrase, or data-t names it),
//    data-n / data-m (the numbers in a counted phrase), data-t-attr="placeholder,aria-label,title" (attributes),
//    data-t-html="about" (a block of HTML).
//  - Other scripts call fpT(phrase, {n: 3}) and listen for the "fp-lang" event to redraw.
// The reader's choice is remembered (localStorage "fp-lang"); with no choice yet, the browser's language is used
// when it is on the list. The last phrase file is kept too, so pages change language without a flash of English.
(function () {
  var LANGS = [
    ['en', 'English'], ['zh', '中文'], ['hi', 'हिन्दी'], ['es', 'Español'], ['ar', 'العربية', 'rtl'], ['bn', 'বাংলা'],
    ['pt', 'Português'], ['ru', 'Русский'], ['id', 'Bahasa Indonesia'], ['fr', 'Français'], ['ja', '日本語'],
    ['sw', 'Kiswahili'], ['mr', 'मराठी'], ['te', 'తెలుగు']
  ];
  var VERSION = '1';
  var me = document.currentScript && document.currentScript.src;
  var BASE = me ? me.replace(/assets\/i18n\.js(\?.*)?$/, '') : '/';
  var root = document.documentElement, known = {};
  LANGS.forEach(function (l) { known[l[0]] = l; });

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  // settings handed over in the link from foggypress.com (assets/site.js), for pages on files.foggypress.com
  try {
    var fp = new URLSearchParams(location.search).get('fp');
    if (fp) {
      var parts = fp.split('.');
      if (known[parts[0]]) set('fp-lang', parts[0]);
      if (parts[1] === 'dark' || parts[1] === 'light') { set('fp-theme', parts[1]); root.dataset.theme = parts[1]; }
      var clean = new URL(location.href); clean.searchParams.delete('fp');
      history.replaceState(null, '', clean.toString());
    }
  } catch (e) {}
  var lang = get('fp-lang');
  if (!known[lang]) {
    lang = 'en';
    (navigator.languages || [navigator.language || 'en']).some(function (l) {
      var c = String(l).toLowerCase().split('-')[0];
      if (known[c]) { lang = c; return true; }
      return false;
    });
  }
  var dict = {};
  if (lang !== 'en') {
    try { var c = JSON.parse(get('fp-dict') || 'null'); if (c && c.lang === lang && c.v === VERSION) dict = c.d; } catch (e) {}
  }
  var plural = null;
  try { plural = new Intl.PluralRules(lang); } catch (e) {}

  function fill(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      return vars && vars[k] != null ? (typeof vars[k] === 'number' ? vars[k].toLocaleString(lang + '-u-nu-latn') : vars[k]) : m;
    });
  }
  // the translation of an English phrase, with its numbers filled in
  function T(s, vars) {
    var t = lang === 'en' ? null : dict[s];
    if (t && typeof t === 'object') t = t[plural && vars && vars.n != null ? plural.select(vars.n) : 'other'] || t.other;
    return fill(t || s, vars);
  }
  window.fpT = T;
  window.fpLang = function () { return lang; };

  // a web font for scripts that Geist doesn't cover, so every device shows them well
  var FONTS = {hi: 'Noto Sans Devanagari', mr: 'Noto Sans Devanagari', bn: 'Noto Sans Bengali', te: 'Noto Sans Telugu',
    ar: 'Noto Sans Arabic', zh: 'Noto Sans SC', ja: 'Noto Sans JP'};
  function font() {
    var f = FONTS[lang];
    if (!f) { root.style.removeProperty('--sans'); return; }
    var id = 'fp-font-' + lang;
    if (!document.getElementById(id)) {
      var l = document.createElement('link');
      l.id = id; l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=' + f.replace(/ /g, '+') + ':wght@300;400;500;600&display=swap';
      document.head.appendChild(l);
    }
    root.style.setProperty('--sans', '"Geist","' + f + '","Helvetica Neue",Helvetica,Arial,sans-serif');
  }

  var ATTRS = ['placeholder', 'aria-label', 'title'];
  function apply(scope) {
    root.lang = lang === 'zh' ? 'zh-Hans' : lang;
    root.dir = (known[lang] || [])[2] || 'ltr';
    font();
    (scope || document).querySelectorAll('[data-t]').forEach(function (el) {
      if (el.dataset.en == null) el.dataset.en = el.dataset.t || el.textContent.trim();
      var vars = el.dataset.n != null ? {n: +el.dataset.n, m: el.dataset.m != null ? +el.dataset.m : undefined} : null;
      el.textContent = T(el.dataset.en, vars);
    });
    (scope || document).querySelectorAll('[data-t-attr]').forEach(function (el) {
      el.dataset.tAttr.split(',').forEach(function (a) {
        a = a.trim(); if (ATTRS.indexOf(a) < 0) return;
        var keep = 'en' + a.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); }).replace(/^./, function (c) { return c.toUpperCase(); });
        if (el.dataset[keep] == null) el.dataset[keep] = el.getAttribute(a) || '';
        el.setAttribute(a, T(el.dataset[keep]));
      });
    });
    (scope || document).querySelectorAll('[data-t-html]').forEach(function (el) {
      if (el.dataset.enHtml == null) el.dataset.enHtml = el.innerHTML;
      var h = lang !== 'en' && dict['@' + el.dataset.tHtml];
      el.innerHTML = h || el.dataset.enHtml;
      if (h) el.setAttribute('lang', root.lang); else el.removeAttribute('lang');
    });
    // book titles, authors and descriptions stay in English
    var rtl = root.dir === 'rtl';
    document.querySelectorAll('article.book, .rec .t, .rec .a, .rec .d, .ft h3, .ft li, .ct .nm, h1:not([data-t]), .bsearch input').forEach(function (el) {
      if (lang !== 'en') el.setAttribute('lang', 'en'); else el.removeAttribute('lang');
      // English text in a right-to-left page keeps its own direction, so its punctuation stays in place
      if (rtl && !el.matches('.bsearch input')) el.setAttribute('dir', 'ltr'); else if (!rtl) el.removeAttribute('dir');
    });
    document.querySelectorAll('.langpick select').forEach(function (s) {
      if (s.options.length < LANGS.length) {
        s.innerHTML = LANGS.map(function (l) { return '<option value="' + l[0] + '" lang="' + l[0] + '">' + l[1] + '</option>'; }).join('');
        s.addEventListener('change', function () { choose(s.value); });
      }
      s.value = lang;
    });
  }
  function load(code) {
    if (code === 'en') return Promise.resolve({});
    return fetch(BASE + 'assets/i18n/' + code + '.json?v=' + VERSION).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function redraw() {
    apply();
    try { document.dispatchEvent(new CustomEvent('fp-lang', {detail: lang})); } catch (e) {}
  }
  function choose(code) {
    if (!known[code]) return;
    set('fp-lang', code);
    if (window.fpEvent) window.fpEvent('language: ' + code);
    load(code).then(function (d) {
      lang = code; dict = d;
      try { plural = new Intl.PluralRules(lang); } catch (e) { plural = null; }
      set('fp-dict', code === 'en' ? null : JSON.stringify({lang: code, v: VERSION, d: d}));
      redraw();
    }).catch(function () {});
  }
  window.fpApply = apply;

  apply();
  // fetch the phrase file if it wasn't kept, or changed
  if (lang !== 'en') {
    load(lang).then(function (d) {
      var same = JSON.stringify(d) === JSON.stringify(dict);
      dict = d;
      set('fp-dict', JSON.stringify({lang: lang, v: VERSION, d: d}));
      if (!same) redraw();
    }).catch(function () {});
  }
})();
