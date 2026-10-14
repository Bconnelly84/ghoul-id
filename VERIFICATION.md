# Ghoul ID 2.6.0 verification notes

- Added source-level regression test `npm run test:scanner` to prevent the automatic camera photo/OCR interval from returning.
- Live scanning uses Expo Camera `onBarcodeScanned` for UPC-A, UPC-E, EAN-13, and EAN-8.
- Multi-barcode candidate overlays/list and manual selection remain enabled.
- Scan stability delay defaults to 900 ms and offers 500/900/1500/2000 ms options, persisted in AsyncStorage.
- Printed-text OCR remains a user-triggered photo/library fallback; it is not invoked automatically while scanning.
- Android versionCode is 17.
- This verification file documents static and mocked checks only; a physical Android device build/test is still required to confirm camera behavior and overlay coordinate alignment.
