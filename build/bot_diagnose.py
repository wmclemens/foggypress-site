"""Diagnosis of bot traffic on files.foggypress.com (Cloudflare analytics + rules), run by hand from
.github/workflows/bot-diagnose.yml. Prints markdown to the log and the run summary. Analytics counts are Cloudflare's
sampled estimates, and busy days hit the 10,000-row cap, so treat them as proportions, not exact totals."""
import datetime, json, os, re, sys, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bots

TOK = os.environ.get('CLOUDFLARE_API_TOKEN', '').strip()
WAF = os.environ.get('CLOUDFLARE_WAF_TOKEN', '').strip()
ZONE = os.environ.get('CLOUDFLARE_ZONE_ID', '').strip()
HOST = 'files.foggypress.com'
OUT = []


def p(*a):
    s = ' '.join(str(x) for x in a)
    print(s)
    OUT.append(s)


def gql(q, v, token=TOK):
    body = json.dumps({'query': q, 'variables': v}).encode()
    req = urllib.request.Request('https://api.cloudflare.com/client/v4/graphql', data=body,
                                 headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if d.get('errors'):
        raise RuntimeError('; '.join(e.get('message', '') for e in d['errors']))
    return d['data']['viewer']['zones'][0]


def rng(days_back_start, days_back_end=0):
    end = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0) - datetime.timedelta(days=days_back_end)
    start = end - datetime.timedelta(days=days_back_start - days_back_end)
    return start.strftime('%Y-%m-%dT%H:%M:%SZ'), end.strftime('%Y-%m-%dT%H:%M:%SZ')


def kind(path):
    l = path.lower()
    if l.endswith('.pdf'): return 'pdf'
    if l.endswith('.epub'): return 'epub'
    if l.endswith('.azw3'): return 'azw3'
    if l == '/robots.txt': return 'robots'
    if l.startswith('/britannica'): return 'britannica'
    if l.startswith('/read/'): return 'read'
    if re.search(r'\.(png|jpe?g|gif|svg|webp)$', l): return 'image'
    if re.search(r'\.(css|js|json|woff2?)$', l): return 'asset'
    return 'other:' + l[:40]


def who(ua):
    if bots.is_blocked(ua):
        for co, names in bots.BLOCKED.items():
            if any(n.lower() in (ua or '').lower() for n in names): return co
    if not ua: return '(empty UA)'
    if bots.is_bot(ua):
        m = re.search(r'compatible;\s*([A-Za-z][\w.-]*)', ua) or re.search(r'([A-Za-z][\w.-]*(?:bot|crawler|spider|agent|fetcher)[\w.-]*)', ua, re.I) or re.search(r'^([^/ ]+)', ua)
        return m[1] if m else ua[:30]
    return 'PERSON?'


Q_DAY = '''query($zone: String!, $start: Time!, $end: Time!, $host: String!) { viewer { zones(filter: {zoneTag: $zone}) {
  g: httpRequestsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $host}) {
    count dimensions { date userAgent edgeResponseStatus clientRequestPath } } } } }'''


def section_daily():
    p('## 1. Requests per day per visitor kind, by what was asked for and the answer')
    p('(one query per day; 10,000-row cap per day noted if hit)\n')
    totals = {}
    paths_by_who = {}
    for d in range(8, 0, -1):
        s, e = rng(d, d - 1)
        try:
            rows = gql(Q_DAY, {'zone': ZONE, 'start': s, 'end': e, 'host': HOST})['g']
        except Exception as ex:
            p(f'- {s[:13]}: error {ex}')
            continue
        if len(rows) >= 10000: p(f'- WARNING {s[:13]} hit the 10,000-row cap')
        for r in rows:
            dm = r['dimensions']; n = int(r['count'])
            w = who(dm.get('userAgent') or ''); k = kind(dm.get('clientRequestPath') or '')
            k2 = k if not k.startswith('other:') else 'other'
            st = dm.get('edgeResponseStatus')
            key = (dm['date'], w)
            t = totals.setdefault(key, {})
            t[(k2, st)] = t.get((k2, st), 0) + n
            if k.startswith('other:'):
                pb = paths_by_who.setdefault(w, {}); pb[k] = pb.get(k, 0) + n
    whos = {}
    for (date, w), t in totals.items():
        whos[w] = whos.get(w, 0) + sum(t.values())
    top = [w for w, _ in sorted(whos.items(), key=lambda kv: -kv[1])[:14]]
    for w in top:
        p(f'\n### {w} (total {whos[w]:,})\n')
        p('| date | total | by kind/status |'); p('|---|---|---|')
        for (date, w2), t in sorted(totals.items()):
            if w2 != w: continue
            desc = ', '.join(f'{k} {st}: {n:,}' for (k, st), n in sorted(t.items(), key=lambda kv: -kv[1])[:8])
            p(f'| {date} | {sum(t.values()):,} | {desc} |')
    p('\n### "other" paths (top) per visitor\n')
    for w in top:
        if w in paths_by_who:
            p(f'- {w}: ' + ', '.join(f'{k[6:]} {n}' for k, n in sorted(paths_by_who[w].items(), key=lambda kv: -kv[1])[:6]))
    # downloads served to any bot
    p('\n### Downloads (pdf/epub/azw3) ANSWERED 200/206/304 to bot-named visitors\n')
    any_ = False
    for (date, w), t in sorted(totals.items()):
        if w == 'PERSON?': continue
        for (k, st), n in t.items():
            if k in ('pdf', 'epub', 'azw3') and st in (200, 206, 304):
                p(f'- {date} {w}: {k} {st} x{n}'); any_ = True
    if not any_: p('- none')


