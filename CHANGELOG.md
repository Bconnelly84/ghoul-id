# Changelog

## 2.4.0 — online discovery hardening
- Added Bing and DuckDuckGo to automatic unknown-code discovery and in-app search options.
- Extracted candidate parsing and ranking into `online-discovery.js` so the logic can be tested independently from the React Native UI.
- Grouped Google, Bing, and DuckDuckGo into one general-search evidence family; repeated results within that family use only the strongest score.
- Added safe unwrapping for common DuckDuckGo, Bing, and Google redirect URLs when the result HTML exposes a destination.
- Added Node regression tests for result extraction, redirect unwrapping, and evidence-family scoring.
- Updated Android versionCode to 15.

# Ghoul ID 2.3.0 — Changes

- Added an automatic online-discovery attempt for an unknown UPC/model code. It requests accessible public search pages from Google, eBay, the Monster High Wiki, Mattel Product Support, and a Mattel-focused web search.
- Added a candidate ranking step that favors product-like titles, model-code mentions, exact-code mentions in nearby page text, and repeated candidate names across search sources.
- Added a sequential confirmation flow: the highest-ranked candidate is suggested first; rejecting it moves to the next; confirming saves a user-confirmed candidate locally with its source links.
- Confirmed online candidates remain explicitly marked as user-confirmed but not independently verified. Source links are preserved on the detail screen.
- If the sites block automatic reading or return no parseable results, Ghoul ID explains that and keeps the in-app source-search fallbacks available.
- Updated project/app version to 2.3.0 (Android version code 14).

## Verification performed

- TypeScript parser JSX/syntax check: passed.
- JSON validation for catalog, discovery queue, release calendar, app config, and package manifest: passed.
- YAML parsing for GitHub Actions workflows: passed.

## Important limitations

- This environment could not complete `npm install`, so an Expo/Android build and on-device test were not performed.
- Live search requests from an Android device have not been tested here. Search engines and marketplaces can block automated HTML access, use dynamic markup, or return consent pages; the candidate ranking only works when a source returns readable result HTML. The app retains source-search fallbacks for those cases.
- Candidate scores are heuristics, not a statistical probability. The app does not call a paid API or claim independent verification.
- The bundled catalog remains an expanding index, not a guaranteed complete historical archive.

## 2.4.0 — online discovery hardening

- Added Bing and DuckDuckGo to automatic unknown-code discovery and in-app search options.
- Extracted candidate parsing and ranking into `online-discovery.js` so the logic can be tested independently from the React Native UI.
- Grouped Google, Bing, and DuckDuckGo into one general-search evidence family; repeated results within that family use only the strongest score.
- Added safe unwrapping for common DuckDuckGo, Bing, and Google redirect URLs when the result HTML exposes a destination.
- Added Node regression tests for result extraction, redirect unwrapping, and evidence-family scoring.
- Updated Android versionCode to 15.
