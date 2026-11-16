"""Which visitors count as bots, in one place.

Used by the admin Reports tab (report.py, to split requests into people and bots) and by the Cloudflare rules
(cloudflare_rules.py) that keep bots away from the site's real functions: PDF and EPUB downloads. Read-online
pages, Britannica articles and every other page stay open to all crawlers.

A request is a bot when it gives no browser name, when Cloudflare knows it as a bot (Googlebot, Amazonbot,
Bingbot and the other "verified" crawlers), or when its browser name contains one of TERMS. Crawlers and scripts
name themselves this way; people's browsers never do.
"""
import re

TERMS = ['bot', 'crawl', 'spider', 'slurp', 'fetch', 'scrape', 'curl', 'wget', 'python', 'java/', 'go-http', 'okhttp',
         'headless', 'httpclient', 'libwww', 'axios', 'node-fetch', 'monitor', 'preview', 'facebookexternalhit',
         'bingpreview', 'semrush', 'ahrefs', 'mj12', 'petal', 'yandex', 'baidu', 'bytespider', 'archiver', 'scrapy',
         'aiohttp', 'httpx', 'deno/', 'undici', 'phantomjs', 'puppeteer', 'playwright', 'selenium']

BOT_UA = re.compile('|'.join(re.escape(t) for t in TERMS), re.I)

# the build's own check that a PDF is reachable on R2 (.github/workflows/build.yml) names itself this way
BUILD_CHECK_UA = 'FoggyPress-site-build/1.0'

# what the Cloudflare rule blocks: downloads only
DOWNLOAD_PATHS = '(ends_with(lower(http.request.uri.path), ".pdf") or ends_with(lower(http.request.uri.path), ".epub"))'


def is_bot(ua):
    return not ua or bool(BOT_UA.search(ua))


def cloudflare_bot_expression():
    """The same test as is_bot(), written in Cloudflare's rule language (no regular expressions on the Free plan)."""
    names = ' or '.join(f'lower(http.user_agent) contains "{t}"' for t in TERMS)
    return f'(cf.client.bot or http.user_agent eq "" or {names})'


def download_block_expression(host):
    return f'(http.host eq "{host}" and {DOWNLOAD_PATHS} and {cloudflare_bot_expression()})'