Q_PEOPLE = '''query($zone: String!, $start: Time!, $end: Time!, $host: String!) { viewer { zones(filter: {zoneTag: $zone}) {
  g: httpRequestsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $host}) {
    count dimensions { clientIP clientCountryName userAgent clientRequestPath edgeResponseStatus } } } } }'''


def section_people():
    p('\n## 2. "People" (browser-named) requests, last 7 days: by address')
    agg = {}
    for d in range(7, 0, -1):
        s, e = rng(d, d - 1)
        try:
            rows = gql(Q_PEOPLE, {'zone': ZONE, 'start': s, 'end': e, 'host': HOST})['g']
        except Exception as ex:
            p(f'- error {ex}'); return
        for r in rows:
            dm = r['dimensions']; ua = dm.get('userAgent') or ''
            if bots.is_bot(ua): continue
            ip = dm.get('clientIP') or '?'
            a = agg.setdefault(ip, {'n': 0, 'cc': dm.get('clientCountryName'), 'ua': set(), 'kinds': {}, 'paths': set()})
            n = int(r['count']); a['n'] += n; a['ua'].add(ua[:110])
            k = kind(dm.get('clientRequestPath') or ''); k = 'other' if k.startswith('other:') else k
            a['kinds'][k] = a['kinds'].get(k, 0) + n
            a['paths'].add(dm.get('clientRequestPath'))
    p(f'{len(agg)} addresses, {sum(a["n"] for a in agg.values()):,} requests\n')
    p('| address | country | requests | distinct paths | kinds | browser names |'); p('|---|---|---|---|---|---|')
    for ip, a in sorted(agg.items(), key=lambda kv: -kv[1]['n'])[:25]:
        ipm = re.sub(r'(\d+\.\d+)\.\d+\.\d+$', r'\1.x.x', ip)
        ipm = re.sub(r'^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+):.*$', r'\1::', ipm)
        p(f"| {ipm} | {a['cc']} | {a['n']} | {len(a['paths'])} | {a['kinds']} | {' ;; '.join(sorted(a['ua']))[:220]} |")


Q_FW = '''query($zone: String!, $start: Time!, $end: Time!) { viewer { zones(filter: {zoneTag: $zone}) {
  g: firewallEventsAdaptiveGroups(limit: 2000, filter: {datetime_geq: $start, datetime_lt: $end}) {
    count dimensions { date action source ruleId clientRequestHTTPHost userAgent } } } } }'''


def section_fw():
    p('\n## 3. Cloudflare security events (what the rules refused)')
    agg = {}
    for d in range(7, 0, -1):
        s, e = rng(d, d - 1)
        for tok in (TOK, WAF):
            if not tok: continue
            try:
                rows = gql(Q_FW, {'zone': ZONE, 'start': s, 'end': e}, tok)['g']; break
            except Exception as ex:
                rows = None; err = ex
        if rows is None:
            p(f'- {s[:10]}: error {err}'); continue
        for r in rows:
            dm = r['dimensions']
            key = (dm['date'], dm['action'], dm['source'], (dm.get('ruleId') or '')[:8], dm['clientRequestHTTPHost'], who(dm.get('userAgent') or ''))
            agg[key] = agg.get(key, 0) + int(r['count'])
    p('| date | action | source | rule | host | who | n |'); p('|---|---|---|---|---|---|---|')
    for k, n in sorted(agg.items()):
        if n >= 5: p('| ' + ' | '.join(str(x) for x in k) + f' | {n:,} |')


