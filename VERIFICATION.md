# Ghoul ID 2.4.0 verification notes

Checks completed in this working copy:
- `node scripts/tests/test-online-discovery.js` passed. The tests cover candidate title extraction, DuckDuckGo redirect unwrapping, grouping Google/Bing/DuckDuckGo as one evidence family, and independent-source scoring.
- `online-discovery.js` is a standalone CommonJS module used by `App.js`, so candidate parsing/ranking can be tested without loading native React Native modules.
- `package.json`, `app.json`, `catalog.json`, `catalog-discovery.json`, and `release-calendar.json` parse as valid JSON.
- Python updater scripts compile successfully.
- App.js was checked for parse errors using the globally installed TypeScript parser in JSX mode.

Not completed / limitations:
- Live public search pages could not be reached from this environment (DNS/network lookup failed for Google, Bing, DuckDuckGo, and the Wiki). This is an environment limitation and does not prove the app's network calls will fail on a phone.
- No successful Expo dependency installation or Android APK build has been performed here.
- Automated HTML parsing remains best-effort. Search engines and sites can block automated requests or change their markup. Search pages shown in WebView remain a fallback; they are not equivalent to structured API results.
- Scores are heuristic ranking scores, not probabilities. Google, Bing, and DuckDuckGo are deliberately treated as one evidence family. User confirmation is stored as user-confirmed, not independently verified.
