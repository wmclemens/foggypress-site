"""The admin Reports tab's data (admin/report.json), gathered at build time from outside services.

GoatCounter (GOATCOUNTER_CODE + GOATCOUNTER_TOKEN), last 30 days:
  visitors per day, where visitors come from (referrers), countries, browsers, systems,
  screen sizes, the most visited pages, and feature use. GoatCounter already leaves out
  known bots, so its numbers are close to "people".
  Feature use comes from events that the site's scripts send (assets/site.js fpEvent):
  "search: <words>", "search-none: <words>" (nothing found), "find-in-book", "sort: <how>",
  "language: <code>", "theme: <dark|light>", plus the PDF and EPUB download clicks.

Cloudflare (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID; optional), last 7 days:
  every request for files.foggypress.com (the PDFs, EPUBs and read-online pages), split into people
  and bots by the browser name each request gives (crawlers name themselves: "bot", "spider", "crawl"...;
  the list is in bots.py), with countries, and how many bot requests were refused (downloads are
  closed to bots, see cloudflare_rules.py). Needs an API token with the zone's Analytics: Read permission.

Supabase (SUPABASE_URL + SUPABASE_ANON_KEY; only once reader accounts are set up):
  totals from the database function site_totals() (supabase/schema.sql): accounts, new in 7 days,
  active in 30 days, favorites, lists, and how many readers saved each book. Counts only.

Every source is optional: what can't be fetched is left out and named in "missing".
Nothing here identifies a person; the counts are totals.
"""
import datetime
import json
import re
import sys
import urllib.parse
import urllib.request

from bots import is_bot

DAYS = 30
CF_DAYS = 7


