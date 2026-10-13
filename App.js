import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, Pressable, ScrollView, Linking, StyleSheet, Alert, KeyboardAvoidingView, Platform, Image, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import TextRecognition from '@react-native-ml-kit/text-recognition';

const CATALOG = require('./catalog.json');
const STORE_KEY = 'ghoul-id-v3';
const LEGACY_STORE_KEYS = ['ghoul-id-v2', 'ghoul-id-v1'];
const STORAGE_SCHEMA_VERSION = 1;
const PINK = '#ff36b9';
const TEAL = '#20d9e8';
const PURPLE = '#8b45d6';
const BG = '#100d17';
const PANEL = '#201729';

const normalize = value => String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
// UPC/EAN/GTIN carton labels can contain the same consumer UPC with leading zero(s).
// Compare the original value plus safe GTIN equivalents without guessing at arbitrary numbers.
const codeVariants = value => {
  const n = normalize(value);
  const variants = new Set([n]);
  if (/^0\d{12}$/.test(n)) variants.add(n.slice(1));       // EAN-13 with UPC leading zero
  if (/^00\d{12}$/.test(n)) variants.add(n.slice(2));     // GTIN-14 case code wrapping a UPC
  if (/^0\d{13}$/.test(n)) variants.add(n.slice(1));
  if (/^00\d{12}$/.test(n)) variants.add(n.slice(1));
  return variants;
};
const matchesCode = (product, code) => {
  const sought = codeVariants(code);
  return (product.codes || []).some(c => [...codeVariants(c.value)].some(v => sought.has(v)));
};
const isValidGtin = value => {
  const digits = String(value || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  const body = digits.slice(0, -1).split('').reverse().map(Number);
  const sum = body.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.slice(-1));
};
const findCatalogMatch = value => CATALOG.find(p => matchesCode(p, value)) || null;
const buildOcrSuggestions = lines => {
  const found = new Map();
  lines.forEach((line, lineIndex) => {
    const text = String(line || '').trim();
    const tokens = [];
    // Prefer complete Mattel/carton identifiers, then standalone Mattel model codes.
    const modelPattern = /\b[A-Z]{2,5}[\s-]?\d{2,5}(?:[\s-]?\d{2,5})?\b/ig;
    for (const match of text.matchAll(modelPattern)) tokens.push(match[0].trim());
    // Capture grouped UPC/EAN/GTIN strings while allowing spaces and hyphens between digits.
    const digitPattern = /(?:^|[^\d])((?:\d[\s-]?){7,13}\d)(?!\d)/g;
    for (const match of text.matchAll(digitPattern)) {
      const digits = match[1].replace(/\D/g, '');
      if ([8,12,13,14].includes(digits.length)) tokens.push(digits);
    }
    tokens.forEach(token => {
      const n = normalize(token);
      if (!n || /^[A-Z]{2,5}\d{2,5}HF\d$/i.test(n)) return; // packaging lot/batch identifiers are not doll IDs
      const match = findCatalogMatch(token);
      const numeric = /^\d+$/.test(n);
      const validBarcode = numeric && isValidGtin(n);
      const modelCode = /^[A-Z]{2,5}\d{2,5}(?:\d{2,5})?$/i.test(n);
      // Do not promote arbitrary long numbers unless they are a valid GTIN or a catalog match.
      if (numeric && !validBarcode && !match) return;
      if (!numeric && !modelCode && !match) return;
      const priority = match ? 100 : validBarcode ? 80 : modelCode ? 65 : 30;
      const key = n;
      const previous = found.get(key);
      if (!previous || priority > previous.priority) found.set(key, { value: token, normalized: n, line: text, lineIndex, priority, match, kind: match ? 'CATALOG MATCH' : validBarcode ? 'VALID BARCODE FORMAT' : 'POSSIBLE PRODUCT CODE' });
    });
  });
  return [...found.values()].sort((a,b) => b.priority - a.priority || a.lineIndex - b.lineIndex || a.normalized.localeCompare(b.normalized)).slice(0, 12);
};
const searchWeb = code => 'https://www.google.com/search?q=' + encodeURIComponent((code ? '"' + code + '" ' : '') + 'Monster High Mattel doll');
// Opens eBay's sold-only search; this does not scrape results or claim a calculated valuation.
const ebaySoldSearch = (product, scannedCode) => {
  const identity = [product?.name, product?.character, product?.mattelCode, scannedCode]
    .filter(Boolean).map(x => String(x).trim()).filter((x, i, a) => x && a.indexOf(x) === i);
  const keywords = [...new Set(['Monster High', ...identity])].join(' ');
  return 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(keywords).replace(/%20/g, '+') + '&LH_Sold=1&LH_Complete=1&_sop=13';
};

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [screen, setScreen] = useState('Home');
  const [scanning, setScanning] = useState(false);
  const [torch, setTorch] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [code, setCode] = useState('');
  const [lastScanned, setLastScanned] = useState('');
  const [query, setQuery] = useState('');
  const [seriesFilter, setSeriesFilter] = useState('All');
  const [collectionFilter, setCollectionFilter] = useState('All');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [previousProductScreen, setPreviousProductScreen] = useState('Catalog');
  const [owned, setOwned] = useState([]);
  const [wanted, setWanted] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [notes, setNotes] = useState({});
  const [history, setHistory] = useState([]);
  const [photos, setPhotos] = useState({});
  const [ocrLines, setOcrLines] = useState([]);
  const [ocrImageUri, setOcrImageUri] = useState(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [storageSafeToWrite, setStorageSafeToWrite] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        let raw = await AsyncStorage.getItem(STORE_KEY);
        if (!raw) {
          for (const legacyKey of LEGACY_STORE_KEYS) {
            raw = await AsyncStorage.getItem(legacyKey);
            if (raw) break;
          }
        }
        if (raw) {
          const saved = JSON.parse(raw);
          if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved collection has an unexpected format.');
          if (!active) return;
          setOwned(Array.isArray(saved.owned) ? saved.owned : []);
          setWanted(Array.isArray(saved.wanted) ? saved.wanted : []);
          setFavorites(Array.isArray(saved.favorites) ? saved.favorites : []);
          setNotes(saved.notes && typeof saved.notes === 'object' && !Array.isArray(saved.notes) ? saved.notes : {});
          setHistory(Array.isArray(saved.history) ? saved.history : []);
          setPhotos(saved.photos && typeof saved.photos === 'object' && !Array.isArray(saved.photos) ? saved.photos : {});
        }
        if (active) setStorageSafeToWrite(true);
      } catch (_) {
        // Never overwrite a possibly recoverable collection if its stored JSON is corrupt.
        if (active) { setStorageSafeToWrite(false); setStorageWarning(true); }
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!loaded || !storageSafeToWrite) return;
    AsyncStorage.setItem(STORE_KEY, JSON.stringify({ schemaVersion: STORAGE_SCHEMA_VERSION, owned, wanted, favorites, notes, history, photos }))
      .catch(() => { setStorageWarning(true); });
  }, [loaded, storageSafeToWrite, owned, wanted, favorites, notes, history, photos]);

  useEffect(() => {
    if (storageWarning) Alert.alert('Collection storage warning', 'Ghoul ID could not safely read or save the saved collection. To protect your data, it has paused automatic writes. Do not clear app data; we should investigate before attempting recovery.');
  }, [storageWarning]);

  const product = useMemo(() => code ? findCatalogMatch(code) : null, [code]);
  const productId = p => p.id || p.mattelCode || p.name;
  const isOwned = p => owned.includes(productId(p));
  const isWanted = p => wanted.includes(productId(p));
  const isFavorite = p => favorites.includes(productId(p));

  const saveHistory = value => {
    const entry = { code: value, at: new Date().toISOString(), productId: (findCatalogMatch(value) || {}).id || null };
    setHistory(prev => [entry, ...prev.filter(x => normalize(x.code) !== normalize(value))].slice(0, 50));
  };

  const acceptCode = value => {
    const clean = String(value || '').trim();
    if (!clean) { Alert.alert('Enter a code', 'Type a UPC or a printed Mattel/product code first.'); return; }
    setCode(clean); setManualCode(clean); setScanning(false); setScreen('Result'); saveHistory(clean);
  };

  const handleScan = ({ data }) => {
    if (!data || normalize(data) === normalize(lastScanned)) return;
    setLastScanned(String(data));
    acceptCode(String(data));
  };

  const startScan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) { Alert.alert('Camera permission needed', 'Allow camera access in Android settings to scan box barcodes.'); return; }
    }
    setCode(''); setManualCode(''); setLastScanned(''); setTorch(false); setScanning(true); setScreen('Scan');
  };

  const scanNext = () => startScan();
  const goHome = () => { setScanning(false); setScreen('Home'); };

  const persistImage = async uri => {
    if (!uri) throw new Error('No image URI was provided.');
    if (!FileSystem.documentDirectory) throw new Error('Permanent app storage is unavailable.');
    const dir = FileSystem.documentDirectory + 'ghoul-photos/';
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const extMatch = String(uri).match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const dest = dir + 'ghoul-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    await FileSystem.copyAsync({ from: uri, to: dest });
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists) throw new Error('Image copy could not be verified.');
    return dest;
  };

  const readPrintedText = async uri => {
    setOcrBusy(true);
    setOcrImageUri(uri);
    setOcrLines([]);
    setScreen('OCR');
    try {
      const result = await TextRecognition.recognize(uri);
      const rawText = String(result?.text || '');
      const fromBlocks = (result?.blocks || []).flatMap(block => (block.lines || []).map(line => String(line.text || '').trim())).filter(Boolean);
      const lines = [...new Set([ ...fromBlocks, ...rawText.split(/\r?\n/).map(x => x.trim()).filter(Boolean) ])].slice(0, 80);
      setOcrLines(lines);
      if (!lines.length) Alert.alert('No readable text found', 'Try a sharper, well-lit photo with the product code facing the camera.');
    } catch (error) {
      Alert.alert('Text recognition failed', 'Try another photo or enter the printed code manually.');
      setOcrLines([]);
    } finally { setOcrBusy(false); }
  };

  const captureForOCR = async source => {
    try {
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.9 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.9 });
      if (!result.canceled && result.assets?.[0]?.uri) await readPrintedText(result.assets[0].uri);
    } catch (_) { Alert.alert('Could not open images', 'Check camera or photo-library permissions in Android settings.'); }
  };

  const chooseProductPhoto = async (source, targetId) => {
    try {
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [3, 4], quality: 0.85 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [3, 4], quality: 0.85 });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const savedUri = await persistImage(result.assets[0].uri);
      setPhotos(prev => ({ ...prev, [targetId]: savedUri }));
      Alert.alert('Photo saved', 'Your product photo has been saved to this device for this item.');
    } catch (_) { Alert.alert('Photo not saved', 'Ghoul ID could not copy this image into permanent app storage. Try another photo. The temporary image was not saved to your collection.'); }
  };

  const askForProductPhoto = targetId => Alert.alert('Add product photo', 'Take a new photo or choose one from your library.', [
    { text: 'Take Photo', onPress: () => chooseProductPhoto('camera', targetId) },
    { text: 'Choose Photo', onPress: () => chooseProductPhoto('library', targetId) },
    { text: 'Cancel', style: 'cancel' }
  ]);

  const askForOCRPhoto = () => Alert.alert('Read printed text', 'Photograph the box or choose a photo. Ghoul ID will look for printed product numbers and UPCs.', [
    { text: 'Take Photo', onPress: () => captureForOCR('camera') },
    { text: 'Choose Photo', onPress: () => captureForOCR('library') },
    { text: 'Cancel', style: 'cancel' }
  ]);

  const ocrSuggestions = useMemo(() => buildOcrSuggestions(ocrLines), [ocrLines]);
  const acceptOCRLine = value => acceptCode(value);
  const openUrl = async url => { if (!url) return; try { await Linking.openURL(url); } catch (_) { Alert.alert('Could not open link', 'Please check your internet connection and try again.'); } };
  const toggle = (setter, list, p) => { const id = productId(p); setter(list.includes(id) ? list.filter(x => x !== id) : [...list, id]); };
  const updateStatus = (p, status) => {
    const id = productId(p);
    if (status === 'owned') { setOwned(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]); setWanted(prev => prev.filter(x => x !== id)); }
    else { setWanted(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]); setOwned(prev => prev.filter(x => x !== id)); }
  };

  const filteredCatalog = useMemo(() => CATALOG.filter(p => {
    const text = [p.name, p.character, p.series, p.mattelCode, ...(p.codes || []).map(c => c.value)].join(' ').toLowerCase();
    const q = query.trim().toLowerCase();
    const queryOk = !q || text.includes(q);
    const seriesOk = seriesFilter === 'All' || p.series === seriesFilter;
    const statusOk = collectionFilter === 'All' || (collectionFilter === 'Owned' && owned.includes(productId(p))) || (collectionFilter === 'Wanted' && wanted.includes(productId(p))) || (collectionFilter === 'Favorites' && favorites.includes(productId(p)));
    return queryOk && seriesOk && statusOk;
  }), [query, seriesFilter, collectionFilter, owned, wanted, favorites]);

  const Header = ({ subtitle }) => <View style={styles.header}><View style={styles.logoMark}><Text style={styles.logoSkull}>☠</Text><Text style={styles.logoBow}>♥</Text></View><Text style={styles.brand}>GHOUL<Text style={{color:PINK}}> ID</Text></Text><Text style={styles.tagline}>{subtitle || 'SCAN THE BOX. MEET YOUR GHOUL.'}</Text></View>;
  const Btn = ({ label, onPress, kind = 'pink', small = false }) => <Pressable onPress={onPress} style={[styles.button, kind === 'teal' && styles.buttonTeal, kind === 'purple' && styles.buttonPurple, kind === 'outline' && styles.buttonOutline, small && styles.buttonSmall]}><Text style={[styles.buttonText, kind === 'teal' && {color:'#07151a'}, kind === 'outline' && {color:'#f7d9f3'}]}>{label}</Text></Pressable>;
  const SectionTitle = ({ children }) => <Text style={styles.sectionTitle}>{children}</Text>;
  const ProductRow = ({ item, onPress }) => <Pressable onPress={onPress} style={styles.productRow}><View style={styles.productThumb}>{(photos[productId(item)] || item.imageUrl) ? <Image source={{uri:photos[productId(item)] || item.imageUrl}} style={styles.thumbImage} resizeMode="cover" /> : <Text style={styles.thumbSkull}>☠</Text>}</View><View style={{flex:1}}><Text style={styles.productTitle}>{item.name}</Text><Text style={styles.muted}>{[item.character, item.series, item.mattelCode].filter(Boolean).join(' • ')}</Text><Text style={styles.muted}>{isOwned(item) ? '✓ OWNED' : isWanted(item) ? '♡ WANTED' : isFavorite(item) ? '♥ FAVORITE' : 'CATALOG ENTRY'}</Text></View><Text style={styles.chevron}>›</Text></Pressable>;

  if (!permission && screen === 'Scan') return <SafeAreaView style={styles.container}><Text style={styles.body}>Preparing camera…</Text></SafeAreaView>;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {screen === 'Scan' && scanning ? (
          <View style={styles.scanScreen}>
            <View style={styles.scanTop}><Pressable onPress={goHome}><Text style={styles.navText}>‹ BACK</Text></Pressable><Text style={styles.screenTitle}>SCAN AN ITEM</Text><View style={{width:50}} /></View>
            <View style={styles.cameraFrame}>
              {permission?.granted ? <CameraView style={styles.camera} facing="back" enableTorch={torch} barcodeScannerSettings={{barcodeTypes:['ean13','ean8','upc_a','upc_e','code128','code39','qr','itf','pdf417','datamatrix']}} onBarcodeScanned={handleScan} /> : <View style={styles.permissionBox}><Text style={styles.body}>Camera access is needed to scan barcodes.</Text><Btn label="ALLOW CAMERA" onPress={requestPermission} /></View>}
              <View pointerEvents="none" style={styles.scanCorners}><View style={[styles.corner,styles.c1]}/><View style={[styles.corner,styles.c2]}/><View style={[styles.corner,styles.c3]}/><View style={[styles.corner,styles.c4]}/></View>
            </View>
            <Text style={styles.centerMuted}>Center the barcode inside the frame</Text>
            <View style={styles.scanControls}><Btn label={torch ? 'FLASH ON' : 'FLASH OFF'} kind="purple" onPress={() => setTorch(!torch)} small /><Btn label="CLOSE SCANNER" kind="outline" onPress={goHome} small /></View>
            <View style={styles.manualBox}><SectionTitle>CAN'T SCAN IT?</SectionTitle><TextInput value={manualCode} onChangeText={setManualCode} placeholder="Enter UPC or printed product code" placeholderTextColor="#988ba3" autoCapitalize="characters" style={styles.input} returnKeyType="search" onSubmitEditing={() => acceptCode(manualCode)} /><Btn label="LOOK UP CODE" onPress={() => acceptCode(manualCode)} /><Btn label="READ PRINTED TEXT FROM PHOTO" kind="purple" onPress={askForOCRPhoto} /></View>
          </View>
        ) : (
          <>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              {screen === 'Home' && <>
                <Header subtitle="SCAN THE BOX. MEET YOUR GHOUL." />
                <View style={styles.hero}><Text style={styles.heroEyebrow}>YOUR PERSONAL MONSTER HIGH COMPANION</Text><Text style={styles.heroTitle}>KNOW YOUR{ '\n'}<Text style={{color:PINK}}>GHOULS.</Text></Text><Text style={styles.body}>Scan box barcodes, identify dolls, and keep your collection in one spooky little place.</Text><Btn label="▦   SCAN BARCODE" kind="teal" onPress={startScan} /><Btn label="▤   READ PRINTED TEXT (OCR)" kind="purple" onPress={askForOCRPhoto} /><Btn label="⌕   IDENTIFY A CODE" onPress={() => {setCode('');setManualCode('');setScreen('Identify');}} /><Btn label="♡   MY COLLECTION" kind="purple" onPress={() => {setCollectionFilter('All');setScreen('Collection');}} /></View>
                <View style={styles.statsRow}><View style={styles.stat}><Text style={styles.statNum}>{CATALOG.length}</Text><Text style={styles.statLabel}>CATALOGED</Text></View><View style={styles.stat}><Text style={styles.statNum}>{owned.length}</Text><Text style={styles.statLabel}>OWNED</Text></View><View style={styles.stat}><Text style={styles.statNum}>{wanted.length}</Text><Text style={styles.statLabel}>WANTED</Text></View></View>
                <SectionTitle>QUICK ACCESS</SectionTitle><View style={styles.quickGrid}><Pressable style={styles.quickTile} onPress={() => setScreen('Catalog')}><Text style={styles.quickIcon}>▤</Text><Text style={styles.quickLabel}>CATALOG</Text></Pressable><Pressable style={styles.quickTile} onPress={() => {setCollectionFilter('Favorites');setScreen('Collection');}}><Text style={styles.quickIcon}>♥</Text><Text style={styles.quickLabel}>FAVORITES</Text></Pressable><Pressable style={styles.quickTile} onPress={() => setScreen('History')}><Text style={styles.quickIcon}>◷</Text><Text style={styles.quickLabel}>SCAN HISTORY</Text></Pressable><Pressable style={styles.quickTile} onPress={() => setScreen('Settings')}><Text style={styles.quickIcon}>⚙</Text><Text style={styles.quickLabel}>SETTINGS</Text></Pressable></View>
                <View style={styles.noteCard}><Text style={styles.noteTitle}>A NOTE FROM THE CRYPT</Text><Text style={styles.body}>Unknown codes stay unknown until we can verify them. Use online search to help identify new finds, then expand the catalog with confirmed information.</Text></View>
              </>}
              {screen === 'Identify' && <><TopBar title="IDENTIFY A CODE" onBack={goHome} /><Text style={styles.body}>Enter the UPC barcode, Mattel product number, or another clearly printed product code. Manufacturing and lot codes may not identify the doll.</Text><TextInput value={manualCode} onChangeText={setManualCode} placeholder="e.g. JMG88 or UPC" placeholderTextColor="#988ba3" autoCapitalize="characters" style={styles.input} onSubmitEditing={() => acceptCode(manualCode)} returnKeyType="search" /><Btn label="IDENTIFY CODE" onPress={() => acceptCode(manualCode)} /><Btn label="OPEN BARCODE SCANNER" kind="teal" onPress={startScan} /></>}
              {screen === 'Result' && <><TopBar title="SCAN RESULTS" onBack={goHome} /><View style={styles.resultHero}>{(photos[product ? productId(product) : 'code:'+normalize(code)] || product?.imageUrl) ? <Image source={{uri: photos[product ? productId(product) : 'code:'+normalize(code)] || product?.imageUrl}} style={styles.resultPhoto} resizeMode="contain" /> : null}<Text style={styles.resultLabel}>{product ? '✦ CATALOG MATCH' : '✧ UNIDENTIFIED CODE'}</Text><Text style={styles.scannedCode}>{code}</Text>{product ? <><Text style={styles.resultName}>{product.name}</Text><Text style={styles.body}>{[product.character, product.series, product.mattelCode].filter(Boolean).join(' • ')}</Text>{!!product.releaseYear && <Text style={styles.muted}>Release year: {product.releaseYear}</Text>}</> : <><Text style={styles.resultName}>Not in the catalog yet</Text><Text style={styles.body}>We captured the code, but we won't guess which doll it belongs to. Search the exact code online, or try another printed product number from the box.</Text><Btn label="SEARCH THIS CODE ONLINE ↗" onPress={() => openUrl(searchWeb(code))} /><Btn label="VIEW EBAY SOLD LISTINGS ↗" kind="teal" onPress={() => openUrl(ebaySoldSearch(null, code))} /><Btn label="MATTEL PRODUCT SUPPORT ↗" kind="outline" onPress={() => openUrl('https://service.mattel.com/')} /></>}</View>
                {product && <><View style={styles.actionGrid}><Btn label={isOwned(product) ? '✓ OWNED — TAP TO REMOVE' : '+ MARK AS OWNED'} kind="teal" onPress={() => updateStatus(product,'owned')} /><Btn label={isWanted(product) ? '♡ WISHLIST — TAP TO REMOVE' : '+ ADD TO WISHLIST'} kind="purple" onPress={() => updateStatus(product,'wanted')} /><Btn label={isFavorite(product) ? '♥ FAVORITED' : '♡ FAVORITE'} kind="outline" onPress={() => toggle(setFavorites,favorites,product)} /></View><Btn label="ADD / CHANGE PRODUCT PHOTO" kind="outline" onPress={() => askForProductPhoto(productId(product))} /><Btn label="VIEW EBAY SOLD LISTINGS ↗" kind="teal" onPress={() => openUrl(ebaySoldSearch(product, code))} />{product.officialUrl && <Btn label="OFFICIAL PRODUCT PAGE ↗" onPress={() => openUrl(product.officialUrl)} />}</>}
                {!product && <Btn label="SAVE PHOTO FOR THIS CODE" kind="outline" onPress={() => askForProductPhoto('code:'+normalize(code))} />}
                <Btn label="▤  READ PRINTED TEXT (OCR)" kind="purple" onPress={askForOCRPhoto} /><Btn label="↻  SCAN NEXT ITEM" kind="teal" onPress={scanNext} /><Btn label="BACK TO HOME" kind="outline" onPress={goHome} /></>}
              {screen === 'OCR' && <><TopBar title="PRINTED TEXT OCR" onBack={() => setScreen('Home')} /><Text style={styles.body}>Review the text detected in your photo. Tap a likely product code or UPC to look it up. Text recognition can misread characters, so check the code before relying on a match.</Text>{ocrImageUri ? <Image source={{uri:ocrImageUri}} style={styles.ocrPhoto} resizeMode="contain" /> : null}{ocrBusy ? <View style={styles.loadingBox}><ActivityIndicator size="large" color={PINK} /><Text style={styles.body}>Reading printed text…</Text></View> : <>{ocrLines.length ? <>{ocrSuggestions.length ? <><SectionTitle>BEST IDENTIFIER CANDIDATES</SectionTitle><Text style={styles.muted}>Catalog matches and valid barcode numbers appear first. Secondary carton/lot codes are deliberately deprioritized or ignored because they may identify packaging batches rather than the doll.</Text>{ocrSuggestions.map((item,i) => <Pressable key={'code'+item.normalized} style={styles.ocrCandidate} onPress={() => acceptOCRLine(item.value)}><Text style={styles.ocrCandidateLabel}>{item.kind} · TAP TO LOOK UP</Text><Text style={styles.productTitle}>{item.value}</Text>{item.match ? <Text style={styles.muted}>{item.match.name}</Text> : item.kind === 'VALID BARCODE FORMAT' ? <Text style={styles.muted}>Barcode format looks valid; catalog match not confirmed yet.</Text> : null}</Pressable>)}</> : <View style={styles.infoCard}><Text style={styles.productTitle}>No likely product identifiers found</Text><Text style={styles.body}>We found text, but none looked like a catalog code or valid UPC/EAN/GTIN. You can still review the text below or enter a code manually.</Text></View>}<SectionTitle>ALL RECOGNIZED TEXT</SectionTitle>{ocrLines.map((line,i) => <View key={'line'+i} style={styles.ocrLine}><Text style={styles.body}>{line}</Text></View>)}</> : <View style={styles.infoCard}><Text style={styles.productTitle}>No text ready yet</Text><Text style={styles.body}>Try a clear, well-lit photo with the product number facing the camera.</Text></View>}<Btn label="TRY ANOTHER PHOTO" kind="purple" onPress={askForOCRPhoto} /><Btn label="ENTER CODE MANUALLY" onPress={() => setScreen('Identify')} /></>}</>}
              {(screen === 'Catalog' || screen === 'Collection') && <><TopBar title={screen === 'Catalog' ? 'DOLL CATALOG' : 'MY COLLECTION'} onBack={goHome} /><TextInput value={query} onChangeText={setQuery} placeholder="Search names, characters, series, codes…" placeholderTextColor="#988ba3" style={styles.input} autoCapitalize="none" /><ScrollView horizontal showsHorizontalScrollIndicator={false} style={{maxHeight:48,marginBottom:12}} contentContainerStyle={{gap:8,alignItems:'center'}}>{['All', ...Array.from(new Set(CATALOG.map(p => p.series).filter(Boolean)))].map(s => <Pressable key={s} onPress={() => setSeriesFilter(s)} style={[styles.chip,seriesFilter===s && styles.chipActive]}><Text style={styles.chipText}>{s}</Text></Pressable>)}</ScrollView>{screen === 'Collection' && <View style={styles.filterRow}>{['All','Owned','Wanted','Favorites'].map(s => <Pressable key={s} onPress={() => setCollectionFilter(s)} style={[styles.chip,collectionFilter===s && styles.chipActive]}><Text style={styles.chipText}>{s}</Text></Pressable>)}</View>}{(screen === 'Collection' ? filteredCatalog.filter(p => collectionFilter === 'All' ? (isOwned(p) || isWanted(p) || isFavorite(p)) : (collectionFilter === 'Owned' && isOwned(p)) || (collectionFilter === 'Wanted' && isWanted(p)) || (collectionFilter === 'Favorites' && isFavorite(p))) : filteredCatalog).length ? (screen === 'Collection' ? filteredCatalog.filter(p => collectionFilter === 'All' ? (isOwned(p) || isWanted(p) || isFavorite(p)) : (collectionFilter === 'Owned' && isOwned(p)) || (collectionFilter === 'Wanted' && isWanted(p)) || (collectionFilter === 'Favorites' && isFavorite(p))) : filteredCatalog).map(p => <ProductRow key={productId(p)} item={p} onPress={() => {setSelectedProduct(p);setPreviousProductScreen(screen);setCode('');setScreen('Product');}} />) : <View style={styles.infoCard}><Text style={styles.productTitle}>{screen === 'Collection' ? 'Your collection is waiting' : 'No dolls found'}</Text><Text style={styles.body}>{screen==='Collection' ? 'Nothing matches this collection filter yet. Mark dolls as owned, wanted, or favorite after identifying them. Your saved dolls will appear here.' : 'Try another search. More verified catalog entries will be added over time.'}</Text></View>}</>}
              {screen === 'Product' && selectedProduct && <><TopBar title="DOLL DETAILS" onBack={() => setScreen(previousProductScreen)} /><View style={styles.resultHero}>{(photos[productId(selectedProduct)] || selectedProduct.imageUrl) ? <Image source={{uri:photos[productId(selectedProduct)] || selectedProduct.imageUrl}} style={styles.productPhoto} resizeMode="contain" /> : <View style={styles.bigSkull}><Text style={styles.bigSkullText}>☠</Text><Text style={styles.bigBow}>♥</Text></View>}<Text style={styles.resultName}>{selectedProduct.name}</Text><Text style={styles.body}>{[selectedProduct.character,selectedProduct.series,selectedProduct.mattelCode].filter(Boolean).join(' • ')}</Text>{!!selectedProduct.releaseYear && <Text style={styles.muted}>Release year: {selectedProduct.releaseYear}</Text>}{(selectedProduct.codes||[]).map(c => <Text key={c.type+c.value} style={styles.muted}>{c.type.toUpperCase()}: {c.value}</Text>)}</View><View style={styles.actionGrid}><Btn label={isOwned(selectedProduct)?'✓ OWNED — TAP TO REMOVE':'+ OWNED'} kind="teal" onPress={() => updateStatus(selectedProduct,'owned')} /><Btn label={isWanted(selectedProduct)?'♡ WANTED — TAP TO REMOVE':' + WISHLIST'} kind="purple" onPress={() => updateStatus(selectedProduct,'wanted')} /><Btn label={isFavorite(selectedProduct)?'♥ FAVORITE':'♡ FAVORITE'} kind="outline" onPress={() => toggle(setFavorites,favorites,selectedProduct)} /></View><Btn label="ADD / CHANGE PRODUCT PHOTO" kind="outline" onPress={() => askForProductPhoto(productId(selectedProduct))} /><TextInput value={notes[productId(selectedProduct)] || ''} onChangeText={v => setNotes(prev => ({...prev,[productId(selectedProduct)]:v}))} placeholder="Private notes about this doll…" placeholderTextColor="#988ba3" style={[styles.input,{minHeight:76,textAlignVertical:'top'}]} multiline /><Btn label="VIEW EBAY SOLD LISTINGS ↗" kind="teal" onPress={() => openUrl(ebaySoldSearch(selectedProduct, selectedProduct.mattelCode))} />{selectedProduct.officialUrl && <Btn label="OFFICIAL PRODUCT PAGE ↗" onPress={() => openUrl(selectedProduct.officialUrl)} />}{selectedProduct.referenceUrl && <Btn label="MONSTER HIGH WIKI REFERENCE ↗" kind="outline" onPress={() => openUrl(selectedProduct.referenceUrl)} />}</>}
              {screen === 'History' && <><TopBar title="SCAN HISTORY" onBack={goHome} />{history.length ? history.map((h,i) => <Pressable key={h.at+i} style={styles.productRow} onPress={() => {setCode(h.code);setManualCode(h.code);setScreen('Result');}}><View style={{flex:1}}><Text style={styles.productTitle}>{h.code}</Text><Text style={styles.muted}>{new Date(h.at).toLocaleString()}</Text></View><Text style={styles.chevron}>›</Text></Pressable>) : <Text style={styles.body}>Your recent scans will appear here.</Text>}<Btn label="CLEAR SCAN HISTORY" kind="outline" onPress={() => Alert.alert('Clear history?', 'This cannot be undone.', [{text:'Cancel',style:'cancel'},{text:'Clear',style:'destructive',onPress:()=>setHistory([])}])} /></>}
              {screen === 'Settings' && <><TopBar title="SETTINGS" onBack={goHome} /><View style={styles.infoCard}><Text style={styles.productTitle}>Your data stays on this device</Text><Text style={styles.body}>Your owned list, wishlist, favorites, notes, and scan history are saved locally. No account or paid server is required. Clearing app data may erase this information.</Text></View><Btn label="OFFICIAL MONSTER HIGH ↗" onPress={() => openUrl('https://creations.mattel.com/collections/monster-high')} /><Btn label="MATTEL PRODUCT SUPPORT ↗" kind="outline" onPress={() => openUrl('https://service.mattel.com/')} /><Btn label="RESET LOCAL APP DATA" kind="outline" onPress={() => Alert.alert('Reset Ghoul ID?', 'This erases your local collection, notes, favorites, and scan history.', [{text:'Cancel',style:'cancel'},{text:'Reset',style:'destructive',onPress:async()=>{setOwned([]);setWanted([]);setFavorites([]);setNotes({});setHistory([]);setPhotos({});await AsyncStorage.removeItem(STORE_KEY).catch(()=>{});}}])} /></>}
              <View style={styles.footer}><Text style={styles.footerBrand}>GHOUL ID</Text><Text style={styles.footerText}>SCAN • IDENTIFY • COLLECT</Text><Text style={styles.footerText}>Independent collector companion. Monster High and related trademarks belong to their respective owners.</Text></View>
            </ScrollView>
            {['Home','Catalog','Collection','Settings'].includes(screen) && <View style={styles.bottomNav}>{[['Home','⌂'],['Collection','♡'],['Catalog','▤'],['Settings','⚙']].map(([name,icon]) => <Pressable key={name} onPress={() => {setScanning(false);setScreen(name);if(name==='Collection')setCollectionFilter('All');}} style={styles.navItem}><Text style={[styles.navIcon,screen===name&&{color:PINK}]}>{icon}</Text><Text style={[styles.navLabel,screen===name&&{color:PINK}]}>{name.toUpperCase()}</Text></Pressable>)}</View>}
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function TopBar({ title, onBack }) { return <View style={styles.topBar}><Pressable onPress={onBack} style={styles.backButton}><Text style={styles.navText}>‹ BACK</Text></Pressable><Text style={styles.screenTitle}>{title}</Text><View style={{width:54}} /></View>; }

const styles = StyleSheet.create({
  container:{flex:1,backgroundColor:BG}, content:{padding:18,paddingBottom:28}, header:{alignItems:'center',paddingTop:8,paddingBottom:22}, logoMark:{width:76,height:68,borderWidth:2,borderColor:TEAL,borderRadius:20,alignItems:'center',justifyContent:'center',backgroundColor:'#1b1325',marginBottom:7},logoSkull:{fontSize:43,color:'#fff'},logoBow:{position:'absolute',right:4,top:0,color:PINK,fontSize:27,fontWeight:'900'},brand:{color:'#fff',fontSize:36,fontWeight:'900',letterSpacing:2},tagline:{color:'#d8c6e2',fontSize:10,fontWeight:'900',letterSpacing:2,marginTop:4},hero:{backgroundColor:PANEL,borderWidth:1,borderColor:'#58304f',borderRadius:22,padding:19,marginBottom:15},heroEyebrow:{color:TEAL,fontSize:9,fontWeight:'900',letterSpacing:1.5},heroTitle:{fontSize:37,fontWeight:'900',color:'#fff',lineHeight:40,marginTop:9,marginBottom:8},body:{color:'#d8cde0',fontSize:14,lineHeight:21,marginTop:4,marginBottom:6},button:{backgroundColor:PINK,borderRadius:12,paddingVertical:14,paddingHorizontal:14,alignItems:'center',justifyContent:'center',marginTop:9,minHeight:46},buttonTeal:{backgroundColor:TEAL},buttonPurple:{backgroundColor:PURPLE},buttonOutline:{backgroundColor:'transparent',borderWidth:1,borderColor:'#9e69a8'},buttonSmall:{paddingVertical:10,minHeight:38,flex:1},buttonText:{color:'#1b0d1b',fontSize:12,fontWeight:'900',letterSpacing:.5,textAlign:'center'},statsRow:{flexDirection:'row',gap:8,marginBottom:22},stat:{flex:1,backgroundColor:PANEL,borderRadius:13,padding:13,alignItems:'center'},statNum:{fontSize:24,color:PINK,fontWeight:'900'},statLabel:{fontSize:9,color:'#c9b7d2',fontWeight:'900',letterSpacing:1,marginTop:3},sectionTitle:{color:PINK,fontSize:11,fontWeight:'900',letterSpacing:1.8,marginTop:15,marginBottom:10},quickGrid:{flexDirection:'row',flexWrap:'wrap',gap:9},quickTile:{width:'48%',flexGrow:1,backgroundColor:PANEL,borderWidth:1,borderColor:'#3f2c4b',borderRadius:14,padding:14},quickIcon:{fontSize:24,color:TEAL},quickLabel:{fontSize:11,color:'#fff',fontWeight:'900',letterSpacing:1,marginTop:8},noteCard:{borderLeftWidth:3,borderLeftColor:TEAL,backgroundColor:'#191322',padding:13,marginTop:20,borderRadius:8},noteTitle:{fontSize:10,color:TEAL,fontWeight:'900',letterSpacing:1.5},topBar:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:20,paddingTop:4},backButton:{width:54},navText:{color:TEAL,fontSize:12,fontWeight:'900'},screenTitle:{color:'#fff',fontSize:15,fontWeight:'900',letterSpacing:1},input:{backgroundColor:'#241a30',borderWidth:1,borderColor:'#62486c',borderRadius:12,color:'#fff',paddingHorizontal:13,paddingVertical:13,fontSize:14,marginTop:10,marginBottom:7},scanScreen:{flex:1,padding:15},cameraFrame:{height:340,borderRadius:18,overflow:'hidden',backgroundColor:'#050408',borderWidth:1,borderColor:'#56344e',marginTop:10},camera:{flex:1},scanTop:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:9},scanCorners:{...StyleSheet.absoluteFillObject},corner:{position:'absolute',width:35,height:35,borderColor:PINK},c1:{top:18,left:18,borderTopWidth:4,borderLeftWidth:4,borderTopLeftRadius:8},c2:{top:18,right:18,borderTopWidth:4,borderRightWidth:4,borderTopRightRadius:8},c3:{bottom:18,left:18,borderBottomWidth:4,borderLeftWidth:4,borderBottomLeftRadius:8},c4:{bottom:18,right:18,borderBottomWidth:4,borderRightWidth:4,borderBottomRightRadius:8},centerMuted:{textAlign:'center',color:'#c4b4cf',fontSize:12,marginTop:10},scanControls:{flexDirection:'row',gap:10,marginTop:5},manualBox:{marginTop:12},permissionBox:{flex:1,alignItems:'center',justifyContent:'center',padding:20},resultHero:{backgroundColor:PANEL,borderRadius:18,borderWidth:1,borderColor:'#753d73',padding:18,marginBottom:10},resultLabel:{color:TEAL,fontWeight:'900',fontSize:10,letterSpacing:1.5},scannedCode:{fontSize:25,color:PINK,fontWeight:'900',marginTop:8,marginBottom:8},resultName:{fontSize:20,color:'#fff',fontWeight:'900',marginTop:4},muted:{color:'#b9a9c5',fontSize:11,lineHeight:16,marginTop:4},actionGrid:{gap:2,marginVertical:7},chip:{paddingHorizontal:13,paddingVertical:9,borderRadius:20,backgroundColor:'#2a2034',borderWidth:1,borderColor:'#594463'},chipActive:{backgroundColor:'#7e276d',borderColor:PINK},chipText:{color:'#f5eaf9',fontSize:11,fontWeight:'800'},filterRow:{flexDirection:'row',flexWrap:'wrap',gap:7,marginBottom:12},productRow:{flexDirection:'row',alignItems:'center',gap:12,padding:12,backgroundColor:PANEL,borderRadius:13,borderWidth:1,borderColor:'#3d2d49',marginBottom:8},productThumb:{width:48,height:52,borderRadius:10,backgroundColor:'#32203e',alignItems:'center',justifyContent:'center',overflow:'hidden'},thumbImage:{width:'100%',height:'100%'},resultPhoto:{width:'100%',height:210,marginBottom:14,borderRadius:12,backgroundColor:'#17111f'},productPhoto:{width:'100%',height:260,marginBottom:12,borderRadius:12,backgroundColor:'#17111f'},ocrPhoto:{width:'100%',height:220,marginVertical:12,borderRadius:12,backgroundColor:'#17111f'},loadingBox:{padding:30,alignItems:'center',justifyContent:'center'},ocrCandidate:{backgroundColor:'#25172f',borderColor:PINK,borderWidth:1,borderRadius:12,padding:13,marginBottom:8},ocrCandidateLabel:{color:TEAL,fontSize:9,fontWeight:'900',letterSpacing:1,marginBottom:5},ocrLine:{padding:10,borderBottomWidth:1,borderBottomColor:'#302238'},thumbSkull:{fontSize:28,color:'#fff'},productTitle:{color:'#fff',fontSize:14,fontWeight:'900'},chevron:{color:PINK,fontSize:27},infoCard:{backgroundColor:PANEL,borderRadius:14,padding:16,borderWidth:1,borderColor:'#493653',marginTop:10},bigSkull:{height:120,alignItems:'center',justifyContent:'center'},bigSkullText:{fontSize:90,color:'#fff'},bigBow:{position:'absolute',right:'25%',top:7,color:PINK,fontSize:40},footer:{alignItems:'center',marginTop:27,paddingTop:15,borderTopWidth:1,borderTopColor:'#302238',gap:5},footerBrand:{color:PINK,fontSize:15,fontWeight:'900',letterSpacing:3},footerText:{color:'#897b94',fontSize:9,textAlign:'center',lineHeight:14},bottomNav:{height:62,backgroundColor:'#191321',borderTopWidth:1,borderTopColor:'#3a2a44',flexDirection:'row',justifyContent:'space-around',alignItems:'center'},navItem:{alignItems:'center',justifyContent:'center',flex:1},navIcon:{fontSize:20,color:'#a99bb4'},navLabel:{fontSize:8,color:'#a99bb4',fontWeight:'900',letterSpacing:.4,marginTop:2},filterRow:{gap:7},centerMuted:{textAlign:'center',color:'#c4b4cf',fontSize:12,marginTop:10}
});
