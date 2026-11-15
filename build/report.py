"""The admin Reports tab's data (admin/report.json), gathered at build time from outside services.

GoatCounter (GOATCOUNTER_CODE + GOATCOUNTER_TOKEN), last 30 days:
  visitors per day, where visitors come from (referrers), countries, browsers, systems,
  screen sizes, the most visited pages, and feature use. GoatCounter already leaves out
  known bots, so its numbers are close to "people".
  Feature use comes from events that the site's scripts send (assets/site.js fpEvent):
  "search: <words>", "search-none: <words>" (nothing found), "find-in-book", "sort: <how>",
  "language: <code>", "theme: <dark|light>", plus the PDF and EPUB download clicks.

Cloudflare (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID; optional), last 7 days:
  every request for files.foggypress.com (the PDFs and EPUBs), split into people and bots by
  the browser name each request gives (crawlers name themselves: "bot", "spider", "crawl"...),
  with countries. Needs an API token with the zone's Analytics: Read permission.

Every source is optional: what can't be fetched is left out and named in "missing".
Nothing here identifies a person; the counts are totals.
"""
import datetime
import json
import re
import sys
import urllib.parse
import urllib.request

DAYS = 30
CF_DAYS = 7
BOT_UA = re.compile(r'bot|crawl|spider|slurp|fetch|scrape|curl|wget|python|java/|go-http|okhttp|headless|httpclient|libwww|axios|node-fetch|monitor|preview|facebookexternalhit|bingpreview|semrush|ahrefs|mj12|petal|yandex|baidu|bytespider|gptbot|claudebot|ccbot|amazonbot|applebot', re.I)


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


def cloudflare(token, zone, host='files.foggypress.com'):
    end = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    start = end - datetime.timedelta(days=CF_DAYS)
    q = '''query($zone: String!, $start: Time!, $end: Time!, $host: String!) {
      viewer { zones(filter: {zoneTag: $zone}) {
        ua: httpRequestsAdaptiveGroups(limit: 2000, filter: {datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $host}) {
          count dimensions { userAgent clientCountryName } }
      } } }'''
    body = json.dumps({'query': q, 'variables': {'zone': zone, 'start': start.strftime('%Y-%m-%dT%H:%M:%SZ'),
                                                  'end': end.strftime('%Y-%m-%dT%H:%M:%SZ'), 'host': host}}).encode()
    d = _get('https://api.cloudflare.com/client/v4/graphql', {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, body)
    if d.get('errors'):
        raise RuntimeError('; '.join(e.get('message', '') for e in d['errors']))
    rows = d['data']['viewer']['zones'][0]['ua']
    people = bots = 0
    agents, countries = {}, {}
    for r in rows:
        n, ua = int(r['count']), r['dimensions'].get('userAgent') or ''
        if not ua or BOT_UA.search(ua):
            bots += n
            name = (re.search(r'([A-Za-z][\w.-]*(?:bot|crawler|spider)[\w.-]*)', ua, re.I) or re.search(r'^([^/ ]+)', ua) or [None, '(no browser name)'])[1]
            agents[name] = agents.get(name, 0) + n
        else:
            people += n
            c = r['dimensions'].get('clientCountryName') or '?'
            countries[c] = countries.get(c, 0) + n
    return {'host': host, 'start': start.strftime('%Y-%m-%d'), 'end': end.strftime('%Y-%m-%d'), 'people': people, 'bots': bots,
            'bot_agents': sorted(agents.items(), key=lambda kv: -kv[1])[:15],
            'countries': sorted(countries.items(), key=lambda kv: -kv[1])[:15]}


def build_report(gc_code, gc_token, cf_token='', cf_zone=''):
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
    for m in rep['missing']:
        print('warning: report:', m, file=sys.stderr)
    return rep