def _get(url, headers, data=None):
    req = urllib.request.Request(url, headers=headers, data=data)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def goatcounter(code, token):
    h = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    base = f'https://{code}.goatcounter.com/api/v0'
    end = datetime.datetime.now(datetime.timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = end - datetime.timedelta(days=DAYS)
    rng = {'start': start.strftime('%Y-%m-%dT%H:%M:%SZ'), 'end': end.strftime('%Y-%m-%dT%H:%M:%SZ')}
    out = {'start': rng['start'][:10], 'end': rng['end'][:10]}

    t = _get(f'{base}/stats/total?' + urllib.parse.urlencode(rng), h)
    out['visitors'] = int(t.get('total') or 0)
    out['events'] = int(t.get('total_events') or 0)
    out['daily'] = [[d.get('day', '')[:10], int(d.get('daily') or 0)] for d in (t.get('stats') or [])]

    for page in ('toprefs', 'locations', 'browsers', 'systems', 'sizes'):
        try:
            d = _get(f'{base}/stats/{page}?' + urllib.parse.urlencode(dict(rng, limit='20')), h)
            out[page] = [[s.get('name') or '(none)', int(s.get('count') or 0)] for s in (d.get('stats') or [])]
        except Exception as e:
            out.setdefault('missing', []).append(f'GoatCounter {page}: {e}')

    pages, events, after = {}, {}, None
    for _ in range(20):
        q = dict(rng, limit='100')
        if after:
            q['exclude_paths'] = ','.join(after)
        d = _get(f'{base}/stats/hits?' + urllib.parse.urlencode(q), h)
        hits = d.get('hits') or []
        for x in hits:
            (events if x.get('event') else pages)[x.get('path', '')] = int(x.get('count') or 0)
        if not d.get('more') or not hits:
            break
        after = [str(x['path_id']) for x in hits] + (after or [])
    out['pages'] = sorted(pages.items(), key=lambda kv: -kv[1])[:40]

    feat, searches, misses, downloads = {}, {}, {}, {'pdf': 0, 'epub': 0}
    for path, n in events.items():
        if path.startswith('search-none: '):
            misses[path[13:]] = misses.get(path[13:], 0) + n
            feat['Searches that found nothing'] = feat.get('Searches that found nothing', 0) + n
        elif path.startswith('search: '):
            searches[path[8:]] = searches.get(path[8:], 0) + n
            feat['Searches'] = feat.get('Searches', 0) + n
        elif path.startswith('pdf-'):
            downloads['pdf'] += n
        elif path.startswith('epub-'):
            downloads['epub'] += n
        else:
            name = {'find-in-book': 'Find in this book'}.get(path, path[:1].upper() + path[1:])
            feat[name] = feat.get(name, 0) + n
    feat['PDF downloads'] = downloads['pdf']
    feat['EPUB downloads'] = downloads['epub']
    feat['Read-online page views'] = sum(n for p, n in pages.items() if p.startswith('/read/'))
    out['features'] = sorted(feat.items(), key=lambda kv: -kv[1])
    out['searches'] = sorted(searches.items(), key=lambda kv: -kv[1])[:30]
    out['searches_none'] = sorted(misses.items(), key=lambda kv: -kv[1])[:30]
    return out


def bot_name(ua):
    """A short name for a bot's browser name. Crawlers that pose as a browser start with "Mozilla/5.0" and give their
    real name after "compatible;" (e.g. Meta's "meta-externalagent"), so that comes first; "Mozilla" itself means nothing."""
    m = (re.search(r'compatible;\s*([A-Za-z][\w.-]*)', ua)
         or re.search(r'([A-Za-z][\w.-]*(?:bot|crawler|spider|agent|fetcher)[\w.-]*)', ua, re.I)
         or re.search(r'^((?!Mozilla/)[^/ ]+)', ua))
    return m[1] if m else ('(no browser name)' if not ua else '(unnamed, posing as a browser)')


def cloudflare(token, zone, host='files.foggypress.com'):
    end = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    start = end - datetime.timedelta(days=CF_DAYS)
    q = '''query($zone: String!, $start: Time!, $end: Time!, $host: String!) {
      viewer { zones(filter: {zoneTag: $zone}) {
        ua: httpRequestsAdaptiveGroups(limit: 2000, filter: {datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $host}) {
          count dimensions { userAgent clientCountryName edgeResponseStatus } }
      } } }'''
    body = json.dumps({'query': q, 'variables': {'zone': zone, 'start': start.strftime('%Y-%m-%dT%H:%M:%SZ'),
                                                  'end': end.strftime('%Y-%m-%dT%H:%M:%SZ'), 'host': host}}).encode()
    d = _get('https://api.cloudflare.com/client/v4/graphql', {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, body)
    if d.get('errors'):
        raise RuntimeError('; '.join(e.get('message', '') for e in d['errors']))
    rows = d['data']['viewer']['zones'][0]['ua']
    people = bots = blocked = 0
    agents, countries = {}, {}
    for r in rows:
        n, ua = int(r['count']), r['dimensions'].get('userAgent') or ''
        if not ua or is_bot(ua):
            bots += n
            if r['dimensions'].get('edgeResponseStatus') == 403:
                blocked += n  # refused by the bot rule (build/cloudflare_rules.py)
            name = bot_name(ua)
            agents[name] = agents.get(name, 0) + n
        else:
            people += n
            c = r['dimensions'].get('clientCountryName') or '?'
            countries[c] = countries.get(c, 0) + n
    return {'host': host, 'start': start.strftime('%Y-%m-%d'), 'end': end.strftime('%Y-%m-%d'), 'people': people, 'bots': bots, 'blocked': blocked,
            'bot_agents': sorted(agents.items(), key=lambda kv: -kv[1])[:15],
            'countries': sorted(countries.items(), key=lambda kv: -kv[1])[:15]}


def supabase_totals(url, key):
    d = _get(f'{url}/rest/v1/rpc/site_totals', {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, b'{}')
    saved = d.get('saved') or {}
    return {'accounts': int(d.get('accounts') or 0), 'new_7d': int(d.get('new_7d') or 0), 'active_30d': int(d.get('active_30d') or 0),
            'favorites': int(d.get('favorites') or 0), 'lists': int(d.get('lists') or 0), 'list_items': int(d.get('list_items') or 0),
            'ask_30d': int(d.get('ask_30d') or 0), 'ask_askers_30d': int(d.get('ask_askers_30d') or 0),
            'ask_cost_month': float(d.get('ask_cost_month') or 0), 'ask_cap': d.get('ask_cap'), 'chats': int(d.get('chats') or 0),
            'requests_waiting': d.get('requests_waiting'), 'requests_published': int(d.get('requests_published') or 0),
            'requests_declined': int(d.get('requests_declined') or 0),
            'saved': {k: int(v) for k, v in saved.items()},
            'top_saved': sorted(([k, int(v)] for k, v in saved.items()), key=lambda kv: -kv[1])[:20]}


def build_report(gc_code, gc_token, cf_token='', cf_zone='', sb_url='', sb_key=''):
    rep = {'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'missing': []}
    if gc_code and gc_token:
        try:
            g = goatcounter(gc_code, gc_token)
            rep['missing'] += g.pop('missing', [])
            rep['goatcounter'] = g
        except Exception as e:
            rep['missing'].append(f'GoatCounter: {e}')
    else:
        rep['missing'].append('GoatCounter: no GOATCOUNTER_TOKEN in this build')
    if cf_token and cf_zone:
        try:
            rep['cloudflare'] = cloudflare(cf_token, cf_zone)
        except Exception as e:
            rep['missing'].append(f'Cloudflare: {e}')
    else:
        rep['missing'].append('Cloudflare: not connected (needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID secrets)')
    if sb_url and sb_key:
        try:
            rep['accounts'] = supabase_totals(sb_url, sb_key)
        except Exception as e:
            rep['missing'].append(f'Accounts (Supabase): {e}')
    for m in rep['missing']:
        print('warning: report:', m, file=sys.stderr)
    return rep
