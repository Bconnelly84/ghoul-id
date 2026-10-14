# Changelog

## 2.5.0
- Fix bottom navigation overlap by using safe-area insets and including the bottom system-navigation inset in the tab bar height/padding.
- Enable Android edge-to-edge layout explicitly so system-bar insets can be handled consistently on supported Android versions.
- Add catalog image source priority: official Mattel product image first, Monster High Wiki image as fallback.
- Catalog thumbnails and product details now retry the Wiki image if the official image fails to load.
- Add scheduled catalog image enrichment that discovers official product-page images first and queries Wiki page images only as contingency, then publishes URLs in catalog.json.
- Add automated tests for image priority, deduplication, and fallback behavior.
