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
from urllib.parse import urlencode, urlparse, urljoin
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from bs4 import BeautifulSoup

CATALOG = 'catalog.json'
UA = 'GhoulIDCatalogUpdater/1.0 (+public collector catalog; low-rate requests)'
OFFICIAL_HOSTS = {'shop.mattel.com', 'creations.mattel.com'}
OFFICIAL_SEARCH_HOSTS = ('https://shop.mattel.com', 'https://creations.mattel.com')


def fetch(url, accept='text/html,application/xhtml+xml,application/json'):
    request = Request(url, headers={'User-Agent': UA, 'Accept': accept})
    with urlopen(request, timeout=12) as response:
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



def image_url_is_broken(url):
    """Return True only for a definite dead/non-image URL; None for transient failures."""
    if not url:
        return False
    try:
        request = Request(url, headers={
            'User-Agent': UA,
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Range': 'bytes=0-0',
        })
        with urlopen(request, timeout=10) as response:
            content_type = (response.headers.get('Content-Type') or '').lower()
            if response.status in (404, 410):
                return True
            if content_type and not (content_type.startswith('image/') or 'octet-stream' in content_type):
                return True
            return False
    except HTTPError as exc:
        if exc.code in (404, 410):
            return True
        return None
    except Exception:
        # A timeout, rate limit, or bot block is not enough evidence to discard a known URL.
        return None


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



def image_from_official_search(product):
    """Use the public Shopify predictive-search endpoint on Mattel-owned stores.

    Search result images are only accepted when the result title/model code matches
    the catalog record. This avoids attaching an unrelated doll image to a product.
    """
    name = str(product.get('name') or '').strip()
    code = str(product.get('mattelCode') or '').strip()
    queries = [code] if code else []
    if name:
        queries.append(name)
    for base in OFFICIAL_SEARCH_HOSTS:
        for query in queries:
            params = urlencode({
                'q': query,
                'resources[type]': 'product',
                'resources[limit]': '8',
                'resources[options][unavailable_products]': 'show',
            })
            url = base + '/search/suggest.json?' + params
            try:
                data = json.loads(fetch(url, 'application/json'))
            except Exception as exc:
                print(f'Official search failed for {query}: {exc}', file=sys.stderr)
                continue
            results = ((data.get('resources') or {}).get('results') or {}).get('products') or []
            ranked = []
            for result in results:
                if not isinstance(result, dict):
                    continue
                title = str(result.get('title') or '')
                handle = str(result.get('url') or '')
                haystack = (title + ' ' + handle).lower()
                score = 0
                if code and code.lower() in haystack:
                    score += 10
                name_tokens = [t for t in re.findall(r'[a-z0-9]+', name.lower()) if len(t) > 3]
                score += sum(1 for token in name_tokens if token in haystack)
                image = result.get('image') or result.get('featured_image') or result.get('featuredImage')
                if isinstance(image, dict):
                    image = image.get('url') or image.get('src')
                if isinstance(image, str):
                    image = clean_image_url(urljoin(base, image))
                if image and score >= (10 if code else 1):
                    ranked.append((score, image))
            if ranked:
                ranked.sort(reverse=True)
                return ranked[0][1]
    return None

def image_from_wiki(product):
    """Find a product-specific Wiki page image; reject unrelated search-result thumbnails."""
    title = str(product.get('name') or '').strip()
    character = str(product.get('character') or '').strip()
    code = str(product.get('mattelCode') or '').strip()
    if not title and not character and not code:
        return None

    title_tokens = [t for t in re.findall(r'[a-z0-9]+', (title + ' ' + character).lower()) if len(t) > 3 and t not in {'monster', 'high', 'doll', 'with', 'accessories', 'accessory'}]
    queries = []
    if code:
        queries.append('"' + code + '" Monster High')
    if title:
        queries.append('"' + title + '"')
    if character:
        queries.append('"' + character + '" Monster High doll')

    best = None
    for query in queries:
        params = urlencode({
            'action': 'query', 'format': 'json', 'generator': 'search',
            'gsrsearch': query, 'gsrnamespace': 0, 'gsrlimit': 8,
            'prop': 'pageimages', 'piprop': 'original|thumbnail', 'pithumbsize': 700,
        })
        api = 'https://monsterhigh.fandom.com/api.php?' + params
        try:
            data = json.loads(fetch(api, 'application/json'))
        except Exception as exc:
            print(f'Wiki image lookup failed for {title or code}: {exc}', file=sys.stderr)
            continue
        pages = (data.get('query') or {}).get('pages') or {}
        for page in pages.values():
            image = page.get('original') or page.get('thumbnail') or {}
            url = clean_image_url(image.get('source'))
            page_title = str(page.get('title') or '').lower()
            overlap = sum(1 for token in title_tokens if token in page_title)
            if code and code.lower() in page_title:
                overlap += 5
            # A candidate needs a product-specific title match; don't use generic wiki images.
            if url and overlap >= (1 if len(title_tokens) <= 1 else 2):
                score = overlap + (2 if 'doll' in page_title else 0)
                if best is None or score > best[0]:
                    best = (score, url)
        if best and best[0] >= 5:
            break
    return best[1] if best else None


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
        # Refresh URLs that are definitely dead. Preserve URLs during transient blocks/timeouts.
        for field in ('officialImageUrl', 'wikiImageUrl'):
            existing = product.get(field)
            if existing and image_url_is_broken(existing) is True:
                print(f'Removing dead {field} for {product.get("name", product.get("id", "product"))}', file=sys.stderr)
                product.pop(field, None)
                updated += 1

        if not product.get('officialImageUrl'):
            official = image_from_official_page(product.get('officialUrl'))
            if not official:
                official = image_from_official_search(product)
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
        # Official source wins; Wiki is the explicit fallback when official is absent.
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
