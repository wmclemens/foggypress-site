"""Which visitors count as bots, in one place.

Used by the admin Reports tab (report.py, to split requests into people and bots) and by the Cloudflare rules
(cloudflare_rules.py) that keep bots away from the site's real functions: PDF, EPUB and Kindle downloads are closed
to every bot. Read-online pages, Britannica articles and every other page are open to the allowed crawlers only.

Who may crawl at all is an allowlist (ALLOWED_CATEGORIES, ALLOWED_ROBOTS below): search engines, link previews
and AI search answers get in; every other bot is refused.

A request is a bot when it gives no browser name, when Cloudflare knows it as a bot (Googlebot, Amazonbot,
Bingbot and the other "verified" crawlers), or when its browser name contains one of TERMS. Crawlers and scripts
name themselves this way; people's browsers never do.
"""
import re

TERMS = ['bot', 'crawl', 'spider', 'slurp', 'fetch', 'scrape', 'curl', 'wget', 'python', 'java/', 'go-http', 'okhttp',
         'headless', 'httpclient', 'libwww', 'axios', 'node-fetch', 'monitor', 'preview', 'facebookexternalhit',
         'bingpreview', 'semrush', 'ahrefs', 'mj12', 'petal', 'yandex', 'baidu', 'bytespider', 'archiver', 'scrapy',
         'aiohttp', 'httpx', 'deno/', 'undici', 'phantomjs', 'puppeteer', 'playwright', 'selenium',
         # AI agents and crawlers whose names have none of the words above (23 Nov 2026: Tencent's Hunyuan was
         # being counted as a person)
         'hunyuan', 'chatgpt-user', 'perplexity', 'claude-user', 'claude-web', 'anthropic-ai', 'cohere-ai', 'omgili',
         'img2dataset', 'meta-external', 'meta-webindexer', 'elevenlabs']

BOT_UA = re.compile('|'.join(re.escape(t) for t in TERMS), re.I)

# the build's own check that a PDF is reachable on R2 (.github/workflows/build.yml) names itself this way
BUILD_CHECK_UA = 'FoggyPress-site-build/1.0'

# what the Cloudflare rule blocks: downloads only
DOWNLOAD_PATHS = ('(ends_with(lower(http.request.uri.path), ".pdf") or ends_with(lower(http.request.uri.path), ".epub")'
                  ' or ends_with(lower(http.request.uri.path), ".azw3"))')


# WHO MAY CRAWL THE SITE: an allowlist (25 Nov 2026, Will). Bots that help people find the site (search engines,
# link previews, AI search answers) get in; every other bot, and anything that names itself as a bot but that
# Cloudflare can't vouch for, is refused everywhere Cloudflare serves (files.foggypress.com: read pages,
# Britannica, images). PDFs, EPUBs and Kindle files stay closed to every bot, allowed ones included.
#
# Cloudflare checks a "verified" bot really comes from its company (Googlebot from Google's addresses, etc.), so a
# scraper calling itself Googlebot is refused. A verified bot gets in when its Cloudflare category is one of these:
ALLOWED_CATEGORIES = ['Search Engine Crawler', 'Page Preview', 'Feed Fetcher', 'Accessibility', 'Archiver',
                      'AI Search',      # e.g. OAI-SearchBot, so ChatGPT search can cite a book
                      'AI Assistant']   # e.g. ChatGPT-User: fetching a page because a person asked about it
# Not allowed, among others: AI training crawlers ('AI Crawler': GPTBot, meta-externalagent, ...), SEO tools,
# advertising, monitoring, research crawlers, and every unverified bot (RiverBot, DotBot, scripts, ...).

# The names well-behaved crawlers read in robots.txt: these are told they may crawl (the same rules as people),
# every other name is told "Disallow: /".
ALLOWED_ROBOTS = ['Googlebot', 'Googlebot-Image', 'Googlebot-News', 'Googlebot-Video', 'Storebot-Google',
                  'Google-InspectionTool', 'Bingbot', 'msnbot', 'BingPreview', 'DuckDuckBot', 'DuckAssistBot',
                  'Applebot', 'YandexBot', 'Baiduspider', 'Yeti', 'Slurp', 'Qwantbot', 'SeznamBot', 'MojeekBot',
                  'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User', 'Claude-SearchBot', 'Claude-User',
                  'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Slackbot-LinkExpanding', 'Discordbot',
                  'TelegramBot', 'WhatsApp', 'Pinterestbot', 'ia_archiver', 'archive.org_bot']