def section_rules():
    p('\n## 4. Rules on the zone now')
    for phase in ('http_request_firewall_custom', 'http_ratelimit'):
        req = urllib.request.Request(f'https://api.cloudflare.com/client/v4/zones/{ZONE}/rulesets/phases/{phase}/entrypoint',
                                     headers={'Authorization': f'Bearer {WAF}'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                d = json.load(r)['result']
            for rule in d.get('rules') or []:
                p(f"- {phase} id {rule.get('id','')[:8]} ref={rule.get('ref')} enabled={rule.get('enabled')} action={rule.get('action')}: {rule.get('expression')[:600]}")
        except urllib.error.HTTPError as ex:
            p(f'- {phase}: HTTP {ex.code} {ex.read()[:300]}')
    for path in (f'/zones/{ZONE}/dns_records?per_page=100', f'/zones/{ZONE}/settings/security_level', f'/zones/{ZONE}/bot_management'):
        for tok in (WAF, TOK):
            req = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, headers={'Authorization': f'Bearer {tok}'})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    d = json.load(r)['result']
                if isinstance(d, list):
                    for x in d: p(f"- dns {x.get('type')} {x.get('name')} -> {x.get('content')} proxied={x.get('proxied')}")
                else:
                    p(f'- {path.split("/")[-1]}: {json.dumps(d)[:400]}')
                break
            except urllib.error.HTTPError as ex:
                last = f'HTTP {ex.code}'
        else:
            p(f'- {path.split("/")[-1]}: not readable with our tokens ({last})')


def section_live():
    p('\n## 5. Live checks now')
    def get(url, ua):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': ua, 'Range': 'bytes=0-0'}), timeout=30) as r:
                return r.status, dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers)
        except Exception as e:
            return str(e)[:80], {}
    home = urllib.request.urlopen(urllib.request.Request('https://foggypress.com/titles/', headers={'User-Agent': 'Mozilla/5.0 Chrome/131'}), timeout=30).read().decode()
    pdf = re.search(r'href="(https://files\.foggypress\.com/[^"]+\.pdf)"', home)[1]
    rd = re.search(r'href="(https://files\.foggypress\.com/read/[^"]+)"', home)[1]
    uas = {'person': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
           'GPTBot': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
           'meta-externalagent': 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
           'ElevenlabsCrawler': 'Mozilla/5.0 (compatible; ElevenlabsCrawler/1.0)'}
    for label, ua in uas.items():
        for what, url in (('pdf', pdf), ('read', rd), ('main site home', 'https://foggypress.com/'), ('main site read-ish /titles/', 'https://foggypress.com/titles/')):
            st, h = get(url, ua)
            p(f'- {label} -> {what}: {st} server={h.get("Server") or h.get("server")}')
    for host in ('foggypress.com', HOST):
        try:
            t = urllib.request.urlopen(f'https://{host}/robots.txt', timeout=30).read().decode()
            p(f'\n{host}/robots.txt:\n```\n{t[:800]}\n```')
        except Exception as e:
            p(f'- {host}/robots.txt: {e}')


def section_ua_probe():
    p('\n## 6. Which plain browser names are refused on files.foggypress.com, and by what')
    for ua in ('Python-urllib/3.12', 'python-requests/2.32.3', 'curl/8.5.0', 'Mozilla/5.0 Chrome/131', ''):
        for path in ('/robots.txt', '/read/'):
            try:
                req = urllib.request.Request(f'https://{HOST}{path}', headers={'User-Agent': ua} if ua else {})
                if not ua: req.remove_header('User-agent')
                with urllib.request.urlopen(req, timeout=30) as r:
                    p(f'- {ua or "(none)"} {path}: {r.status}')
            except urllib.error.HTTPError as e:
                body = e.read(3000).decode('utf-8', 'replace')
                m = re.search(r'<title>([^<]*)', body)
                p(f'- {ua or "(none)"} {path}: {e.code} cf-mitigated={e.headers.get("cf-mitigated")} title={m[1] if m else body[:80]!r}')


for f in (section_ua_probe, section_rules) if os.environ.get('ONLY_PROBE') else (section_ua_probe, section_rules, section_live, section_daily, section_fw, section_people):
    try:
        f()
    except Exception as ex:
        p(f'\n{f.__name__} failed: {ex}')
if os.environ.get('GITHUB_STEP_SUMMARY'):
    open(os.environ['GITHUB_STEP_SUMMARY'], 'a').write('\n'.join(OUT))
