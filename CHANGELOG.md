# Changelog

## 2.6.0
- Restore live barcode-first scanning using Expo Camera's barcode detector; the scanner no longer takes a photo every 2.2 seconds for background OCR.
- Keep printed-text OCR as an explicit photo/library fallback only.
- Preserve multi-barcode yellow overlays and manual selection before lookup.
- Make barcode stability delay configurable (500, 900, 1500, or 2000 ms), defaulting to 900 ms, and save the preference locally.
- Require recent repeated detections before a barcode becomes selectable; avoid auto-looking-up a code or closing the camera just because it was detected.
- Update Android versionCode to 17.


## 2.5.0
- Fix bottom navigation overlap by using safe-area insets and including the bottom system-navigation inset in the tab bar height/padding.
- Enable Android edge-to-edge layout explicitly so system-bar insets can be handled consistently on supported Android versions.
- Add catalog image source priority: official Mattel product image first, Monster High Wiki image as fallback.
- Catalog thumbnails and product details now retry the Wiki image if the official image fails to load.
- Add scheduled catalog image enrichment that discovers official product-page images first and queries Wiki page images only as contingency, then publishes URLs in catalog.json.
- Add automated tests for image priority, deduplication, and fallback behavior.


## 2.7.0 — Scanner and catalog-image reliability fixes

- Accept UPC/EAN-shaped numeric barcodes even when the check digit is invalid; show a warning rather than silently discarding a camera detection.
- Normalize scanner bounds from either `bounds`, `boundingBox`, or `cornerPoints`.
- Replace the narrow 450 ms repeat-event requirement with a configurable delay and a wider freshness window.
- Show scanner event count/status and camera mount errors to make failures diagnosable.
- Add official Mattel Shopify predictive-search image discovery before the Monster High Wiki fallback.
- Add a separate manually runnable/scheduled image-refresh workflow so image enrichment is not blocked by product-discovery workflow failures.
- Important: the bundled catalog currently has zero image URLs; those URLs are added only after the image workflow successfully retrieves them.
