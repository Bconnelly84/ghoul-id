#!/usr/bin/env python3
"""Discover current doll and doll-containing-set product pages from Mattel.

Only public Mattel collection/product pages are read. Product pages are added
when the product title clearly describes a doll, doll multipack, or playset.
The script never invents model codes, UPCs, or release dates. Site layout can
change, so the Wiki index remains a separate catalog source.
"""
import json, re, sys, time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse, quote
from urllib.request import Request, urlopen
from bs4 import BeautifulSoup

COLLECTIONS = [
    'https://shop.mattel.com/collections/monster-high',
    'https://creations.mattel.com/collections/monster-high',
    'https://creations.mattel.com/pages/launch-calendar',
]
CATALOG = 'catalog.json'
UA = 'GhoulIDCatalogUpdater/1.1 (public collector project; low-rate source refresh)'
EXCLUDE = ('accessory pack', 'accessory set', 'fashion pack', 'clothing pack', 'pet only', 'replacement part', 'doll stand', 'vinyl figure', 'apparel', 'hairbrush')
INCLUDE = ('doll', '2-pack', 'two-pack', '3-pack', 'three-pack', '4-pack', 'playset', 'doll set', 'dolls')


def fetch(url):
    req = Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml'})
    with urlopen(req, timeout=35) as resp:
        if resp.status != 200:
            raise RuntimeError(f'HTTP {resp.status} for {url}')
        return resp.read().decode('utf-8', errors='replace')


def load_catalog():
    try:
        with open(CATALOG, encoding='utf-8') as f: data = json.load(f)
    except (OSError, json.JSONDecodeError): data = []
    if not isinstance(data, list): raise RuntimeError('catalog.json must be a JSON array')
    return data


def clean_title(value):
    value = re.sub(r'\s+', ' ', value or '').strip()
    value = re.sub(r'\s*[|–-]\s*(Mattel|Monster High.*Mattel).*$','',value,flags=re.I).strip()
    value = re.sub(r'\s+(?:US\s*)?\$\s*\d+(?:\.\d{2})?\s*$', '', value, flags=re.I).strip()
    return value


def eligible(title):
    low = title.lower()
    return bool(any(k in low for k in INCLUDE) and not any(k in low for k in EXCLUDE))


def product_code_from_url(url):
    slug = urlparse(url).path.rstrip('/').split('/')[-1]
    match = re.search(r'-([a-z]{2,5}\d{2,5})$', slug, re.I)
    return match.group(1).upper() if match else ''


def main():
    catalog = load_catalog()
    by_id = {str(x.get('id') or x.get('mattelCode') or x.get('name')): x for x in catalog if isinstance(x, dict)}
    seen_urls = set()
    discovered = 0
    failed_sources = []
    for collection_url in COLLECTIONS:
        try:
            soup = BeautifulSoup(fetch(collection_url), 'html.parser')
        except Exception as exc:
            print(f'Could not read Mattel collection {collection_url}: {exc}', file=sys.stderr)
            failed_sources.append(collection_url)
            continue
        for anchor in soup.find_all('a', href=True):
            url = urljoin(collection_url, anchor['href'].split('?')[0])
            host = urlparse(url).netloc.lower()
            if host not in ('shop.mattel.com', 'creations.mattel.com') or '/products/' not in url or url in seen_urls:
                continue
            seen_urls.add(url)
            title = clean_title(anchor.get_text(' ', strip=True))
            if not eligible(title):
                # Use image alt text on this exact link only. Walking several ancestors
                # can accidentally borrow a neighbouring product card's title.
                alt = ' '.join(x.get('alt', '') for x in anchor.find_all('img') if x.get('alt'))
                title = clean_title(alt or title)
            if not title or not eligible(title):
                continue
            code = product_code_from_url(url)
            slug = urlparse(url).path.rstrip('/').split('/')[-1]
            record_id = 'mattel-' + slug.lower()
            record = {
                'id': record_id,
                'name': title,
                'character': '',
                'series': 'Mattel official catalog',
                'releaseYear': None,
                'releaseDate': None,
                'mattelCode': code or None,
                'codes': ([{'type':'mattel','value':code}] if code else []),
                'officialUrl': url,
                'referenceUrl': None,
                'wikiSearchUrl': 'https://monsterhigh.fandom.com/wiki/Special:Search?query=' + quote(title + (' ' + code if code else '')),
                'mattelSearchUrl': url,
                'itemType': 'set' if any(k in title.lower() for k in ('playset','2-pack','two-pack','3-pack','three-pack','4-pack','doll set','dolls')) else 'doll',
                'identifierConfidence': 'official-product-page',
                'source': 'Mattel official collection',
                'sourceUrls': [collection_url, url],
                'lastChecked': datetime.now(timezone.utc).isoformat(),
            }
            # Merge by official URL or model code, keeping existing Wiki UPCs/metadata.
            existing_key = next((k for k,v in by_id.items() if isinstance(v,dict) and (v.get('officialUrl') == url or (code and str(v.get('mattelCode') or '').upper() == code))), None)
            if existing_key:
                old = by_id[existing_key]
                for field, value in record.items():
                    if value not in (None, '', []) and (old.get(field) in (None, '', [])):
                        old[field] = value
                    elif field in ('sourceUrls',) and isinstance(old.get(field), list):
                        old[field] = sorted(set(old[field] + value))
                if url not in old.setdefault('sourceUrls', []): old['sourceUrls'].append(url)
            else:
                by_id[record_id] = record
                discovered += 1
            time.sleep(0.15)
    out = sorted(by_id.values(), key=lambda x: (int(x.get('releaseYear') or 9999), str(x.get('name') or '').lower()))
    with open(CATALOG, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2, ensure_ascii=False); f.write('\n')
    print(f'Mattel refresh complete: {discovered} new official product records; {len(out)} catalog records total; {len(seen_urls)} product URLs examined.')
    if failed_sources:
        print('Some sources were unavailable; existing catalog was preserved: ' + ', '.join(failed_sources), file=sys.stderr)

if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print(f'Mattel discovery failed: {exc}', file=sys.stderr)
        sys.exit(1)
