#!/usr/bin/env python3
"""Refresh Ghoul ID from the Monster High Wiki product-number index.

Only rows explicitly typed as doll multipacks or playsets containing dolls are
eligible for the main catalog. Rows without enough type evidence are kept in a
separate unverified discovery queue. UPCs are never inferred from model codes.
"""
import json, re, sys
from datetime import datetime, timezone
from urllib.parse import quote
from urllib.request import Request, urlopen
from bs4 import BeautifulSoup

URL = 'https://monsterhigh.fandom.com/wiki/Product_number'
CATALOG = 'catalog.json'
OUT = 'catalog-discovery.json'
UA = 'GhoulIDCatalogUpdater/1.1 (public collector project; low-rate source refresh)'
CODE_RE = re.compile(r'\b([A-Z]{1,5}\d{2,5}(?:-\d{3,5})?)\b', re.I)
EXCLUDE = ('fashion pack', 'accessory pack', 'accessories', 'shoes pack', 'pet pack', 'furniture', 'standalone pet', 'vehicle only', 'assortment')
DOLL_TYPE_RE = re.compile(r'-(\d+)D\b', re.I)
PLAYSET_TYPE_RE = re.compile(r'-(\d+)P\b', re.I)


def fetch(url):
    req = Request(url, headers={'User-Agent': UA, 'Accept': 'text/html'})
    with urlopen(req, timeout=35) as resp:
        if resp.status != 200:
            raise RuntimeError(f'HTTP {resp.status} for {url}')
        return resp.read().decode('utf-8', errors='replace')


def load_json(path, fallback):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return fallback


def norm(value):
    return re.sub(r'[^a-z0-9]+', '', str(value or '').lower())


