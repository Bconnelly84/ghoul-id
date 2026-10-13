# Ghoul ID

**Scan the box. Meet your ghoul.**

Ghoul ID is an independent Monster High collector companion. It is designed to build as an Android APK through GitHub Actions without Expo EAS, a paid API, an account, or a server.

## Included functionality

- Live camera barcode scanner using Expo Camera, with flashlight toggle and manual code entry.
- UPC/EAN and common barcode formats supported by the camera module.
- Normalized code matching for UPCs and printed Mattel/product numbers.
- Results screen for catalog matches and a careful unknown-code fallback.
- **SCAN NEXT ITEM** on the results screen to start another scan without returning to Home.
- Searchable catalog with series filters.
- Local owned list, wishlist, favorites, and private notes.
- Recent scan history.
- Local persistence through AsyncStorage; no sign-in or network backend required for core features.
- Official/reference links for seeded product records and unknown-code search.
- Dark gothic-neon styling, app icon, adaptive icon, and splash screen.

## What's included in this starter catalog

The bundled catalog currently seeds three Skullector entries: Killer Klowns from Outer Space — Shorty (JMG88), Corpse Bride — Emily (JDR67), and The Lost Boys (HRP88). This is a verified starter dataset, **not a complete Monster High database**. Expand `catalog.json` with additional sourced records over time. UPCs should be checked by scanning physical packaging before treating every barcode alias as fully validated. Do not use varying factory/lot identifiers as product IDs unless verified.

## Project structure

- `App.js` — app screens and logic
- `catalog.json` — local product data and code aliases
- `assets/` — app icon, adaptive icon, splash artwork
- `app.json` — Expo and Android configuration
- `package.json` — dependencies
- `.github/workflows/build-apk.yml` — automated release APK build

## Build an APK

Push the project files to the root of the GitHub repository. The workflow runs on pushes to `main` or can be started manually from **Actions**. It installs dependencies, generates the Android project, builds the release APK, and uploads the `ghoul-id-apk` artifact. Download the artifact ZIP from the successful workflow run and extract `app-release.apk`.

## Testing and limitations

- The JavaScript/JSX syntax and project JSON files have been checked. A full native build and camera/storage behavior still need Android device testing.
- Printed-text OCR is not implemented; use manual code entry when a code is printed but not barcoded.
- Product images are not bundled; product pages link to official/reference sources.
- Collection data is stored on that device and is not synced or backed up to a server.
- A successful GitHub build confirms packaging, not that all device-specific behavior has been tested.

## Ownership and trademarks

Ghoul ID is an independent fan/collector project and is not affiliated with or endorsed by Mattel. Monster High and related marks belong to their respective owners.


## OCR and product photos (v1.2.0)

- Printed-text OCR uses Google ML Kit on-device through `@react-native-ml-kit/text-recognition`; no OCR cloud API key or paid service is used.
- From Home, Scanner, or Scan Results, choose **Read Printed Text (OCR)**, then take a photo or choose one from the gallery. Review suggested code lines and tap one to look it up. OCR is assistive and may misread characters.
- Add a product photo from Scan Results or Doll Details. Photos are copied to app-private document storage where possible and their local paths are stored with the collection data. Catalog entries may optionally include `imageUrl` for a remotely hosted image.
- Local photos are not synced or backed up to a server. Uninstalling the app or clearing app data may remove them.
- Native OCR requires a fresh native Android build; it cannot be added to the previously downloaded APK without rebuilding.


## OCR identifier ranking (v1.3.0)

Printed-text OCR now ranks exact catalog matches first, then valid UPC/EAN/GTIN values, then likely Mattel-style model numbers. It normalizes valid UPC/EAN/GTIN equivalents (including a leading-zero UPC form commonly printed in carton GTIN-14 strings), while refusing to identify a doll from arbitrary numbers. Secondary packaging/lot identifiers such as HF batch codes are excluded from suggestions. OCR is still a suggestion workflow: verify the printed code before relying on a match.


## v1.5.0 resale research

Scan results and doll details include a dynamic **View eBay Sold Listings** link. The query uses the matched product name, character, Mattel code, and/or scanned code, and opens eBay with sold/completed filters. Ghoul ID does not scrape eBay, calculate market values, or represent asking prices as completed sales; availability and sign-in behavior are controlled by eBay.


## v1.5.0 storage safeguards

- Adds a storage schema version and reads the previous v2/v1 keys during migration.
- Pauses automatic writes if saved collection JSON cannot be parsed, to avoid overwriting potentially recoverable data.
- Warns if collection storage fails.
- Verifies saved product photos were copied into the app documents directory; temporary picker URIs are no longer silently accepted as permanent saves.
