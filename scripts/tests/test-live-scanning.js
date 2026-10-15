const fs = require('fs');
const assert = require('assert');
const app = fs.readFileSync('App.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const expo = JSON.parse(fs.readFileSync('app.json', 'utf8'));
const { parseBarcodeCandidate, getBarcodeBounds } = require('../../scanner-utils');

assert.match(app, /CameraView[\s\S]*onBarcodeScanned=\{handleBarcodeDetected\}/, 'Scanner must use live barcode detection');
assert.doesNotMatch(app, /takePictureAsync\s*\(/, 'Live scanner must not take repeated photos');
assert.doesNotMatch(app, /setInterval\s*\([\s\S]{0,160}runLiveOcr/, 'No periodic OCR loop should run in the scanner');
assert.match(app, /SCAN_DELAY_OPTIONS\s*=\s*\[500, 900, 1500, 2000\]/, 'Delay choices should be configurable');
assert.match(app, /scannerStatus/, 'Scanner must show diagnostic status');
assert.match(app, /getBarcodeBounds\(event\)/, 'Scanner must normalize camera bounds/corner points');
assert.match(app, /position unavailable; using selectable yellow label/, 'Missing camera bounds must still show a selectable fallback overlay');
assert.match(app, /boundsFitPreview/, 'Overlay bounds must be checked against camera preview dimensions');
assert.match(app, /PHOTO FALLBACK: READ PRINTED TEXT/, 'OCR should remain an explicit fallback');
assert.match(app, /barcodeCandidates\.map\(\(item, index\) =>/, 'Multiple barcode candidates should be rendered');
assert.match(app, /item\.stable && setSelectedBarcode\(item\.normalized\)/, 'Candidates should require stability before selection');
assert.strictEqual(pkg.version, '2.7.1');
assert.strictEqual(expo.expo.version, '2.7.1');
assert.strictEqual(expo.expo.android.versionCode, 19);

assert.deepStrictEqual(parseBarcodeCandidate('194735256648'), {raw:'194735256648', digits:'194735256648', checksumValid:true});
// Invalid check digits are still offered for lookup instead of silently discarded.
assert.deepStrictEqual(parseBarcodeCandidate('194735333367'), {raw:'194735333367', digits:'194735333367', checksumValid:false});
assert.strictEqual(parseBarcodeCandidate('JHK55'), null);
assert.deepStrictEqual(getBarcodeBounds({cornerPoints:[{x:20,y:30},{x:120,y:30},{x:120,y:70},{x:20,y:70}]}), {origin:{x:20,y:30},size:{width:100,height:40}});
assert.deepStrictEqual(getBarcodeBounds({bounds:{x:5,y:10,width:50,height:20}}), {origin:{x:5,y:10},size:{width:50,height:20}});
assert.deepStrictEqual(getBarcodeBounds({bounds:{origin:{x:1,y:2},size:{width:3,height:4}}}), {origin:{x:1,y:2},size:{width:3,height:4}});
console.log('Live scanner regression checks passed.');