def main():
    soup = BeautifulSoup(fetch(URL), 'html.parser')
    catalog = load_json(CATALOG, [])
    if not isinstance(catalog, list):
        raise RuntimeError('catalog.json must contain a JSON array')
    existing_by_code = {}
    for item in catalog:
        if not isinstance(item, dict):
            continue
        for code in [item.get('mattelCode')] + [x.get('value') for x in item.get('codes', []) if isinstance(x, dict) and x.get('type') == 'mattel']:
            if code:
                existing_by_code[norm(code)] = item

    candidates = {}
    additions = {}
    current_year = None
    # Track the most recent year heading for tables which follow it.
    for element in soup.find_all(['h2', 'h3', 'h4', 'table']):
        if element.name in ('h2', 'h3', 'h4'):
            heading = element.get_text(' ', strip=True)
            year_match = re.search(r'\b(20(?:1\d|2[0-6]))\b', heading)
            if year_match:
                current_year = int(year_match.group(1))
            continue
        last_explicit_type = ''
        for row in element.find_all('tr'):
            cells = row.find_all(['th', 'td'])
            if len(cells) < 2 or any(c.name == 'th' for c in cells):
                continue
            cell_texts = [c.get_text(' ', strip=True) for c in cells]
            if not any(cell_texts):
                continue
            first = cell_texts[0]
            if re.search(r'(?:Reg|StEx|OnEx|EvEx|CoEx|StEv|\?{3})', first, re.I) and ('Ass' in first or 'D' in first or 'P' in first):
                last_explicit_type = first
            type_text = first if first and ('Ass' in first or re.search(r'\d+[DP]', first)) else last_explicit_type
            doll_match = DOLL_TYPE_RE.search(type_text)
            playset_match = PLAYSET_TYPE_RE.search(type_text)
            is_doll = bool(doll_match and int(doll_match.group(1)) > 0)
            is_doll_playset = bool(playset_match and int(playset_match.group(1)) > 0)
            full_text = ' | '.join(cell_texts)
            lowered = full_text.lower()
            codes = [m.group(1).upper() for m in CODE_RE.finditer(full_text)]
            if not codes:
                continue
            # The item name is generally the last cell; avoid assortment rows and accessories.
            title = cell_texts[-1].strip()
            if not title or title.lower() in ('item', 'assortment') or any(word in lowered for word in EXCLUDE):
                continue
            if not (is_doll or is_doll_playset):
                # Preserve relevant-looking rows as review-only candidates; don't auto-promote.
                if any(k in lowered for k in ('doll', 'playset', '2-pack', 'three-pack', 'skullector')):
                    code = codes[-1]
                    key = norm(code) + '|' + norm(title)
                    candidates[key] = {
                        'candidateId': 'wiki-' + re.sub(r'[^a-z0-9]+', '-', (code + '-' + title).lower()).strip('-'),
                        'name': title,
                        'mattelCodeCandidate': code,
                        'allCodesSeenInRow': codes,
                        'wikiUrl': 'https://monsterhigh.fandom.com/wiki/Special:Search?query=' + quote(title + ' ' + code),
                        'sourceIndexUrl': URL,
                        'releaseYearCandidate': current_year,
                        'verificationStatus': 'needs-review',
                        'includedInMainCatalog': False,
                        'discoveredAt': datetime.now(timezone.utc).isoformat(),
                        'sourceRowText': full_text[:500],
                    }
                continue
            code = codes[-1]
            if title.lower() in ('assortment', 'playsets', 'dolls', 'semi-dolls'):
                continue
            key = norm(code)
            anchors = [a for c in cells for a in c.find_all('a', href=True) if a.get_text(' ', strip=True)]
            item_anchor = next((a for a in anchors if norm(a.get_text(' ', strip=True)) == norm(title)), None)
            href = item_anchor.get('href', '') if item_anchor else ''
            wiki_url = href if href.startswith('http') else ('https://monsterhigh.fandom.com' + href if href.startswith('/') else 'https://monsterhigh.fandom.com/wiki/Special:Search?query=' + quote(title + ' ' + code))
            series = cell_texts[-2].strip() if len(cell_texts) >= 4 else ''
            item_type = 'set' if is_doll_playset or (doll_match and int(doll_match.group(1)) > 1) else 'doll'
            record = {
                'id': 'mh-' + re.sub(r'[^a-z0-9]+', '-', code.lower()).strip('-'),
                'name': title if title.lower().startswith('monster high') else 'Monster High ' + title,
                'character': '',
                'series': series if series and series.lower() not in ('item', 'line') else '',
                'releaseYear': current_year,
                'mattelCode': code,
                'codes': [{'type': 'mattel', 'value': code}],
                'officialUrl': None,
                'referenceUrl': wiki_url,
                'wikiSearchUrl': 'https://monsterhigh.fandom.com/wiki/Special:Search?query=' + quote(title + ' ' + code),
                'mattelSearchUrl': 'https://www.google.com/search?q=' + quote('site:shop.mattel.com OR site:creations.mattel.com ' + title + ' ' + code),
                'itemType': item_type,
                'identifierConfidence': 'verified-product-number',
                'source': 'Monster High Wiki product-number index',
                'sourceIndexUrl': URL,
                'sourceRowText': full_text[:500],
            }
            if key in existing_by_code:
                # Preserve verified local metadata, but fill blank fields and attach source provenance.
                old = existing_by_code[key]
                for field, value in record.items():
                    if field == 'referenceUrl' and old.get(field) and 'Special:Search' in str(old[field]) and value and 'Special:Search' not in str(value):
                        old[field] = value
                    elif field not in old or old[field] in (None, '', []):
                        old[field] = value
                old.setdefault('sourceUrls', [])
                if URL not in old['sourceUrls']:
                    old['sourceUrls'].append(URL)
                continue
            additions[key] = record
            candidates.pop(key + '|' + norm(title), None)

    # Append newly indexed doll/set records without deleting manually curated entries.
    by_id = {str(x.get('id') or x.get('mattelCode') or x.get('name')): x for x in catalog if isinstance(x, dict)}
    for record in additions.values():
        by_id[record['id']] = record
    catalog_out = sorted(by_id.values(), key=lambda x: (int(x.get('releaseYear') or 9999), str(x.get('name') or '').lower(), str(x.get('mattelCode') or '')))
    with open(CATALOG, 'w', encoding='utf-8') as f:
        json.dump(catalog_out, f, indent=2, ensure_ascii=False); f.write('\n')
    review = sorted(candidates.values(), key=lambda x: (x['name'].lower(), x['mattelCodeCandidate']))
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(review, f, indent=2, ensure_ascii=False); f.write('\n')
    print(f'Wiki refresh complete: {len(additions)} catalog additions; {len(catalog_out)} catalog records total; {len(review)} review-only candidates.')

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Wiki discovery failed: {exc}', file=sys.stderr)
        sys.exit(1)
