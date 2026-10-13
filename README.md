# Monster High Scanner (starter)

A small Android app for scanning Monster High box barcodes and looking up codes.

## Current features
- Camera barcode scanning (UPC/EAN and common barcode types).
- Manual code entry for printed Mattel/product numbers.
- Local catalog matching from `catalog.json`.
- Web search fallback for unknown codes.
- Links to official Monster High and Mattel product support.

## Important catalog note
`catalog.json` starts empty intentionally. Add only verified code-to-product matches. The app does not pretend an unknown code identifies a specific doll. Printed manufacturing/lot codes may not identify the product.

Example catalog entry:
```json
[
  {
    "name": "Verified product name",
    "character": "Character name",
    "series": "Series name",
    "mattelCode": "Mattel product number",
    "codes": [
      { "type": "upc", "value": "012345678901" },
      { "type": "mattel", "value": "ABC12" }
    ],
    "officialUrl": "https://creations.mattel.com/...",
    "referenceUrl": "https://mhcollector.com/..."
  }
]
```
Replace example values with real, verified data; do not ship fake examples.

## Build on GitHub from an iPhone
1. Create a new GitHub repository in Safari.
2. Upload the contents of this ZIP to the repository's root (unzip first if GitHub's mobile interface permits; alternatively upload files individually).
3. Ensure the default branch is named `main`.
4. Open **Actions**, select **Build Android APK**, and run the workflow. It also runs on pushes to `main`.
5. Open the completed workflow run, download the `monster-high-scanner-apk` artifact, and extract it to obtain `app-release.apk`.
6. Transfer the APK to the Android phone and allow installation from the app used to open it.

GitHub-hosted Actions usage is subject to account quotas and current GitHub policies. This workflow is intended to use free public-repository CI where available. It does not require Expo EAS.

## Limitations in this first build
- Printed-code OCR is not implemented yet; printed numbers can be typed manually.
- Catalog is intentionally empty until verified data is collected.
- Internet is required for online searches and external product pages.
- APK has not been compiled or device-tested by this starter project generator.
