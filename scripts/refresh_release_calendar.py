#!/usr/bin/env python3
"""Refresh release dates from public official Mattel Creations product pages.

Only dates explicitly stated on an official product page are promoted to the
release calendar. Unparseable dates are ignored rather than guessed.
"""
import json, re, sys, time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from bs4 import BeautifulSoup

CALENDAR_URL = 'https://creations.mattel.com/pages/launch-calendar'
OUT = 'release-calendar.json'
UA = 'GhoulIDCatalogUpdater/1.0 (public collector project; respectful low-rate fetch)'


def fetch(url):
    req = Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml'})
    with urlopen(req, timeout=25) as resp:
        if resp.status != 200:
            raise RuntimeError(f'HTTP {resp.status} for {url}')
        return resp.read().decode('utf-8', errors='replace')


def date_from_text(text):
    # Prefer the public-sale date; fall back to a generic official launch date.
    patterns = [
        r'Public\s+access\s+begins\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})',
        r'Public\s*:\s*([A-Z][a-z]+\s+\d{1,2},\s+\d{4})',
        r'Launches\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})',
        r'Available\s+to\s+the\s+general\s+public\s+(?:beginning\s+)?([A-Z][a-z]+\s+\d{1,2},\s+\d{4})',
    ]
    for pattern in patterns:
        m = re.search(pattern, text, re.I)
        if m:
            try:
                return datetime.strptime(m.group(1), '%B %d, %Y').date().isoformat()
            except ValueError:
                pass
    return None


def main():
    try:
        calendar_html = fetch(CALENDAR_URL)
    except Exception as exc:
        print(f'Could not fetch Mattel calendar: {exc}', file=sys.stderr)
        sys.exit(1)

    soup = BeautifulSoup(calendar_html, 'html.parser')
    product_urls = set()
    for a in soup.find_all('a', href=True):
        url = urljoin(CALENDAR_URL, a['href'].split('?')[0])
        host = urlparse(url).netloc.lower()
        if 'creations.mattel.com' in host and '/products/' in url and 'monster-high' in url.lower():
            product_urls.add(url)

    try:
        existing = json.load(open(OUT, encoding='utf-8'))
        if not isinstance(existing, list): existing = []
    except (FileNotFoundError, json.JSONDecodeError):
        existing = []
    merged = {str(x.get('id') or x.get('officialUrl') or x.get('name')): x for x in existing if isinstance(x, dict)}
    discovered = 0
    for url in sorted(product_urls):
        try:
            page = BeautifulSoup(fetch(url), 'html.parser')
            title = (page.title.get_text(' ', strip=True) if page.title else '').split('|')[0].strip()
            text = page.get_text(' ', strip=True)
            # Restrict the calendar to doll or doll-containing set pages.
            if not title or 'monster high' not in (title + ' ' + url).lower():
                continue
            if not any(word in (title + ' ' + text[:2500]).lower() for word in ['doll', '2-pack', 'two-pack', 'dolls']):
                continue
            release_date = date_from_text(text)
            if not release_date:
                continue
            slug = urlparse(url).path.rstrip('/').split('/')[-1]
            record = {
                'id': 'mattel-' + slug,
                'name': re.sub(r'\s+', ' ', title).strip(),
                'releaseDate': release_date,
                'status': 'official-date-extracted',
                'verified': True,
                'officialUrl': url,
                'sourceUrl': url,
                'lastChecked': datetime.now(timezone.utc).isoformat(),
            }
            existing_key = next((key for key, value in merged.items() if value.get('officialUrl') == url), None)
            if existing_key:
                previous = merged[existing_key]
                record['id'] = previous.get('id') or record['id']
                merged.pop(existing_key, None)
            merged[record['id']] = record
            discovered += 1
            time.sleep(0.4)
        except Exception as exc:
            print(f'Skipping {url}: {exc}', file=sys.stderr)

    result = sorted(merged.values(), key=lambda x: (str(x.get('releaseDate', '9999')), str(x.get('name', ''))))
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'Found {len(product_urls)} Monster High product URLs; extracted {discovered} official release dates; calendar now has {len(result)} records.')

if __name__ == '__main__':
    main()
