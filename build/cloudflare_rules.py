"""Keep bots away from the PDF and EPUB downloads on files.foggypress.com (Cloudflare), and check that it works.

  python build/cloudflare_rules.py apply    puts the rules on the foggypress.com zone (needs CLOUDFLARE_WAF_TOKEN
                                            and CLOUDFLARE_ZONE_ID); run by .github/workflows/bot-rules.yml
  python build/cloudflare_rules.py check    asks the live site, as a bot and as a person, and reports what happened
          [--strict]                        (with --strict, fails unless bots are refused and people get through)

The rules, both kept beside any rules Will adds himself in the dashboard (they are found again by their "ref"):
  1. Custom rule: block a request for a .pdf or .epub on files.foggypress.com when it comes from a bot
     (bots.py: Cloudflare's known bots, no browser name, or a browser name such as "Amazonbot" or "python").
  2. Custom rule: block every request, on every foggypress.com host, from a bot on the blocklist (bots.BLOCKED,
     e.g. ElevenLabs). Those bots are also told to stay out in robots.txt.
  3. Rate limit (best effort; the Free plan allows one): one address asking for more than 30 PDFs or EPUBs
     in 10 seconds is refused for 10 seconds. A person clicking never comes close.
Read-online pages, Britannica articles and the rest of the site are not touched: any crawler may read them.
Download counts are unaffected, since GoatCounter counts the click on the page, not the file request.

The check also confirms that Supabase sign-in demands the Turnstile bot check (SUPABASE_URL + SUPABASE_ANON_KEY):
Ask Foggy Press, Request a book, favorites and lists all need a signed-in reader, so that one gate covers them.

The token: Cloudflare → My Profile → API Tokens → Create Token → Custom token, permission Zone / Zone WAF / Edit,
zone resources Include / Specific zone / foggypress.com. Saved as the repository secret CLOUDFLARE_WAF_TOKEN.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bots  # noqa: E402

HOST = os.environ.get('FILES_HOST', 'files.foggypress.com')
SITE = os.environ.get('SITE_ORIGIN', 'https://foggypress.com')
API = 'https://api.cloudflare.com/client/v4'
BLOCK_REF = 'fp_block_bot_downloads'
RATE_REF = 'fp_download_rate_limit'
LIST_REF = 'fp_block_listed_bots'
KEEP = ('id', 'ref', 'action', 'action_parameters', 'expression', 'description', 'enabled', 'logging', 'ratelimit')

BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
BOT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)'


class CfError(Exception):
    pass


def cf(method, path, token, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            d = json.load(e)
        except Exception:
            d = {}
        if e.code == 404 and method == 'GET':
            return None
        msg = '; '.join(f"{x.get('code')}: {x.get('message')}" for x in d.get('errors') or []) or str(e)
        raise CfError(f'{method} {path}: {msg}')


def put_rule(token, zone, phase, rule):
    """Add or replace our rule (found by its ref) in a phase, keeping every other rule as it is."""
    path = f'/zones/{zone}/rulesets/phases/{phase}/entrypoint'
    cur = cf('GET', path, token)
    old = (cur or {}).get('result', {}).get('rules') or []
    others = [{k: r[k] for k in KEEP if k in r} for r in old if r.get('ref') != rule['ref']]
    cf('PUT', path, token, {'rules': [rule] + others})
    return len(others)


def apply():
    token = os.environ.get('CLOUDFLARE_WAF_TOKEN', '').strip()
    zone = os.environ.get('CLOUDFLARE_ZONE_ID', '').strip()
    if not (token and zone):
        print('::warning::The bot rules were not put on Cloudflare: this needs the CLOUDFLARE_WAF_TOKEN and '
              'CLOUDFLARE_ZONE_ID secrets (see build/cloudflare_rules.py).')
        return 0
    expr = bots.download_block_expression(HOST)
    n = put_rule(token, zone, 'http_request_firewall_custom', {
        'ref': BLOCK_REF, 'action': 'block', 'enabled': True, 'expression': expr,
        'description': 'Foggy Press: bots may not download PDFs or EPUBs (foggypress-site build/cloudflare_rules.py)'})
    print(f'Custom rule set: bots blocked from PDF and EPUB downloads on {HOST} ({n} other custom rules kept).')
    n = put_rule(token, zone, 'http_request_firewall_custom', {
        'ref': LIST_REF, 'action': 'block', 'enabled': True, 'expression': bots.blocked_expression(),
        'description': 'Foggy Press: blocklisted bots (' + ', '.join(bots.BLOCKED) + ') may not fetch anything '
                       '(foggypress-site build/bots.py BLOCKED)'})
    print(f'Custom rule set: blocklisted bots refused everywhere: {", ".join(bots.blocked_names())} ({n} other custom rules kept).')
    # the Free plan limits what a rate-limit rule may test, so try the narrowest form first
    for e in (f'(http.host eq "{HOST}" and {bots.DOWNLOAD_PATHS})', bots.DOWNLOAD_PATHS,
              '(http.request.uri.path contains ".pdf" or http.request.uri.path contains ".epub")'):
        try:
            put_rule(token, zone, 'http_ratelimit', {
                'ref': RATE_REF, 'action': 'block', 'enabled': True, 'expression': e,
                'description': 'Foggy Press: at most 30 PDF/EPUB requests per 10 seconds from one address',
                'ratelimit': {'characteristics': ['cf.colo.id', 'ip.src'], 'period': 10, 'requests_per_period': 30,
                              'mitigation_timeout': 10}})
            print(f'Rate limit set: {e}')
            break
        except CfError as err:
            last = err
    else:
        print(f'::warning::The download rate limit could not be set ({last}). The bot rule above is in place.')
    return 0


def fetch(url, ua, method='GET', data=None, headers=None, first_byte=True):
    h = {'User-Agent': ua, **({'Range': 'bytes=0-0'} if first_byte else {}), **(headers or {})}
    req = urllib.request.Request(url, method=method, data=data, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read(4096).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read(4096).decode('utf-8', 'replace')
    except Exception as e:
        return 0, str(e)


def page(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': BROWSER_UA}), timeout=30) as r:
            return r.read().decode('utf-8', 'replace')
    except Exception:
        return ''


def check(strict=False):
    home = page(SITE + '/titles/')  # every book's links
    pdf = re.search(r'href="(https://' + re.escape(HOST) + r'/[^"]+\.pdf)"', home)
    read = re.search(r'href="(https://' + re.escape(HOST) + r'/read/[^"]+)"', home)
    epub = re.search(r'href="(https://' + re.escape(HOST) + r'/epub/[^"]+\.epub)"', home)
    rows, bad = [], []

    def want(label, url, ua, ok_codes):
        code, _ = fetch(url, ua)
        good = code in ok_codes
        rows.append(f"| {label} | {code or 'no answer'} | {'yes' if good else '**no**'} |")
        if not good:
            bad.append(label)

    ok, refused = (200, 206), (403,)
    if pdf:
        want('PDF, as a person', pdf[1], BROWSER_UA, ok)
        want('PDF, as the site build', pdf[1], bots.BUILD_CHECK_UA, ok)
        want('PDF, as Amazonbot', pdf[1], BOT_UA, refused)
        want('PDF, as a Python script', pdf[1], 'python-requests/2.32.3', refused)
    else:
        bad.append('no PDF link found on the home page')
    if epub:
        want('EPUB, as a person', epub[1], BROWSER_UA, ok)
        want('EPUB, as Amazonbot', epub[1], BOT_UA, refused)
    if read:
        want('Read-online page, as Amazonbot', read[1], BOT_UA, ok)
        want('Read-online page, as a person', read[1], BROWSER_UA, ok)
    want('Home page, as Amazonbot', SITE + '/', BOT_UA, ok)
    robots = page(f'https://{HOST}/robots.txt')  # written by the site build, so it may lag a merge by a few minutes
    for name in bots.blocked_names():
        if read:
            want(f'Read-online page, as {name} (blocklisted)', read[1], f'Mozilla/5.0 (compatible; {name}/1.0)', refused)
        rows.append(f"| {HOST}/robots.txt tells {name} to stay out | | {'yes' if name in robots else 'not yet (next site build)'} |")

    sb, key = os.environ.get('SUPABASE_URL', '').strip().rstrip('/'), os.environ.get('SUPABASE_ANON_KEY', '').strip()
    if sb and key:
        # no captcha token and create_user off: if Turnstile is enforced the server refuses before anything else,
        # and if it isn't, no account is made and no email is sent
        code, body = fetch(sb + '/auth/v1/otp', bots.BUILD_CHECK_UA, 'POST',
                           json.dumps({'email': 'bot-check@example.com', 'create_user': False}).encode(),
                           {'apikey': key, 'Content-Type': 'application/json'}, first_byte=False)
        good = 'captcha' in body.lower()
        rows.append(f"| Sign-in without the Turnstile check | {code} | {'yes, refused' if good else '**no**: ' + body[:120].replace('|', '/')} |")
        if not good:
            bad.append('Supabase sign-in does not demand Turnstile')
    else:
        rows.append('| Sign-in without the Turnstile check | not checked (no SUPABASE_URL) | |')

    out = '### Bot check\n\n| Request | Answer | As intended |\n|---|---|---|\n' + '\n'.join(rows) + '\n'
    print(out)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as f:
            f.write(out)
    if bad:
        print(('::error::' if strict else '::warning::') + 'Not as intended: ' + ', '.join(bad))
        return 1 if strict else 0
    return 0


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'apply':
        sys.exit(apply())
    if cmd == 'check':
        sys.exit(check('--strict' in sys.argv))
    print(__doc__)
    sys.exit(2)
