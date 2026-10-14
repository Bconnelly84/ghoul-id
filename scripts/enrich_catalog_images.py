#!/usr/bin/env python3
"""Add product image URLs to catalog records: official Mattel first, Wiki fallback.

The script stores source-specific URLs and a selected imageUrl. It never downloads
or rehosts images; the app loads the source image directly. Existing working URLs
are retained if a source is temporarily unavailable.
"""
import json
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from bs4 import BeautifulSoup

CATALOG = 'catalog.json'
UA = 'GhoulIDCatalogUpdater/1.0 (+public collector catalog; low-rate requests)'
OFFICIAL_HOSTS = {'shop.mattel.com', 'creations.mattel.com'}


def fetch(url, accept='text/html,application/xhtml+xml,application/json'):
    request = Request(url, headers={'User-Agent': UA, 'Accept': accept})
    with urlopen(request, timeout=25) as response:
        if response.status != 200:
            raise RuntimeError(f'HTTP {response.status}')
        return response.read().decode('utf-8', errors='replace')


def clean_image_url(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith('//'):
        value = 'https:' + value
    if not re.match(r'^https?://', value, re.I):
        return None
    if any(token in value.lower() for token in ('logo', 'avatar', 'favicon', 'placeholder', 'icon-')):
        return None
    return value


def image_from_official_page(url):
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.netloc.lower().split(':')[0] not in OFFICIAL_HOSTS or '/products/' not in parsed.path:
        return None
    try:
        soup = BeautifulSoup(fetch(url), 'html.parser')
    except Exception as exc:
        print(f'Official image lookup failed for {url}: {exc}', file=sys.stderr)
        return None
    for selector in (
        ('meta', {'property': 'og:image'}),
        ('meta', {'name': 'twitter:image'}),
        ('meta', {'property': 'og:image:secure_url'}),
    ):
        tag = soup.find(*selector)
        if tag:
            candidate = clean_image_url(tag.get('content'))
            if candidate:
                return candidate
    for script in soup.find_all('script', type='application/ld+json'):
        try:
            data = json.loads(script.string or script.get_text())
        except (ValueError, TypeError):
            continue
        objects = data if isinstance(data, list) else [data]
        for obj in objects:
            if not isinstance(obj, dict):
                continue
            image = obj.get('image')
            candidates = image if isinstance(image, list) else [image]
            for item in candidates:
                if isinstance(item, dict):
                    item = item.get('url') or item.get('contentUrl')
                candidate = clean_image_url(item)
                if candidate:
                    return candidate
    return None


def image_from_wiki(product):
    title = str(product.get('name') or '').strip()
    code = str(product.get('mattelCode') or '').strip()
    if not title and not code:
        return None
    query = 'Monster High ' + (code + ' ' if code else '') + title
    params = urlencode({
        'action': 'query', 'format': 'json', 'generator': 'search',
        'gsrsearch': query, 'gsrnamespace': 0, 'gsrlimit': 5,
        'prop': 'pageimages', 'piprop': 'original|thumbnail', 'pithumbsize': 700,
    })
    api = 'https://monsterhigh.fandom.com/api.php?' + params
    try:
        data = json.loads(fetch(api, 'application/json'))
    except Exception as exc:
        print(f'Wiki image lookup failed for {title or code}: {exc}', file=sys.stderr)
        return None
    pages = (data.get('query') or {}).get('pages') or {}
    candidates = []
    for page in pages.values():
        image = page.get('original') or page.get('thumbnail') or {}
        url = clean_image_url(image.get('source'))
        page_title = str(page.get('title') or '').lower()
        # Prefer an article title with the Mattel code or a distinctive title token.
        title_tokens = [t for t in re.findall(r'[a-z0-9]+', title.lower()) if len(t) > 3]
        overlap = sum(1 for token in title_tokens if token in page_title)
        if code and code.lower() in page_title:
            overlap += 5
        if url:
            candidates.append((overlap, url))
    candidates.sort(reverse=True)
    return candidates[0][1] if candidates else None


def main():
    with open(CATALOG, encoding='utf-8') as handle:
        catalog = json.load(handle)
    if not isinstance(catalog, list):
        raise RuntimeError('catalog.json must contain a JSON array')
    checked = updated = official_count = wiki_count = 0
    failures = 0
    for product in catalog:
        if not isinstance(product, dict):
            continue
        checked += 1
        # Keep known good source URLs; retry only missing values to limit requests.
        if not product.get('officialImageUrl'):
            official = image_from_official_page(product.get('officialUrl'))
            if official:
                product['officialImageUrl'] = official
                official_count += 1
                updated += 1
        if not product.get('wikiImageUrl'):
            wiki = image_from_wiki(product)
            if wiki:
                product['wikiImageUrl'] = wiki
                wiki_count += 1
                updated += 1
        # Official source wins; Wiki is only the contingency image.
        selected = product.get('officialImageUrl') or product.get('wikiImageUrl')
        if selected and product.get('imageUrl') != selected:
            product['imageUrl'] = selected
            updated += 1
        if selected:
            product['imageSource'] = 'Mattel official' if product.get('officialImageUrl') else 'Monster High Wiki fallback'
        time.sleep(0.12)
    with open(CATALOG, 'w', encoding='utf-8') as handle:
        json.dump(catalog, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    print(f'Image enrichment checked {checked} records; added/updated {updated} image fields; official images found: {official_count}; Wiki fallbacks found: {wiki_count}.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Catalog image enrichment failed: {exc}', file=sys.stderr)
        sys.exit(1)