# Bots refused even if Cloudflare verifies them and their category is allowed (Will named each one).
# Company name -> the names its crawlers give (robots.txt tokens, also matched anywhere in the browser name).
BLOCKED = {
    'ElevenLabs': ['ElevenlabsCrawler', 'ElevenlabsBot'],   # https://elevenlabs.io/docs/bots (19 Nov 2026, Will)
    # Meta's AI crawlers: training (externalagent), fetching for Meta AI answers (externalfetcher) and Meta's AI search
    # index (webindexer, first seen here 23 Nov 2026). facebookexternalhit (the preview card when someone shares a
    # page on Facebook or WhatsApp) stays allowed.
    'Meta AI': ['meta-externalagent', 'meta-externalfetcher', 'meta-webindexer'],  # https://developers.facebook.com/docs/sharing/webmasters/web-crawlers (21 and 23 Nov 2026, Will)
    # OpenAI's training crawler only; OAI-SearchBot (ChatGPT search results) and ChatGPT-User stay allowed
    'OpenAI training': ['GPTBot'],                           # https://platform.openai.com/docs/bots (24 Nov 2026, Will)
}

# What the Cloudflare rule looks for in the browser name, besides the names above: any version or variant
# of a company's crawler (e.g. a future "ElevenLabs-Fetcher").
BLOCKED_MATCH = ['elevenlabs', 'meta-external', 'meta-webindexer', 'gptbot']


def blocked_names():
    return [n for names in BLOCKED.values() for n in names]


def _blocked_terms():
    """The shortest set of lowercase pieces that catches every blocklisted name (no piece inside another)."""
    terms = set(n.lower() for n in blocked_names()) | set(BLOCKED_MATCH)
    return sorted(t for t in terms if not any(o != t and o in t for o in terms))


def is_blocked(ua):
    """On Will's named blocklist (refused whatever Cloudflare says about it)."""
    u = (ua or '').lower()
    return any(t in u for t in _blocked_terms())


def _listed_expression():
    return ' or '.join(f'lower(http.user_agent) contains "{t}"' for t in _blocked_terms())


def _self_named_bot_expression():
    """A request that names itself a bot (or gives no browser name), in Cloudflare's rule language."""
    names = ' or '.join(f'lower(http.user_agent) contains "{t}"' for t in TERMS)
    return f'(http.user_agent eq "" or {names})'


def allowlist_expression(categories=True):
    """Cloudflare rule test for a bot that is not allowed in, on any foggypress.com host Cloudflare serves:
    a blocklisted bot, or any bot (named so, or known to Cloudflare) that isn't a verified bot in an allowed category.
    With categories=False (if the plan refuses the category field), every verified bot is let in instead.
    robots.txt stays readable: a crawler refused robots.txt is entitled (RFC 9309) to treat the site as open,
    and a well-behaved one that can read "Disallow: /" stops asking."""
    if categories:
        cats = ' '.join(f'"{c}"' for c in ALLOWED_CATEGORIES)
        welcome = f'(cf.client.bot and cf.verified_bot_category in {{{cats}}})'
        bot = f'(cf.client.bot or {_self_named_bot_expression()})'
    else:
        welcome = 'cf.client.bot'
        bot = _self_named_bot_expression()
    return f'(({_listed_expression()}) or ({bot} and not {welcome})) and http.request.uri.path ne "/robots.txt"'


def robots_txt(rules):
    """robots.txt: blocklisted bots out entirely; the allowed crawlers get `rules` (what people may see too);
    every other crawler is told to stay out."""
    out = ''.join(f'User-agent: {n}\nDisallow: /\n\n' for n in blocked_names())
    out += ''.join(f'User-agent: {n}\n' for n in ALLOWED_ROBOTS) + rules.rstrip('\n') + '\n\n'
    return out + 'User-agent: *\nDisallow: /\n'


def is_bot(ua):
    return not ua or bool(BOT_UA.search(ua))


def cloudflare_bot_expression():
    """The same test as is_bot(), written in Cloudflare's rule language (no regular expressions on the Free plan)."""
    names = ' or '.join(f'lower(http.user_agent) contains "{t}"' for t in TERMS)
    return f'(cf.client.bot or http.user_agent eq "" or {names})'


def download_block_expression(host):
    return f'(http.host eq "{host}" and {DOWNLOAD_PATHS} and {cloudflare_bot_expression()})'
