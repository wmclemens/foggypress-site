"""One-off: list the full browser names, networks and paths behind bot requests the Reports tab lumps as "Mozilla"."""
import datetime, json, os, re, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bots import is_bot, BOT_UA
tok, zone = os.environ['CLOUDFLARE_API_TOKEN'], os.environ['CLOUDFLARE_ZONE_ID']
end = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
start = end - datetime.timedelta(days=3)
def q(dims, host):
    body = {'query': '''query($zone:String!,$start:Time!,$end:Time!,$host:String!){viewer{zones(filter:{zoneTag:$zone}){
      g: httpRequestsAdaptiveGroups(limit:5000, filter:{datetime_geq:$start,datetime_lt:$end,clientRequestHTTPHost:$host}, orderBy:[count_DESC]){count dimensions{%s}}}}}''' % dims,
      'variables': {'zone': zone, 'start': start.strftime('%Y-%m-%dT%H:%M:%SZ'), 'end': end.strftime('%Y-%m-%dT%H:%M:%SZ'), 'host': host}}
    r = urllib.request.Request('https://api.cloudflare.com/client/v4/graphql', data=json.dumps(body).encode(),
                               headers={'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'})
    d = json.load(urllib.request.urlopen(r, timeout=60))
    if d.get('errors'): print('ERR', d['errors']); return []
    return d['data']['viewer']['zones'][0]['g']
named = lambda ua: re.search(r'([A-Za-z][\w.-]*(?:bot|crawler|spider)[\w.-]*)', ua, re.I)
for host in ('files.foggypress.com', 'foggypress.com'):
    rows = q('userAgent clientCountryName edgeResponseStatus', host)
    print(f'\n=== {host}: last 24h, {sum(r["count"] for r in rows)} requests in sample')
    agg = {}
    for r in rows:
        d = r['dimensions']; ua = d.get('userAgent') or ''
        if is_bot(ua) and not named(ua):
            k = (ua, d.get('edgeResponseStatus'), tuple(BOT_UA.findall(ua)), d.get('clientCountryName'))
            agg[k] = agg.get(k, 0) + r['count']
    for k, n in sorted(agg.items(), key=lambda kv: -kv[1])[:25]:
        print(n, '|', k[0], '| status', k[1], 'matched', k[2], '|', k[3])
    print('-- by ASN, all named/unnamed ElevenLabs:')
    asn = {}
    for r in rows:
        d = r['dimensions']; ua = (d.get('userAgent') or '').lower()
        if 'elevenlabs' in ua:
            k = (d.get('clientCountryName'), ua[:120]); asn[k] = asn.get(k, 0) + r['count']
    for k, n in sorted(asn.items(), key=lambda kv: -kv[1])[:10]: print(n, k)
rows = q('userAgent clientRequestPath', 'files.foggypress.com')
print('\n-- sample paths for unnamed bot UAs')
c = 0
for r in rows:
    ua = r['dimensions'].get('userAgent') or ''
    if is_bot(ua) and not named(ua) and c < 15:
        print(r['count'], r['dimensions']['clientRequestPath'][:100], '|', ua); c += 1
