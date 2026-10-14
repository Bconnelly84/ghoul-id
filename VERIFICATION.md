# Ghoul ID 2.5.0 verification notes

## Implemented in source
- Bottom navigation adds the `react-native-safe-area-context` bottom inset to its height and bottom padding; `SafeAreaProvider` wraps the app. Android edge-to-edge is explicitly enabled so Android system navigation areas can be handled by safe-area insets.
- Catalog images use `officialImageUrl` first, then `imageUrl`, then `wikiImageUrl`. Failed image URLs are skipped so a Wiki fallback can load when the official image is unavailable.
- `scripts/enrich_catalog_images.py` attempts to read image metadata from direct official Mattel product pages first, then queries the Monster High Wiki page-image API for a fallback. It records source-specific URLs and sets `imageUrl` to the official image whenever available.
- The scheduled catalog workflow runs image enrichment before committing catalog updates.

## Checks to run
- `npm run test:discovery`
- `npm run test:images`
- `python -m py_compile scripts/discover_wiki_products.py scripts/discover_mattel_products.py scripts/enrich_catalog_images.py scripts/refresh_release_calendar.py`
- Parse `App.js` in JSX mode and validate all JSON and YAML files.

## Limitations
- Live image discovery depends on Mattel and Fandom/Fandom Wiki allowing requests from GitHub Actions. The script preserves existing image fields if a source fails, but newly discovered images require the workflow to run successfully.
- A successful Android build and physical-device check are still required to prove the bottom bar is correctly inset on phones with three-button navigation and gesture navigation. Source-level changes alone do not prove device behavior.
