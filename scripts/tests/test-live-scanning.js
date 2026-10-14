const fs = require('fs');
const assert = require('assert');
const app = fs.readFileSync('App.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const expo = JSON.parse(fs.readFileSync('app.json', 'utf8'));

assert.match(app, /CameraView[\s\S]*onBarcodeScanned=\{handleBarcodeDetected\}/, 'Scanner must use live barcode detection');
assert.doesNotMatch(app, /takePictureAsync\s*\(/, 'Live scanner must not take repeated photos');
assert.doesNotMatch(app, /setInterval\s*\([\s\S]{0,160}runLiveOcr/, 'No periodic OCR loop should run in the scanner');
assert.match(app, /SCAN_DELAY_OPTIONS\s*=\s*\[500, 900, 1500, 2000\]/, 'Delay choices should be configurable');
assert.match(app, /setScanDelayMs\(\[500, 900, 1500, 2000\]\.includes\(Number\(saved\.scanDelayMs\)\)/, 'Delay setting should load from local storage');
assert.match(app, /scanDelayMs\s*\}\s*ms/, 'Current delay should be shown in scanner guidance');
assert.match(app, /PHOTO FALLBACK: READ PRINTED TEXT/, 'OCR should remain an explicit fallback');
assert.match(app, /barcodeCandidates\.map\(item =>/, 'Multiple barcode candidates should be rendered');
assert.match(app, /item\.stable && setSelectedBarcode\(item\.normalized\)/, 'Candidates should require stability before selection');
assert.strictEqual(pkg.version, '2.6.0');
assert.strictEqual(expo.expo.version, '2.6.0');
assert.strictEqual(expo.expo.android.versionCode, 17);
console.log('Live scanner regression checks passed.');
