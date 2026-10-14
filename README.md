# Ghoul ID v2.4.0

**Scan the box. Meet your ghoul.**

Ghoul ID is a free Android-first collector tool for identifying Monster High dolls and doll-containing sets from box barcodes or printed product codes. It does not require an account, paid API, or always-on server.

## Current app capabilities

- Barcode-first scanning with selectable detected barcodes and a stability delay.
- Bundled catalog plus online catalog refresh from the public repository JSON; the last successful download is cached for offline use.
- Browseable doll/set catalog with search, series filters, and product detail screens.
- Product details include available Mattel, Wiki, Google, eBay, and release-date links. Release dates are shown only when a sourced date is available; otherwise the app shows the release year or explains that a date is unavailable.
- Local Owned/Wishlist/Favorites, notes, photos, and scan history.
- Local notifications from dated release-calendar entries. These are on-device notifications, not remote push messages.

## Unknown barcode discovery

When a scanned code is not in the catalog, Ghoul ID attempts to request readable HTML from Google, eBay, the Monster High Wiki, Mattel Product Support, and a Mattel-focused search. It extracts likely product titles and ranks them using title relevance, nearby exact-code mentions, model-code patterns, and repeated names across the queried sources. The highest-ranked candidate is shown first. If the user rejects it, the next candidate is offered; if the user confirms it, the app saves the choice and available source links locally.

**This is best-effort crawling, not a guaranteed search API.** Search engines and retail sites can block automated requests, require JavaScript, show consent pages, or change markup. In those cases the app tells the user no readable candidates were returned and offers in-app search-page fallbacks. A candidate is not independently verified just because the user confirms it; the app labels it as user-confirmed and retains source links. Ranking scores are heuristics, not probabilities. No paid API or server is used.

## Catalog sources and scheduled updates

The combined catalog is intended to grow from the [Mattel Monster High collection](https://shop.mattel.com/collections/monster-high), [Mattel Creations Monster High collection](https://creations.mattel.com/collections/monster-high), and [Monster High Wiki product-number index](https://monsterhigh.fandom.com/wiki/Product_number). The scheduled GitHub Actions job checks public pages and adds eligible doll/multipack/playset records; ambiguous Wiki rows remain in `catalog-discovery.json`. Standalone accessories are not intended for the main catalog. Source markup and access can change, so this is an expanding index rather than a guarantee that every historical product is already represented.

The updater does not invent UPCs. A Mattel model code is stored as a model code, not falsely labelled as a UPC. Direct official product URLs are stored only when found on official pages. The catalog workflow runs daily and can be triggered manually in GitHub Actions. GitHub Actions limits apply; this is not a continuously running server.

## Release dates and alerts

Product details show a sourced exact `releaseDate` when available, otherwise the known `releaseYear`, or a clear unavailable message. Dates can change, so the official listing remains authoritative. The app can schedule local reminders for future dates in `release-calendar.json`. It cannot reliably send stock-availability alerts without a reliable unrestricted inventory feed.

## Build the Android APK

1. Upload the contents of this project folder to the root of `Bconnelly84/ghoul-id` on the `main` branch.
2. In GitHub, open **Actions** and run **Build Ghoul ID APK** (or push to `main`).
3. Download the generated `ghoul-id-apk` artifact from that workflow run.

An Android build can run in GitHub Actions without a paid API or dedicated server, subject to GitHub Actions usage limits.
