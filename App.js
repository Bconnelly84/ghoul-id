import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, Pressable, ScrollView, Linking, StyleSheet, Alert, KeyboardAvoidingView, Platform, Image, ActivityIndicator, BackHandler } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { getCatalogImageCandidates } from './catalog-images';
import { parseBarcodeCandidate, getBarcodeBounds } from './scanner-utils';
import { WebView } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import { extractWebCandidates, rankWebCandidates } from './online-discovery';

const CATALOG = require('./catalog.json');
const RELEASES = require('./release-calendar.json');
const REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/Bconnelly84/ghoul-id/main/catalog.json';
const REMOTE_RELEASES_URL = 'https://raw.githubusercontent.com/Bconnelly84/ghoul-id/main/release-calendar.json';
const REMOTE_DISCOVERY_URL = 'https://raw.githubusercontent.com/Bconnelly84/ghoul-id/main/catalog-discovery.json';
const CATALOG_CACHE_KEY = 'ghoul-id-remote-catalog-v1';
const RELEASE_CACHE_KEY = 'ghoul-id-remote-releases-v1';
const DISCOVERY_CACHE_KEY = 'ghoul-id-remote-discovery-v1';
const CATALOG_SYNC_KEY = 'ghoul-id-catalog-sync-at';
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
const formatReleaseDate = value => {
  if (!value) return '';
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
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
const searchQuery = code => (code ? '"' + String(code).trim() + '" ' : '') + 'Monster High Mattel doll';
const searchWeb = code => 'https://www.google.com/search?q=' + encodeURIComponent(searchQuery(code));
const searchBing = code => 'https://www.bing.com/search?q=' + encodeURIComponent(searchQuery(code));
const searchDuckDuckGo = code => 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(searchQuery(code));
const searchWiki = code => 'https://monsterhigh.fandom.com/wiki/Special:Search?query=' + encodeURIComponent(String(code || '').trim());
const searchMattel = code => 'https://www.google.com/search?q=' + encodeURIComponent('site:mattel.com OR site:shop.mattel.com OR site:creations.mattel.com ' + searchQuery(code));
const searchMattelSupport = code => 'https://service.mattel.com/us/results.aspx?N=4294967192&No=0&Ntk=Product&Ntt=' + encodeURIComponent(String(code || '').trim()) + '&Ntx=mode%2Bmatchany&Nty=1&showall=true&tab=Product';
const searchEbay = code => 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent('Monster High ' + String(code || '').trim()).replace(/%20/g, '+');
// Opens eBay's sold-only search; this does not scrape results or claim a calculated valuation.

const ebaySoldSearch = (product, scannedCode) => {
  const identity = [product?.name, product?.character, product?.mattelCode, scannedCode]
    .filter(Boolean).map(x => String(x).trim()).filter((x, i, a) => x && a.indexOf(x) === i);
  const keywords = [...new Set(['Monster High', ...identity])].join(' ');
  return 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(keywords).replace(/%20/g, '+') + '&LH_Sold=1&LH_Complete=1&_sop=13';
};

export default function App() {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const [failedCatalogImages, setFailedCatalogImages] = useState([]);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const barcodeSeenRef = useRef(new Map());
  const barcodeTimersRef = useRef(new Map());
  const [screen, setScreen] = useState('Home');
  const [scanning, setScanning] = useState(false);
  const [torch, setTorch] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [code, setCode] = useState('');
  const [lastScanned, setLastScanned] = useState('');
  const [barcodeCandidates, setBarcodeCandidates] = useState([]); // live detections + session queue
  const [selectedBarcode, setSelectedBarcode] = useState('');
  const [batchDuplicateCount, setBatchDuplicateCount] = useState(0);
  const [batchSessionLoaded, setBatchSessionLoaded] = useState(false);
  const [alternativeLookupExpanded, setAlternativeLookupExpanded] = useState(false);
  const batchLookupRef = useRef(false);
  const batchLastDuplicateRef = useRef(new Map());
  const BATCH_SESSION_KEY = 'ghoul-id-active-scan-session-v1';
  const [cameraLayout, setCameraLayout] = useState({ width: 0, height: 0 });
  const [query, setQuery] = useState('');
  const [seriesFilter, setSeriesFilter] = useState('All');
  const [catalogSort, setCatalogSort] = useState('name');
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
  const [selectedOcrCodes, setSelectedOcrCodes] = useState([]);
  const [customItems, setCustomItems] = useState([]);
  const [remoteCatalog, setRemoteCatalog] = useState([]);
  const [releaseItems, setReleaseItems] = useState(Array.isArray(RELEASES) ? RELEASES : []);
  const [discoveryItems, setDiscoveryItems] = useState([]);
  const [catalogSyncing, setCatalogSyncing] = useState(false);
  const [catalogSyncAt, setCatalogSyncAt] = useState('');
  const [webSearchUrl, setWebSearchUrl] = useState('');
  const [webSearchTitle, setWebSearchTitle] = useState('');
  const [onlineCandidates, setOnlineCandidates] = useState([]);
  const [onlineCandidateIndex, setOnlineCandidateIndex] = useState(0);
  const [onlineSearchBusy, setOnlineSearchBusy] = useState(false);
  const [onlineSearchMessage, setOnlineSearchMessage] = useState('');
  const onlineSearchKeyRef = useRef('');
  const [releaseNotificationsEnabled, setReleaseNotificationsEnabled] = useState(false);
  const [scanDelayMs, setScanDelayMs] = useState(900);
  const [scannerStatus, setScannerStatus] = useState('Camera ready — point it at a UPC/EAN barcode.');
  const [scannerEventCount, setScannerEventCount] = useState(0);
  const SCAN_DELAY_OPTIONS = [500, 900, 1500, 2000];
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
          setCustomItems(Array.isArray(saved.customItems) ? saved.customItems : []);
          setReleaseNotificationsEnabled(saved.releaseNotificationsEnabled === true);
          setScanDelayMs([500, 900, 1500, 2000].includes(Number(saved.scanDelayMs)) ? Number(saved.scanDelayMs) : 900);
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
    AsyncStorage.setItem(STORE_KEY, JSON.stringify({ schemaVersion: STORAGE_SCHEMA_VERSION, owned, wanted, favorites, notes, history, photos, customItems, releaseNotificationsEnabled, scanDelayMs }))
      .catch(() => { setStorageWarning(true); });
  }, [loaded, storageSafeToWrite, owned, wanted, favorites, notes, history, photos, customItems, releaseNotificationsEnabled, scanDelayMs]);

  useEffect(() => {
    if (storageWarning) Alert.alert('Collection storage warning', 'Ghoul ID could not safely read or save the saved collection. To protect your data, it has paused automatic writes. Do not clear app data; we should investigate before attempting recovery.');
  }, [storageWarning]);

  // Load the last successful remote catalog immediately, then refresh from the public
  // GitHub raw files. The bundled catalog remains available if the network is offline.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [cachedCatalog, cachedReleases, cachedAt, cachedDiscoveries] = await Promise.all([
          AsyncStorage.getItem(CATALOG_CACHE_KEY), AsyncStorage.getItem(RELEASE_CACHE_KEY), AsyncStorage.getItem(CATALOG_SYNC_KEY), AsyncStorage.getItem(DISCOVERY_CACHE_KEY)
        ]);
        if (active && cachedCatalog) { const parsed = JSON.parse(cachedCatalog); if (Array.isArray(parsed)) setRemoteCatalog(parsed); }
        if (active && cachedReleases) { const parsed = JSON.parse(cachedReleases); if (Array.isArray(parsed)) setReleaseItems(parsed); }
        if (active && cachedAt) setCatalogSyncAt(cachedAt);
        if (active && cachedDiscoveries) { const parsed = JSON.parse(cachedDiscoveries); if (Array.isArray(parsed)) setDiscoveryItems(parsed); }
      } catch (_) { /* Keep bundled catalog if cache is invalid. */ }
      if (active) refreshRemoteCatalog(false);
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }) });
  }, []);

  const refreshRemoteCatalog = async (showFeedback = true) => {
    if (catalogSyncing) return;
    setCatalogSyncing(true);
    try {
      const [catalogResponse, releasesResponse, discoveryResponse] = await Promise.all([
        fetch(REMOTE_CATALOG_URL, { headers: { Accept: 'application/json' } }),
        fetch(REMOTE_RELEASES_URL, { headers: { Accept: 'application/json' } }).catch(() => null),
        fetch(REMOTE_DISCOVERY_URL, { headers: { Accept: 'application/json' } }).catch(() => null)
      ]);
      if (!catalogResponse.ok) throw new Error('Remote catalog is not available yet.');
      const parsedCatalog = await catalogResponse.json();
      if (!Array.isArray(parsedCatalog) || !parsedCatalog.every(p => p && typeof p === 'object' && (p.id || p.name))) throw new Error('Remote catalog format was not valid.');
      setRemoteCatalog(parsedCatalog);
      await AsyncStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(parsedCatalog));
      if (releasesResponse?.ok) {
        const parsedReleases = await releasesResponse.json();
        if (Array.isArray(parsedReleases)) { setReleaseItems(parsedReleases); await AsyncStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify(parsedReleases)); if (releaseNotificationsEnabled) scheduleReleaseReminders(false, parsedReleases); }
      }
      if (discoveryResponse?.ok) { const parsedDiscoveries = await discoveryResponse.json(); if (Array.isArray(parsedDiscoveries)) { setDiscoveryItems(parsedDiscoveries); await AsyncStorage.setItem(DISCOVERY_CACHE_KEY, JSON.stringify(parsedDiscoveries)); } }
      const now = new Date().toISOString(); setCatalogSyncAt(now); await AsyncStorage.setItem(CATALOG_SYNC_KEY, now);
      if (showFeedback) Alert.alert('Catalog refreshed', `Loaded ${parsedCatalog.length} remotely published catalog entries. Your bundled catalog and saved collection remain intact.`);
    } catch (error) {
      if (showFeedback) Alert.alert('Using saved catalog', 'Ghoul ID could not refresh the online catalog. Your bundled and previously downloaded entries are still available. The remote file must exist in the public GitHub repository.');
    } finally { setCatalogSyncing(false); }
  };

  const scheduleReleaseReminders = async (showFeedback = true, itemsOverride = null) => {
    try {
      const permissionResult = await Notifications.requestPermissionsAsync();
      if (!permissionResult.granted) { Alert.alert('Notifications disabled', 'Allow notifications in Android settings to receive release reminders.'); return; }
      await Notifications.cancelAllScheduledNotificationsAsync();
      setReleaseNotificationsEnabled(true);
      const now = new Date(); let scheduled = 0;
      for (const item of (itemsOverride || releaseItems)) {
        if (!item || !item.releaseDate || !item.name) continue;
        const release = new Date(item.releaseDate + 'T09:00:00');
        if (Number.isNaN(release.getTime()) || release <= now) continue;
        const reminder = new Date(release.getTime() - 24 * 60 * 60 * 1000);
        const triggerDate = reminder > now ? reminder : release;
        await Notifications.scheduleNotificationAsync({ content: { title: 'A ghoul is almost here!', body: `${item.name} is listed for release ${item.releaseDate}. Check the official listing for changes.`, data: { productId: item.id || '', url: item.officialUrl || 'https://creations.mattel.com/pages/launch-calendar' } }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: triggerDate } });
        scheduled++;
      }
      if (showFeedback) Alert.alert('Release reminders updated', scheduled ? `${scheduled} local reminder(s) scheduled from the release dates in the catalog. Ghoul ID will refresh these when new release dates are downloaded.` : 'No future release dates are currently published in Ghoul ID. The reminder preference is saved and will apply when future dates are published.');
    } catch (_) { if (showFeedback) Alert.alert('Could not schedule reminders', 'Notifications could not be scheduled on this device.'); }
  };

  const productId = p => p.id || p.mattelCode || p.name;
  const catalogImageFor = p => getCatalogImageCandidates(p, failedCatalogImages)[0] || null;
  const markCatalogImageFailed = uri => { if (uri) setFailedCatalogImages(old => old.includes(uri) ? old : [...old, uri]); };
  const allProducts = useMemo(() => {
    const byId = new Map();
    [...CATALOG, ...remoteCatalog, ...customItems].forEach(p => {
      if (!p || !(p.id || p.mattelCode || p.name)) return;
      const modelCode = p.mattelCode || (p.codes || []).find(c => c && c.type === 'mattel')?.value;
      const upc = (p.codes || []).find(c => c && ['upc', 'ean', 'gtin'].includes(String(c.type).toLowerCase()))?.value;
      const key = modelCode ? 'model:' + normalize(modelCode) : upc ? 'barcode:' + normalize(upc) : 'id:' + (p.id || p.name);
      const previous = byId.get(key);
      // Merge cross-source entries by model code/UPC, keep the original stable ID
      // so Owned/Wishlist/Favorites survive a source adding a duplicate record.
      const merged = previous ? { ...previous, ...Object.fromEntries(Object.entries(p).filter(([, value]) => value !== null && value !== undefined && value !== '')) } : p;
      if (previous?.id) merged.id = previous.id;
      const mergedCodes = [...(previous?.codes || []), ...(p.codes || [])];
      if (mergedCodes.length) merged.codes = mergedCodes.filter((c, i, arr) => c && c.value && arr.findIndex(x => x && normalize(x.value) === normalize(c.value) && String(x.type).toLowerCase() === String(c.type).toLowerCase()) === i);
      byId.set(key, merged);
    });
    return [...byId.values()];
  }, [remoteCatalog, customItems]);
  const releaseInfoForProduct = p => {
    if (!p) return null;
    const codeKey = normalize(p.mattelCode || '');
    const nameKey = String(p.name || '').toLowerCase().replace(/^monster high[™®]?\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    return releaseItems.find(item => {
      const itemCode = normalize(item.mattelCode || item.productCode || '');
      if (codeKey && itemCode && codeKey === itemCode) return true;
      const itemName = String(item.name || '').toLowerCase().replace(/^monster high[™®]?\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
      return !!nameKey && !!itemName && nameKey === itemName;
    }) || null;
  };
  const officialUrlForProduct = p => p?.officialUrl || releaseInfoForProduct(p)?.officialUrl || null;
  const officialUrlLabelForProduct = p => {
    const url = officialUrlForProduct(p);
    return url && url.includes('/products/') ? 'OFFICIAL MATTEL PRODUCT PAGE ↗' : 'OFFICIAL MATTEL LAUNCH CALENDAR ↗';
  };
  const product = useMemo(() => code ? (allProducts.find(p => matchesCode(p, code)) || customItems.find(p => (p.codes || []).some(c => normalize(c.value) === normalize(code)) || normalize(p.mattelCode) === normalize(code)) || null) : null, [code, customItems, allProducts]);
  const isOwned = p => owned.includes(productId(p));
  const isWanted = p => wanted.includes(productId(p));
  const isFavorite = p => favorites.includes(productId(p));

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(BATCH_SESSION_KEY);
        if (active && raw) {
          const saved = JSON.parse(raw);
          if (Array.isArray(saved.items)) {
            setBarcodeCandidates(saved.items.filter(item => item && item.normalized && item.value));
            setBatchDuplicateCount(Number.isFinite(saved.duplicates) ? saved.duplicates : 0);
          }
        }
      } catch (_) { /* Ignore a damaged scanner-session cache; collection data remains untouched. */ }
      finally { if (active) setBatchSessionLoaded(true); }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!loaded || !batchSessionLoaded) return;
    AsyncStorage.setItem(BATCH_SESSION_KEY, JSON.stringify({ items: barcodeCandidates, duplicates: batchDuplicateCount, updatedAt: new Date().toISOString() })).catch(() => {});
  }, [barcodeCandidates, batchDuplicateCount, loaded, batchSessionLoaded]);

  const saveHistory = value => {
    const entry = { code: value, at: new Date().toISOString(), productId: (findCatalogMatch(value) || {}).id || null };
    setHistory(prev => [entry, ...prev.filter(x => normalize(x.code) !== normalize(value))].slice(0, 50));
  };

  const acceptCode = value => {
    const clean = String(value || '').trim();
    if (!clean) { Alert.alert('Enter a code', 'Type a UPC or a printed Mattel/product code first.'); return; }
    setCode(clean); setManualCode(clean); setScanning(false); setScreen('Result'); saveHistory(clean);
  };

  const lookupSelectedOcrCodes = () => {
    if (!selectedOcrCodes.length) { Alert.alert('Select a code', 'Choose one of the detected product codes first.'); return; }
    acceptCode(selectedOcrCodes[0]);
  };

  const saveUnknownToCollection = status => {
    const raw = String(code || '').trim();
    if (!raw) return;
    const id = 'custom-' + normalize(raw);
    const existing = customItems.find(p => p.id === id);
    const item = existing || { id, name: 'Unidentified Monster High item (' + raw + ')', character: 'Needs identification', series: 'Unverified', mattelCode: /^[A-Z]{2,5}\d{2,5}/i.test(raw) ? raw : '', codes: [{ type: /^\d+$/.test(normalize(raw)) ? 'upc' : 'mattel', value: raw }], officialUrl: null, referenceUrl: null, itemType: 'unverified', identifierConfidence: 'unverified' };
    if (!existing) setCustomItems(prev => [...prev, item]);
    const itemId = productId(item);
    if (status === 'owned') { setOwned(prev => prev.includes(itemId) ? prev : [...prev, itemId]); setWanted(prev => prev.filter(x => x !== itemId)); }
    else { setWanted(prev => prev.includes(itemId) ? prev : [...prev, itemId]); setOwned(prev => prev.filter(x => x !== itemId)); }
    Alert.alert(status === 'owned' ? 'Added to owned items' : 'Added to wishlist', 'Saved as an unidentified item. You can update its name after confirming the identity.');
  };

  const saveCandidateToWishlist = candidate => {
    const rawCode = String(candidate?.mattelCodeCandidate || '').trim();
    const name = String(candidate?.name || 'Unidentified Monster High candidate').trim();
    const id = String(candidate?.candidateId || ('candidate-' + normalize(rawCode + '-' + name)));
    const existing = customItems.find(p => p.id === id);
    const item = existing || { id, name: name + ' (unverified)', character: '', series: 'Needs verification', mattelCode: rawCode, codes: rawCode ? [{ type: 'mattel', value: rawCode }] : [], officialUrl: null, referenceUrl: candidate?.wikiUrl || null, itemType: 'unverified-candidate', identifierConfidence: 'unverified', sourceRowText: candidate?.sourceRowText || '' };
    if (!existing) setCustomItems(prev => [...prev, item]);
    setWanted(prev => prev.includes(id) ? prev : [...prev, id]);
    Alert.alert('Added to wishlist', 'This Wiki discovery is still unverified. It has been saved as a provisional wishlist item.');
  };

  // Live scanning only: accept barcode values reported by Expo Camera without
  // requiring a perfect checksum (damaged/poorly printed UPCs must still be selectable).
  // The delay prevents instant selection; it never takes a photo.
  const handleBarcodeDetected = event => {
    const raw = String(event?.data ?? '').trim();
    setScannerEventCount(count => count + 1);
    if (!raw) { setScannerStatus('Camera is active; waiting for a readable barcode.'); return; }
    const parsed = parseBarcodeCandidate(raw);
    const digits = parsed?.digits || '';
    if (!parsed) {
      setScannerStatus(`Camera detected ${String(event?.type || 'a code')}, but it was not an 8, 12, 13, or 14 digit UPC/EAN (${raw.slice(0, 24)}). Try the manual code field for printed model numbers.`);
      return;
    }
    const key = normalize(digits);
    const now = Date.now();
    const bounds = getBarcodeBounds(event);
    const previous = barcodeSeenRef.current.get(key);
    const firstSeen = previous && now - previous.lastSeen <= 2000 ? previous.firstSeen : now;
    barcodeSeenRef.current.set(key, { value: digits, bounds: bounds || previous?.bounds || null, lastSeen: now, firstSeen });
    setScannerStatus(`Live camera detected ${digits}${bounds ? ' with position data' : ' (position unavailable; using selectable yellow label)'}${parsed.checksumValid ? '' : ' — checksum warning, lookup still allowed'}. Hold steady for ${scanDelayMs} ms.`);
    setBarcodeCandidates(old => {
      const found = old.find(x => x.normalized === key);
      if (found) return old.map(x => x.normalized === key ? { ...x, value: digits, bounds: bounds || x.bounds, lastSeen: now, checksumValid: parsed.checksumValid } : x);
      return [...old, { value: digits, normalized: key, bounds, firstSeen, lastSeen: now, stable: false, checksumValid: parsed.checksumValid, scanCount: 1, status: 'pending', capturedAt: new Date(now).toISOString() }];
    });
    if (!barcodeTimersRef.current.has(key)) {
      const timer = setTimeout(() => {
        const seen = barcodeSeenRef.current.get(key);
        // Expo Camera may emit one event rather than continuous repeats. Allow a
        // 2-second freshness window instead of the old 450 ms race condition.
        if (seen && Date.now() - seen.lastSeen <= 2000 && Date.now() - seen.firstSeen >= scanDelayMs) {
          setBarcodeCandidates(old => {
            const existing = old.find(x => x.normalized === key);
            if (existing?.stable) {
              const lastCounted = batchLastDuplicateRef.current.get(key) || 0;
              if (Date.now() - lastCounted > 2500) {
                batchLastDuplicateRef.current.set(key, Date.now());
                setBatchDuplicateCount(count => count + 1);
              }
              return old.map(x => x.normalized === key ? { ...x, stable: true, lastSeen: Date.now() } : x);
            }
            return old.map(x => x.normalized === key ? { ...x, stable: true, status: findCatalogMatch(x.value) ? 'match-found' : 'needs-lookup' } : x);
          });
          setScannerStatus(`Barcode ${seen.value} added to this session. Tap its row to select it, or keep scanning.`);
        } else {
          setScannerStatus('Barcode moved out of view before the delay finished. Hold it steady and try again.');
        }
        barcodeTimersRef.current.delete(key);
      }, scanDelayMs);
      barcodeTimersRef.current.set(key, timer);
    }
  };

  const lookupBatchItem = item => {
    if (!item) return;
    batchLookupRef.current = true;
    setLastScanned(item.value);
    setCode(item.value);
    setManualCode(item.value);
    saveHistory(item.value);
    setScanning(false);
    setScreen('Result');
    setBarcodeCandidates(old => old.map(entry => entry.normalized === item.normalized ? { ...entry, status: findCatalogMatch(item.value) ? 'match-found' : 'needs-lookup', reviewedAt: new Date().toISOString() } : entry));
  };

  const lookupSelectedBarcode = () => {
    const chosen = barcodeCandidates.find(x => x.normalized === selectedBarcode && x.stable);
    if (!chosen) { Alert.alert('Choose a barcode', 'Wait for a barcode to stabilize, then select it from the session list.'); return; }
    lookupBatchItem(chosen);
  };

  const checkAllBatchCodes = () => {
    setBarcodeCandidates(old => old.map(item => ({ ...item, status: findCatalogMatch(item.value) ? 'match-found' : 'needs-lookup', checkedAt: new Date().toISOString() })));
    Alert.alert('Batch checked', 'Every scanned code was checked against the local catalog. Tap any row to review its details or investigate codes marked “Needs lookup”.');
  };

  const removeBatchItem = item => {
    setBarcodeCandidates(old => old.filter(entry => entry.normalized !== item.normalized));
    setSelectedBarcode(current => current === item.normalized ? '' : current);
  };

  const finishBatchSession = () => Alert.alert('Finish this session?', 'Your scanned-code list is saved on this device. You can clear it to start a fresh batch.', [
    { text: 'Keep Scanning', style: 'cancel' },
    { text: 'Clear Session', style: 'destructive', onPress: () => { barcodeTimersRef.current.forEach(timer => clearTimeout(timer)); barcodeTimersRef.current.clear(); barcodeSeenRef.current.clear(); batchLastDuplicateRef.current.clear(); setBarcodeCandidates([]); setSelectedBarcode(''); setBatchDuplicateCount(0); AsyncStorage.removeItem(BATCH_SESSION_KEY).catch(() => {}); } }
  ]);

  const startScan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) { Alert.alert('Camera permission needed', 'Allow camera access in Android settings to scan box barcodes.'); return; }
    }
    barcodeTimersRef.current.forEach(timer => clearTimeout(timer)); barcodeTimersRef.current.clear(); barcodeSeenRef.current.clear();
    setCode(''); setManualCode(''); setLastScanned(''); setSelectedBarcode(''); setSelectedOcrCodes([]); setTorch(false); setScannerEventCount(0); setScannerStatus('Camera ready — point it at a UPC/EAN barcode.'); setScanning(true); setScreen('Scan');
  };

  const scanNext = () => startScan();
  const goHome = () => { barcodeTimersRef.current.forEach(timer => clearTimeout(timer)); barcodeTimersRef.current.clear(); setScanning(false); setScreen('Home'); };

  const handleAndroidBack = () => {
    if (screen === 'Home') { BackHandler.exitApp(); return true; }
    if (screen === 'Product') { setScreen(previousProductScreen); return true; }
    if (screen === 'Result') { if (batchLookupRef.current) { batchLookupRef.current = false; setScanning(true); setScreen('Scan'); } else goHome(); return true; }
    if (screen === 'Scan') { goHome(); return true; }
    if (screen === 'WebSearch') { setScreen('Result'); return true; }
    if (screen === 'OCR' || screen === 'Identify' || screen === 'Catalog' || screen === 'Collection' || screen === 'Settings' || screen === 'Releases' || screen === 'Discoveries' || screen === 'History') { goHome(); return true; }
    goHome(); return true;
  };

  useEffect(() => { const subscription = BackHandler.addEventListener('hardwareBackPress', handleAndroidBack); return () => subscription.remove(); });

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
    setSelectedOcrCodes([]);
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
  const openSearchInApp = (url, title = 'WEB SEARCH') => { setWebSearchUrl(url); setWebSearchTitle(title); setScreen('WebSearch'); };
  const runOnlineDiscovery = async (rawCode, force = false) => {
    const sought = String(rawCode || '').trim();
    const key = normalize(sought);
    if (!key || (!force && onlineSearchKeyRef.current === key)) return;
    onlineSearchKeyRef.current = key;
    setOnlineSearchBusy(true); setOnlineSearchMessage('Searching accessible public pages…'); setOnlineCandidates([]); setOnlineCandidateIndex(0);
    const sources = [
      { name: 'Google', url: searchWeb(sought) },
      { name: 'Bing', url: searchBing(sought) },
      { name: 'DuckDuckGo', url: searchDuckDuckGo(sought) },
      { name: 'eBay', url: searchEbay(sought) },
      { name: 'Monster High Wiki', url: searchWiki(sought) },
      { name: 'Mattel Product Support', url: searchMattelSupport(sought) },
      { name: 'Mattel web search', url: searchMattel(sought) },
    ];
    try {
      const live = await Promise.all(sources.map(async source => {
        try {
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const timer = controller ? setTimeout(() => controller.abort(), 9000) : null;
          const response = await fetch(source.url, { headers: { Accept: 'text/html,application/xhtml+xml' }, signal: controller?.signal });
          if (timer) clearTimeout(timer);
          if (!response.ok) return [];
          const html = await response.text();
          return extractWebCandidates(html, source.name, source.url, sought);
        } catch (_) { return []; }
      }));
      const scraped = rankWebCandidates(live.flat());
      // Include the shared discovery queue when a scanned code matches a candidate's
      // Mattel model code, but never treat a guessed UPC/model relationship as verified.
      const queued = discoveryItems.filter(item => [item.mattelCodeCandidate, ...(item.allCodesSeenInRow || [])].some(v => normalize(v) === key)).map(item => ({ name: item.name, sourceName: 'Monster High Wiki discovery queue', sourceUrl: item.wikiUrl || 'https://monsterhigh.fandom.com/wiki/Product_number', searchPageUrl: item.wikiUrl || 'https://monsterhigh.fandom.com/wiki/Product_number', mattelCode: item.mattelCodeCandidate || '', sources: ['Monster High Wiki discovery queue'], sourceUrls: [item.wikiUrl || 'https://monsterhigh.fandom.com/wiki/Product_number'], score: 10, exactCodeSources: 1 }));
      const merged = rankWebCandidates([...scraped, ...queued]);
      setOnlineCandidates(merged); setOnlineCandidateIndex(0);
      setOnlineSearchMessage(merged.length ? `Found ${merged.length} possible match${merged.length === 1 ? '' : 'es'}. Results are unverified until you confirm one.` : 'No readable candidate results were returned. Some sites block automatic reading; use the source-search buttons below.');
    } catch (_) { setOnlineCandidates([]); setOnlineSearchMessage('Online discovery could not read results from the available sources.'); }
    finally { setOnlineSearchBusy(false); }
  };
  const confirmOnlineCandidate = candidate => {
    if (!candidate) return;
    const raw = String(code || '').trim();
    const id = 'confirmed-' + normalize(raw) + '-' + normalize(candidate.mattelCode || candidate.name).slice(0, 42);
    const newItem = {
      id, name: candidate.name, character: '', series: 'Online discovery · user confirmed',
      mattelCode: candidate.mattelCode || '',
      codes: [ { type: /^\d+$/.test(normalize(raw)) ? 'upc' : 'mattel', value: raw }, ...(candidate.mattelCode && normalize(candidate.mattelCode) !== normalize(raw) ? [{ type: 'mattel', value: candidate.mattelCode }] : []) ],
      officialUrl: candidate.sourceUrls?.find(url => /(^|\.)mattel\.com|creations\.mattel\.com|shop\.mattel\.com/i.test(url)) || null,
      referenceUrl: candidate.sourceUrls?.[0] || candidate.searchPageUrl || null,
      sourceUrls: candidate.sourceUrls || [], sourceNames: candidate.sources || [candidate.sourceName || 'Online search'],
      identifierConfidence: 'user-confirmed-online-candidate', itemType: 'user-confirmed-candidate', verificationStatus: 'user-confirmed-not-independently-verified'
    };
    setCustomItems(prev => [newItem, ...prev.filter(item => item.id !== id && !((item.codes || []).some(c => normalize(c.value) === normalize(raw)) && item.name === candidate.name))]);
    setSelectedProduct(newItem); setPreviousProductScreen('Result'); setScreen('Product');
    Alert.alert('Candidate saved', 'You confirmed this candidate. Ghoul ID saved your choice, but the online sources have not been independently verified.');
  };
  const rejectOnlineCandidate = () => {
    if (onlineCandidateIndex + 1 < onlineCandidates.length) setOnlineCandidateIndex(index => index + 1);
    else { setOnlineCandidateIndex(onlineCandidates.length); setOnlineSearchMessage('You rejected every suggested candidate. No match was saved. Try another printed model number or open a source search below.'); }
  };
  useEffect(() => {
    if (screen === 'Result' && code && !product) runOnlineDiscovery(code);
  }, [screen, code, product]);

  const toggle = (setter, list, p) => { const id = productId(p); setter(list.includes(id) ? list.filter(x => x !== id) : [...list, id]); };
  const updateStatus = (p, status) => {
    const id = productId(p);
    if (status === 'owned') { setOwned(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]); setWanted(prev => prev.filter(x => x !== id)); }
    else { setWanted(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]); setOwned(prev => prev.filter(x => x !== id)); }
  };

  const filteredCatalog = useMemo(() => allProducts.filter(p => {
    const text = [p.name, p.character, p.series, p.mattelCode, ...(p.codes || []).map(c => c.value)].join(' ').toLowerCase();
    const q = query.trim().toLowerCase();
    const queryOk = !q || text.includes(q);
    const seriesOk = seriesFilter === 'All' || p.series === seriesFilter;
    const statusOk = collectionFilter === 'All' || (collectionFilter === 'Owned' && owned.includes(productId(p))) || (collectionFilter === 'Wanted' && wanted.includes(productId(p))) || (collectionFilter === 'Favorites' && favorites.includes(productId(p)));
    return queryOk && seriesOk && statusOk;
  }).sort((a,b) => {
    const dateA = String(a.releaseDate || releaseInfoForProduct(a)?.releaseDate || a.releaseYear || releaseInfoForProduct(a)?.releaseYear || '').trim();
    const dateB = String(b.releaseDate || releaseInfoForProduct(b)?.releaseDate || b.releaseYear || releaseInfoForProduct(b)?.releaseYear || '').trim();
    if (catalogSort === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
    if (catalogSort === 'newest' || catalogSort === 'oldest') {
      const yearA = Number((dateA.match(/\d{4}/) || [])[0] || 0); const yearB = Number((dateB.match(/\d{4}/) || [])[0] || 0);
      if (!yearA && yearB) return 1; if (yearA && !yearB) return -1;
      if (yearA !== yearB) return catalogSort === 'newest' ? yearB-yearA : yearA-yearB;
      return String(a.name || '').localeCompare(String(b.name || ''));
    }
    if (catalogSort === 'series') return String(a.series || 'zzz').localeCompare(String(b.series || 'zzz')) || String(a.name || '').localeCompare(String(b.name || ''));
    if (catalogSort === 'year') return String((dateA.match(/\d{4}/) || ['9999'])[0]).localeCompare(String((dateB.match(/\d{4}/) || ['9999'])[0])) || String(a.name || '').localeCompare(String(b.name || ''));
    return String(a.name || '').localeCompare(String(b.name || ''));
  }), [allProducts, query, seriesFilter, collectionFilter, owned, wanted, favorites, catalogSort, releaseItems]);

  const Header = ({ subtitle }) => <View style={styles.header}><View style={styles.logoMark}><Text style={styles.logoSkull}>☠</Text><Text style={styles.logoBow}>♥</Text></View><Text style={styles.brand}>GHOUL<Text style={{color:PINK}}> ID</Text></Text><Text style={styles.tagline}>{subtitle || 'SCAN THE BOX. MEET YOUR GHOUL.'}</Text></View>;
  const Btn = ({ label, onPress, kind = 'pink', small = false }) => <Pressable onPress={onPress} style={[styles.button, kind === 'teal' && styles.buttonTeal, kind === 'purple' && styles.buttonPurple, kind === 'outline' && styles.buttonOutline, small && styles.buttonSmall]}><Text style={[styles.buttonText, kind === 'teal' && {color:'#07151a'}, kind === 'outline' && {color:'#f7d9f3'}]}>{label}</Text></Pressable>;
  const SectionTitle = ({ children }) => <Text style={styles.sectionTitle}>{children}</Text>;
  const ProductRow = ({ item, onPress }) => { const imageUri = photos[productId(item)] || catalogImageFor(item); return <Pressable onPress={onPress} style={styles.productRow}><View style={styles.productThumb}>{imageUri ? <Image source={{uri:imageUri}} style={styles.thumbImage} resizeMode="cover" onError={() => { if (!photos[productId(item)]) markCatalogImageFailed(imageUri); }} /> : <Text style={styles.thumbSkull}>☠</Text>}</View><View style={{flex:1}}><Text style={styles.productTitle}>{item.name}</Text><Text style={styles.muted}>{[item.character, item.series, item.mattelCode].filter(Boolean).join(' • ')}</Text><Text style={styles.muted}>{isOwned(item) ? '✓ OWNED' : isWanted(item) ? '♡ WANTED' : isFavorite(item) ? '♥ FAVORITE' : 'CATALOG ENTRY'}</Text></View><Text style={styles.chevron}>›</Text></Pressable>; };

  if (!permission && screen === 'Scan') return <SafeAreaView style={styles.container}><Text style={styles.body}>Preparing camera…</Text></SafeAreaView>;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {screen === 'Scan' && scanning ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.scanScreen, { paddingBottom: Math.max(insets.bottom, 24) + 18 }]} keyboardShouldPersistTaps="handled">
            <View style={styles.scanTop}><Pressable onPress={goHome}><Text style={styles.navText}>‹ BACK</Text></Pressable><Text style={styles.screenTitle}>BATCH SCANNER</Text><View style={{width:50}} /></View>
            <View style={styles.cameraFrame} onLayout={e => setCameraLayout(e.nativeEvent.layout)}>
              {permission?.granted ? <CameraView ref={cameraRef} style={styles.camera} facing="back" enableTorch={torch} barcodeScannerSettings={{ barcodeTypes: ['upc_a', 'upc_e', 'ean13', 'ean8', 'itf14', 'code128', 'code39'] }} onBarcodeScanned={handleBarcodeDetected} onMountError={event => setScannerStatus('Camera preview error: ' + String(event?.message || 'unknown camera error'))} /> : <View style={styles.permissionBox}><Text style={styles.body}>Camera access is needed to scan barcodes.</Text><Btn label="ALLOW CAMERA" onPress={requestPermission} /></View>}
              {barcodeCandidates.filter(item => item.lastSeen && Date.now() - item.lastSeen < 1800).map((item, index) => {
                const origin = item.bounds?.origin || item.bounds?.boundingBox?.origin || (Number.isFinite(Number(item.bounds?.x)) ? { x: item.bounds.x, y: item.bounds.y } : null);
                const size = item.bounds?.size || item.bounds?.boundingBox?.size || (Number.isFinite(Number(item.bounds?.width)) ? { width: item.bounds.width, height: item.bounds.height } : null);
                if (!cameraLayout.width || !cameraLayout.height) return null;
                const hasBounds = !!(origin && size); const rawX = hasBounds ? Number(origin.x) : NaN; const rawY = hasBounds ? Number(origin.y) : NaN; const rawW = hasBounds ? Number(size.width) : NaN; const rawH = hasBounds ? Number(size.height) : NaN;
                const fits = hasBounds && rawX >= 0 && rawY >= 0 && rawX < cameraLayout.width && rawY < cameraLayout.height && rawW > 0 && rawH > 0 && rawW <= cameraLayout.width && rawH <= cameraLayout.height;
                const width = fits ? Math.max(42, Math.min(cameraLayout.width, rawW)) : Math.min(150, Math.max(105, cameraLayout.width * 0.4)); const height = fits ? Math.max(28, Math.min(cameraLayout.height, rawH)) : 38;
                const left = fits ? Math.max(0, Math.min(cameraLayout.width-width, rawX)) : Math.max(0, (cameraLayout.width-width)/2); const top = fits ? Math.max(0, Math.min(cameraLayout.height-height, rawY)) : Math.max(8, Math.min(cameraLayout.height-height, 24 + (index%4)*(height+7)));
                return <Pressable key={item.normalized} onPress={() => item.stable && setSelectedBarcode(item.normalized)} style={[styles.barcodeOverlay,{left,top,width,height,borderColor:selectedBarcode===item.normalized?TEAL:'#facc15',backgroundColor:selectedBarcode===item.normalized?'rgba(32,217,232,0.25)':'rgba(250,204,21,0.10)'}]}><Text numberOfLines={1} style={styles.barcodeOverlayText}>{barcodeCandidates.findIndex(x=>x.normalized===item.normalized)+1}</Text></Pressable>;
              })}
              <View pointerEvents="none" style={styles.scanCorners}><View style={[styles.corner,styles.c1]}/><View style={[styles.corner,styles.c2]}/><View style={[styles.corner,styles.c3]}/><View style={[styles.corner,styles.c4]}/></View>
            </View>
            <Text style={styles.centerMuted}>Scan box after box. Codes stay in this session after leaving camera view. No photos are taken automatically.</Text>
            <Text style={styles.muted}>Status: {scannerStatus} · Camera events: {scannerEventCount}</Text>
            <View style={styles.scanControls}><Btn label={torch ? 'FLASH ON' : 'FLASH OFF'} kind="purple" onPress={() => setTorch(!torch)} small /><Btn label="CLEAR / FINISH BATCH" kind="outline" onPress={finishBatchSession} small /></View>
            <View style={styles.infoCard}>
              <Text style={styles.resultName}>SESSION QUEUE · {barcodeCandidates.length} UNIQUE CODE{barcodeCandidates.length===1?'':'S'}</Text>
              <Text style={styles.muted}>{batchDuplicateCount} repeat detection{batchDuplicateCount===1?'':'s'} ignored. Repeated sightings do not create extra rows.</Text>
              {barcodeCandidates.length ? barcodeCandidates.map((item,index) => {
                const isSelected = selectedBarcode === item.normalized; const match = findCatalogMatch(item.value);
                const status = match ? 'MATCH FOUND' : item.stable ? 'NEEDS LOOKUP' : 'STABILIZING';
                return <View key={item.normalized} style={[styles.ocrCandidate, isSelected && {borderColor:TEAL,backgroundColor:'#123038'}]}>
                  <Pressable onPress={() => item.stable && setSelectedBarcode(item.normalized)}>
                    <Text style={[styles.ocrCandidateLabel,{color:isSelected?TEAL:PINK}]}>{isSelected?'✓ SELECTED':'CODE '+(index+1)+' · TAP TO SELECT'}  ·  {status}</Text>
                    <Text style={styles.productTitle}>{item.value}</Text>
                    <Text style={styles.muted}>{match ? match.name : 'Not matched in local catalog yet'}</Text>
                    {item.checksumValid === false ? <Text style={styles.muted}>Checksum warning — lookup is still allowed.</Text> : null}
                  </Pressable>
                  <View style={styles.scanControls}><Btn label="VIEW DETAILS" onPress={() => item.stable && lookupBatchItem(item)} small /><Btn label="REMOVE" kind="outline" onPress={() => removeBatchItem(item)} small /></View>
                </View>;
              }) : <Text style={styles.body}>No codes captured yet. Hold a barcode steady for {scanDelayMs} ms, then move to the next box.</Text>}
              <Btn label="LOOK UP SELECTED CODE" onPress={lookupSelectedBarcode} />
              <Btn label="CHECK ALL AGAINST CATALOG" kind="teal" onPress={checkAllBatchCodes} />
              <Btn label="RESUME / KEEP SCANNING" kind="purple" onPress={() => { setScanning(true); setScreen('Scan'); }} />
            </View>
            <Pressable onPress={() => setAlternativeLookupExpanded(v=>!v)} style={[styles.infoCard,{borderColor:'#684c76'}]}>
              <Text style={styles.productTitle}>{alternativeLookupExpanded?'⌃':'⌄'} OTHER LOOKUP OPTIONS</Text>
              <Text style={styles.muted}>Manual code entry and photo/OCR fallback</Text>
            </Pressable>
            {alternativeLookupExpanded ? <View style={styles.manualBox}><SectionTitle>MANUAL LOOKUP</SectionTitle><TextInput value={manualCode} onChangeText={setManualCode} placeholder="Enter UPC or printed product code" placeholderTextColor="#988ba3" autoCapitalize="characters" style={styles.input} returnKeyType="search" onSubmitEditing={() => acceptCode(manualCode)} /><Btn label="LOOK UP CODE" onPress={() => { batchLookupRef.current=false; acceptCode(manualCode); }} /><Btn label="PHOTO FALLBACK: READ PRINTED TEXT" kind="purple" onPress={askForOCRPhoto} /></View> : null}
          </ScrollView>
        ) : (
          <>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              {screen === 'Home' && <>
                <Header subtitle="SCAN THE BOX. MEET YOUR GHOUL." />
                <View style={styles.hero}><Text style={styles.heroEyebrow}>YOUR PERSONAL MONSTER HIGH COMPANION</Text><Text style={styles.heroTitle}>KNOW YOUR{ '\n'}<Text style={{color:PINK}}>GHOULS.</Text></Text><Text style={styles.body}>Scan box barcodes, identify dolls, and keep your collection in one spooky little place.</Text><Btn label="▦   SCAN BARCODE" kind="teal" onPress={startScan} /><Btn label="▤   READ PRINTED TEXT (OCR)" kind="purple" onPress={askForOCRPhoto} /><Btn label="⌕   IDENTIFY A CODE" onPress={() => {setCode('');setManualCode('');setScreen('Identify');}} /><Btn label="♡   MY COLLECTION" kind="purple" onPress={() => {setCollectionFilter('All');setScreen('Collection');}} /><Btn label="♧   UPCOMING RELEASES & ALERTS" kind="outline" onPress={() => setScreen('Releases')} /><Btn label={`✧   NEW WIKI DISCOVERIES (${discoveryItems.length})`} kind="outline" onPress={() => setScreen('Discoveries')} /><Text style={styles.muted}>{catalogSyncAt ? 'Catalog last refreshed: ' + new Date(catalogSyncAt).toLocaleString() : 'Catalog refreshes from the public repository when available.'}</Text></View>
                <View style={styles.statsRow}><View style={styles.stat}><Text style={styles.statNum}>{allProducts.length}</Text><Text style={styles.statLabel}>CATALOGED</Text></View><View style={styles.stat}><Text style={styles.statNum}>{owned.length}</Text><Text style={styles.statLabel}>OWNED</Text></View><View style={styles.stat}><Text style={styles.statNum}>{wanted.length}</Text><Text style={styles.statLabel}>WANTED</Text></View></View>
                <SectionTitle>QUICK ACCESS</SectionTitle><View style={styles.quickGrid}><Pressable style={styles.quickTile} onPress={() => setScreen('Catalog')}><Text style={styles.quickIcon}>▤</Text><Text style={styles.quickLabel}>CATALOG</Text></Pressable><Pressable style={styles.quickTile} onPress={() => {setCollectionFilter('Favorites');setScreen('Collection');}}><Text style={styles.quickIcon}>♥</Text><Text style={styles.quickLabel}>FAVORITES</Text></Pressable><Pressable style={styles.quickTile} onPress={() => setScreen('History')}><Text style={styles.quickIcon}>◷</Text><Text style={styles.quickLabel}>SCAN HISTORY</Text></Pressable><Pressable style={styles.quickTile} onPress={() => setScreen('Settings')}><Text style={styles.quickIcon}>⚙</Text><Text style={styles.quickLabel}>SETTINGS</Text></Pressable></View>
                <View style={styles.noteCard}><Text style={styles.noteTitle}>A NOTE FROM THE CRYPT</Text><Text style={styles.body}>Unknown codes stay unknown until we can verify them. Use online search to help identify new finds, then expand the catalog with confirmed information.</Text></View>
              </>}
              {screen === 'Identify' && <><TopBar title="IDENTIFY A CODE" onBack={goHome} /><Text style={styles.body}>Enter the UPC barcode, Mattel product number, or another clearly printed product code. Manufacturing and lot codes may not identify the doll.</Text><TextInput value={manualCode} onChangeText={setManualCode} placeholder="e.g. JMG88 or UPC" placeholderTextColor="#988ba3" autoCapitalize="characters" style={styles.input} onSubmitEditing={() => acceptCode(manualCode)} returnKeyType="search" /><Btn label="IDENTIFY CODE" onPress={() => acceptCode(manualCode)} /><Btn label="OPEN BARCODE SCANNER" kind="teal" onPress={startScan} /></>}
              {screen === 'Result' && <><TopBar title="SCAN RESULTS" onBack={() => { if (batchLookupRef.current) { batchLookupRef.current = false; setScanning(true); setScreen('Scan'); } else goHome(); }} /><View style={styles.resultHero}>{(photos[product ? productId(product) : 'code:'+normalize(code)] || (product && catalogImageFor(product))) ? <Image source={{uri: photos[product ? productId(product) : 'code:'+normalize(code)] || catalogImageFor(product)}} style={styles.resultPhoto} resizeMode="contain" onError={() => { if (!photos[product ? productId(product) : 'code:'+normalize(code)]) markCatalogImageFailed(catalogImageFor(product)); }} /> : null}<Text style={styles.resultLabel}>{product ? (product.identifierConfidence === 'user-confirmed-online-candidate' ? '✦ USER-CONFIRMED ONLINE MATCH' : '✦ LOCAL CATALOG MATCH') : '✧ NOT FOUND IN LOCAL CATALOG'}</Text><Text style={styles.scannedCode}>{code}</Text>{product ? <><Text style={styles.resultName}>{product.name}</Text><Text style={styles.body}>{[product.character, product.series, product.mattelCode].filter(Boolean).join(' • ')}</Text>{(releaseInfoForProduct(product)?.releaseDate || product.releaseDate) ? <Text style={styles.muted}>Release date: {formatReleaseDate(releaseInfoForProduct(product)?.releaseDate || product.releaseDate)}{releaseInfoForProduct(product)?.status ? ' · ' + releaseInfoForProduct(product).status : ''}</Text> : null}{!!product.releaseYear && <Text style={styles.muted}>Release year: {product.releaseYear}</Text>}</> : <><View style={styles.unverifiedBanner}><Text style={styles.unverifiedFlag}>⚠ UNVERIFIED — OUTSIDE CATALOG</Text><Text style={styles.unverifiedText}>Any product you identify through external search is a candidate, not a confirmed Ghoul ID match. Check the model number and product photos before treating it as correct.</Text></View><Text style={styles.resultName}>Finding the most likely match…</Text><Text style={styles.body}>Ghoul ID checks accessible public search pages and compares candidate names across sources. Exact UPC/model-code matches and agreement between independent sources rank higher. Websites may block automatic reading, so results are not guaranteed.</Text>{onlineSearchBusy ? <View style={styles.infoCard}><ActivityIndicator size="large" color={TEAL} /><Text style={styles.body}>{onlineSearchMessage || 'Searching public sources…'}</Text></View> : null}{!onlineSearchBusy && onlineCandidates[onlineCandidateIndex] ? <View style={styles.infoCard}><Text style={styles.ocrCandidateLabel}>MOST LIKELY CANDIDATE · {onlineCandidateIndex + 1} OF {onlineCandidates.length}</Text><Text style={styles.resultName}>{onlineCandidates[onlineCandidateIndex].name}</Text><Text style={styles.muted}>Found across: {(onlineCandidates[onlineCandidateIndex].sources || [onlineCandidates[onlineCandidateIndex].sourceName]).join(', ')}</Text><Text style={styles.muted}>Candidate ranking score: {onlineCandidates[onlineCandidateIndex].score} · Not independently verified</Text>{onlineCandidates[onlineCandidateIndex].mattelCode ? <Text style={styles.muted}>Possible Mattel model number: {onlineCandidates[onlineCandidateIndex].mattelCode}</Text> : null}<Btn label="YES — THIS IS THE CORRECT ITEM" kind="teal" onPress={() => confirmOnlineCandidate(onlineCandidates[onlineCandidateIndex])} /><Btn label="NO — SHOW NEXT MOST LIKELY" kind="outline" onPress={rejectOnlineCandidate} /><Btn label="OPEN THIS CANDIDATE SOURCE ↗" kind="outline" onPress={() => openUrl(onlineCandidates[onlineCandidateIndex].sourceUrls?.[0] || onlineCandidates[onlineCandidateIndex].searchPageUrl)} /></View> : null}<Text style={styles.body}>{onlineSearchMessage}</Text><Btn label={onlineSearchBusy ? 'SEARCHING ONLINE…' : 'SEARCH ONLINE AGAIN'} kind="purple" onPress={() => runOnlineDiscovery(code, true)} /><Btn label="SEARCH GOOGLE RESULTS IN GHOUL ID" onPress={() => openSearchInApp(searchWeb(code), 'GOOGLE SEARCH · UNVERIFIED')} /><Btn label="SEARCH BING RESULTS IN GHOUL ID" kind="outline" onPress={() => openSearchInApp(searchBing(code), 'BING SEARCH · UNVERIFIED')} /><Btn label="SEARCH DUCKDUCKGO RESULTS IN GHOUL ID" kind="outline" onPress={() => openSearchInApp(searchDuckDuckGo(code), 'DUCKDUCKGO SEARCH · UNVERIFIED')} /><Btn label="SEARCH EBAY LISTINGS IN GHOUL ID" kind="teal" onPress={() => openSearchInApp(searchEbay(code), 'EBAY SEARCH · UNVERIFIED')} /><Btn label="SEARCH MONSTER HIGH WIKI IN GHOUL ID" kind="outline" onPress={() => openSearchInApp(searchWiki(code), 'WIKI SEARCH · UNVERIFIED')} /><Btn label="SEARCH OFFICIAL MATTEL SITES IN GHOUL ID" kind="outline" onPress={() => openSearchInApp(searchMattel(code), 'MATTEL WEB SEARCH · UNVERIFIED')} /><Btn label="SEARCH MATTEL PRODUCT SUPPORT IN GHOUL ID" kind="outline" onPress={() => openSearchInApp(searchMattelSupport(code), 'MATTEL SUPPORT · UNVERIFIED')} /></>}</View>
                {product && <><View style={styles.actionGrid}><Btn label={isOwned(product) ? '✓ OWNED — TAP TO REMOVE' : '+ MARK AS OWNED'} kind="teal" onPress={() => updateStatus(product,'owned')} /><Btn label={isWanted(product) ? '♡ WISHLIST — TAP TO REMOVE' : '+ ADD TO WISHLIST'} kind="purple" onPress={() => updateStatus(product,'wanted')} /><Btn label={isFavorite(product) ? '♥ FAVORITED' : '♡ FAVORITE'} kind="outline" onPress={() => toggle(setFavorites,favorites,product)} /></View><Btn label="ADD / CHANGE PRODUCT PHOTO" kind="outline" onPress={() => askForProductPhoto(productId(product))} /><Btn label="VIEW EBAY SOLD LISTINGS ↗" kind="teal" onPress={() => openUrl(ebaySoldSearch(product, code))} />{officialUrlForProduct(product) ? <Btn label={officialUrlLabelForProduct(product)} onPress={() => openUrl(officialUrlForProduct(product))} /> : <Btn label="SEARCH OFFICIAL MATTEL PAGES ↗" onPress={() => openUrl(searchMattel(product.mattelCode || code))} />}<Btn label="MONSTER HIGH WIKI ↗" kind="outline" onPress={() => openUrl(product.referenceUrl || searchWiki(product.mattelCode || code || product.name))} /></>}
                {!product && <><View style={styles.actionGrid}><Btn label="+ ADD UNIDENTIFIED ITEM TO OWNED" kind="teal" onPress={() => saveUnknownToCollection('owned')} /><Btn label="♡ ADD UNIDENTIFIED ITEM TO WISHLIST" kind="purple" onPress={() => saveUnknownToCollection('wanted')} /></View><Btn label="SAVE PHOTO FOR THIS CODE" kind="outline" onPress={() => askForProductPhoto('code:'+normalize(code))} /></>}
                <Btn label="▤  READ PRINTED TEXT (OCR)" kind="purple" onPress={askForOCRPhoto} /><Btn label="↻  SCAN NEXT ITEM" kind="teal" onPress={scanNext} /><Btn label="BACK TO HOME" kind="outline" onPress={goHome} /></>}
              {screen === 'OCR' && <><TopBar title="PRINTED TEXT OCR" onBack={() => setScreen('Home')} /><Text style={styles.body}>Review the text detected in your photo. Tap a likely product code or UPC to look it up. Text recognition can misread characters, so check the code before relying on a match.</Text>{ocrImageUri ? <Image source={{uri:ocrImageUri}} style={styles.ocrPhoto} resizeMode="contain" /> : null}{ocrBusy ? <View style={styles.loadingBox}><ActivityIndicator size="large" color={PINK} /><Text style={styles.body}>Reading printed text…</Text></View> : <>{ocrLines.length ? <>{ocrSuggestions.length ? <><SectionTitle>BEST IDENTIFIER CANDIDATES</SectionTitle><Text style={styles.muted}>Catalog matches and valid barcode numbers appear first. Secondary carton/lot codes are deliberately deprioritized or ignored because they may identify packaging batches rather than the doll.</Text>{ocrSuggestions.map((item,i) => <Pressable key={'code'+item.normalized} style={[styles.ocrCandidate, selectedOcrCodes.includes(item.value) && {borderColor:TEAL,backgroundColor:'#123038'}]} onPress={() => setSelectedOcrCodes([item.value])}><Text style={styles.ocrCandidateLabel}>{selectedOcrCodes.includes(item.value) ? '✓ SELECTED' : item.kind + ' · TAP TO SELECT'}</Text><Text style={styles.productTitle}>{item.value}</Text>{item.match ? <Text style={styles.muted}>{item.match.name}</Text> : item.kind === 'VALID BARCODE FORMAT' ? <Text style={styles.muted}>Barcode format looks valid; catalog match not confirmed yet.</Text> : null}</Pressable>)}<Btn label={selectedOcrCodes.length ? 'LOOK UP SELECTED CODE' : 'SELECT A CODE ABOVE'} onPress={lookupSelectedOcrCodes} /></> : <View style={styles.infoCard}><Text style={styles.productTitle}>No likely product identifiers found</Text><Text style={styles.body}>We found text, but none looked like a catalog code or valid UPC/EAN/GTIN. You can still review the text below or enter a code manually.</Text></View>}<SectionTitle>ALL RECOGNIZED TEXT</SectionTitle>{ocrLines.map((line,i) => <View key={'line'+i} style={styles.ocrLine}><Text style={styles.body}>{line}</Text></View>)}</> : <View style={styles.infoCard}><Text style={styles.productTitle}>No text ready yet</Text><Text style={styles.body}>Try a clear, well-lit photo with the product number facing the camera.</Text></View>}<Btn label="TRY ANOTHER PHOTO" kind="purple" onPress={askForOCRPhoto} /><Btn label="ENTER CODE MANUALLY" onPress={() => setScreen('Identify')} /></>}</>}
              {(screen === 'Catalog' || screen === 'Collection') && <><TopBar title={screen === 'Catalog' ? 'DOLL CATALOG' : 'MY COLLECTION'} onBack={goHome} />{screen === 'Catalog' && <><Btn label={catalogSyncing ? 'REFRESHING CATALOG…' : '↻ REFRESH ONLINE CATALOG'} kind="teal" onPress={() => refreshRemoteCatalog(true)} /><Text style={styles.muted}>{catalogSyncAt ? 'Last online sync: ' + new Date(catalogSyncAt).toLocaleString() : 'Showing bundled catalog until an online copy is available.'}</Text></>}<TextInput value={query} onChangeText={setQuery} placeholder="Search names, characters, series, codes…" placeholderTextColor="#988ba3" style={styles.input} autoCapitalize="none" /><Text style={styles.muted}>SORT CATALOG</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} style={{maxHeight:48,marginBottom:8}} contentContainerStyle={{gap:8,alignItems:"center"}}>{[["name","Name A–Z"],["newest","Newest"],["oldest","Oldest"],["year","Year"],["series","Series"]].map(([value,label])=><Pressable key={value} onPress={()=>setCatalogSort(value)} style={[styles.chip,catalogSort===value&&styles.chipActive]}><Text style={styles.chipText}>{label}</Text></Pressable>)}</ScrollView><ScrollView horizontal showsHorizontalScrollIndicator={false} style={{maxHeight:48,marginBottom:12}} contentContainerStyle={{gap:8,alignItems:'center'}}>{['All', ...Array.from(new Set(allProducts.map(p => p.series).filter(Boolean)))].map(s => <Pressable key={s} onPress={() => setSeriesFilter(s)} style={[styles.chip,seriesFilter===s && styles.chipActive]}><Text style={styles.chipText}>{s}</Text></Pressable>)}</ScrollView>{screen === 'Collection' && <View style={styles.filterRow}>{['All','Owned','Wanted','Favorites'].map(s => <Pressable key={s} onPress={() => setCollectionFilter(s)} style={[styles.chip,collectionFilter===s && styles.chipActive]}><Text style={styles.chipText}>{s}</Text></Pressable>)}</View>}{(screen === 'Collection' ? filteredCatalog.filter(p => collectionFilter === 'All' ? (isOwned(p) || isWanted(p) || isFavorite(p)) : (collectionFilter === 'Owned' && isOwned(p)) || (collectionFilter === 'Wanted' && isWanted(p)) || (collectionFilter === 'Favorites' && isFavorite(p))) : filteredCatalog).length ? (screen === 'Collection' ? filteredCatalog.filter(p => collectionFilter === 'All' ? (isOwned(p) || isWanted(p) || isFavorite(p)) : (collectionFilter === 'Owned' && isOwned(p)) || (collectionFilter === 'Wanted' && isWanted(p)) || (collectionFilter === 'Favorites' && isFavorite(p))) : filteredCatalog).map(p => <ProductRow key={productId(p)} item={p} onPress={() => {setSelectedProduct(p);setPreviousProductScreen(screen);setCode('');setScreen('Product');}} />) : <View style={styles.infoCard}><Text style={styles.productTitle}>{screen === 'Collection' ? 'Your collection is waiting' : 'No dolls found'}</Text><Text style={styles.body}>{screen==='Collection' ? 'Nothing matches this collection filter yet. Mark dolls as owned, wanted, or favorite after identifying them. Your saved dolls will appear here.' : 'Try another search. More verified catalog entries will be added over time.'}</Text></View>}</>}
              {screen === 'Product' && selectedProduct && <><TopBar title="DOLL DETAILS" onBack={() => setScreen(previousProductScreen)} /><View style={styles.resultHero}>{(photos[productId(selectedProduct)] || catalogImageFor(selectedProduct)) ? <Image source={{uri:photos[productId(selectedProduct)] || catalogImageFor(selectedProduct)}} style={styles.productPhoto} resizeMode="contain" onError={() => { if (!photos[productId(selectedProduct)]) markCatalogImageFailed(catalogImageFor(selectedProduct)); }} /> : <View style={styles.bigSkull}><Text style={styles.bigSkullText}>☠</Text><Text style={styles.bigBow}>♥</Text></View>}<Text style={styles.resultName}>{selectedProduct.name}</Text><Text style={styles.body}>{[selectedProduct.character,selectedProduct.series,selectedProduct.mattelCode].filter(Boolean).join(' • ')}</Text>{(releaseInfoForProduct(selectedProduct)?.releaseDate || selectedProduct.releaseDate) ? <Text style={styles.muted}>Release date: {formatReleaseDate(releaseInfoForProduct(selectedProduct)?.releaseDate || selectedProduct.releaseDate)}{releaseInfoForProduct(selectedProduct)?.status ? ' · ' + releaseInfoForProduct(selectedProduct).status : ''}</Text> : <Text style={styles.muted}>Release date: Not available from current sources</Text>}{!!selectedProduct.releaseYear && <Text style={styles.muted}>Release year: {selectedProduct.releaseYear}</Text>}{(selectedProduct.codes||[]).map(c => <Text key={c.type+c.value} style={styles.muted}>{c.type.toUpperCase()}: {c.value}</Text>)}</View><View style={styles.actionGrid}><Btn label={isOwned(selectedProduct)?'✓ OWNED — TAP TO REMOVE':'+ OWNED'} kind="teal" onPress={() => updateStatus(selectedProduct,'owned')} /><Btn label={isWanted(selectedProduct)?'♡ WANTED — TAP TO REMOVE':' + WISHLIST'} kind="purple" onPress={() => updateStatus(selectedProduct,'wanted')} /><Btn label={isFavorite(selectedProduct)?'♥ FAVORITE':'♡ FAVORITE'} kind="outline" onPress={() => toggle(setFavorites,favorites,selectedProduct)} /></View><Btn label="ADD / CHANGE PRODUCT PHOTO" kind="outline" onPress={() => askForProductPhoto(productId(selectedProduct))} /><TextInput value={notes[productId(selectedProduct)] || ''} onChangeText={v => setNotes(prev => ({...prev,[productId(selectedProduct)]:v}))} placeholder="Private notes about this doll…" placeholderTextColor="#988ba3" style={[styles.input,{minHeight:76,textAlignVertical:'top'}]} multiline /><Btn label="VIEW EBAY SOLD LISTINGS ↗" kind="teal" onPress={() => openUrl(ebaySoldSearch(selectedProduct, selectedProduct.mattelCode))} />{officialUrlForProduct(selectedProduct) ? <Btn label={officialUrlLabelForProduct(selectedProduct)} onPress={() => openUrl(officialUrlForProduct(selectedProduct))} /> : null}<Btn label="SEARCH OFFICIAL MATTEL SITES ↗" onPress={() => openUrl(searchMattel(selectedProduct.mattelCode || selectedProduct.name))} /><Btn label="SEARCH MATTEL PRODUCT SUPPORT ↗" kind="outline" onPress={() => openUrl(searchMattelSupport(selectedProduct.mattelCode || selectedProduct.name))} />{selectedProduct.referenceUrl && !selectedProduct.referenceUrl.includes("Special:Search") ? <Btn label="MONSTER HIGH WIKI ARTICLE ↗" kind="outline" onPress={() => openUrl(selectedProduct.referenceUrl)} /> : null}{releaseInfoForProduct(selectedProduct)?.wikiUrl ? <Btn label="RELEASE DETAILS ON WIKI ↗" kind="outline" onPress={() => openUrl(releaseInfoForProduct(selectedProduct).wikiUrl)} /> : null}<Btn label="SEARCH MONSTER HIGH WIKI ↗" kind="outline" onPress={() => openUrl(searchWiki((selectedProduct.mattelCode ? selectedProduct.mattelCode + ' ' : '') + selectedProduct.name))} />{releaseInfoForProduct(selectedProduct)?.sourceUrl ? <Btn label="VIEW RELEASE DATE SOURCE ↗" kind="outline" onPress={() => openUrl(releaseInfoForProduct(selectedProduct).sourceUrl)} /> : null}<Btn label="SEARCH EBAY LISTINGS ↗" kind="teal" onPress={() => openUrl(searchEbay(selectedProduct.mattelCode || selectedProduct.name))} /><Btn label="GOOGLE WEB SEARCH ↗" kind="outline" onPress={() => openUrl(searchWeb(selectedProduct.mattelCode || selectedProduct.name))} />{(selectedProduct.sourceUrls || []).map((sourceUrl, sourceIndex) => <Btn key={sourceUrl + sourceIndex} label={'ONLINE SOURCE ' + (sourceIndex + 1) + ' ↗'} kind="outline" onPress={() => openUrl(sourceUrl)} />)}</>}
              {screen === 'WebSearch' && <><TopBar title={webSearchTitle || 'WEB SEARCH'} onBack={() => setScreen('Result')} /><View style={styles.unverifiedBanner}><Text style={styles.unverifiedFlag}>⚠ EXTERNAL RESULTS · UNVERIFIED</Text><Text style={styles.unverifiedText}>These are live third-party search pages. Ghoul ID also tries to read accessible public search-page HTML and rank candidate names, but some websites block automated reading. Nothing is confirmed until you choose a candidate.</Text></View><View style={{flex:1,minHeight:420,borderRadius:12,overflow:'hidden',backgroundColor:'#fff'}}><WebView source={{uri:webSearchUrl}} style={{flex:1}} startInLoadingState renderLoading={() => <View style={styles.loadingBox}><ActivityIndicator size="large" color={PINK} /><Text style={styles.body}>Loading web results…</Text></View>} onError={() => Alert.alert('Search could not load', 'This website may block embedded browsers. Open the search externally instead.', [{text:'Open in browser',onPress:()=>openUrl(webSearchUrl)},{text:'Cancel',style:'cancel'}])} /></View><Btn label="OPEN THIS SEARCH IN BROWSER ↗" kind="outline" onPress={() => openUrl(webSearchUrl)} /><Btn label="SAVE CODE AS UNVERIFIED WISHLIST ITEM" kind="purple" onPress={() => { setScreen('Result'); saveUnknownToCollection('wanted'); }} /></>}
              {screen === 'Discoveries' && <><TopBar title="NEW WIKI DISCOVERIES" onBack={goHome} /><View style={styles.unverifiedBanner}><Text style={styles.unverifiedFlag}>⚠ NEEDS VERIFICATION</Text><Text style={styles.unverifiedText}>These are automatically discovered Wiki index candidates, not verified catalog entries. The source may contain incomplete or ambiguous rows. Confirm product identity before treating an item as correct.</Text></View><Btn label="REFRESH DISCOVERY LIST" kind="teal" onPress={() => refreshRemoteCatalog(true)} />{discoveryItems.length ? discoveryItems.slice(0,250).map((item,i)=><View key={item.candidateId||item.mattelCodeCandidate+i} style={styles.infoCard}><Text style={styles.productTitle}>{item.name || 'Unnamed Wiki candidate'}</Text><Text style={styles.muted}>Possible Mattel code: {item.mattelCodeCandidate || 'Not identified'}</Text><Text style={styles.muted}>Status: not verified; not yet in main catalog</Text><Btn label="OPEN WIKI SOURCE ↗" kind="outline" onPress={() => openUrl(item.wikiUrl || 'https://monsterhigh.fandom.com/wiki/Product_number')} /><Btn label="ADD PROVISIONALLY TO WISHLIST" kind="purple" onPress={() => saveCandidateToWishlist(item)} /></View>) : <View style={styles.infoCard}><Text style={styles.productTitle}>No discovery queue downloaded</Text><Text style={styles.body}>The daily GitHub workflow must run successfully and publish catalog-discovery.json. Until then, the built-in catalog remains available.</Text><Btn label="OPEN MONSTER HIGH WIKI INDEX ↗" onPress={() => openUrl('https://monsterhigh.fandom.com/wiki/Product_number')} /></View>}</>}
              {screen === 'Releases' && <><TopBar title="UPCOMING RELEASES" onBack={goHome} /><Text style={styles.body}>Release dates are only shown when they have been added to the remotely published release calendar. Dates can change; check the official Mattel listing before purchase.</Text><Btn label="REFRESH CATALOG NOW" kind="teal" onPress={() => refreshRemoteCatalog(true)} />{releaseItems.filter(x => x && x.name && x.releaseDate && new Date(x.releaseDate+'T23:59:59') >= new Date()).length ? releaseItems.filter(x => x && x.name && x.releaseDate && new Date(x.releaseDate+'T23:59:59') >= new Date()).sort((a,b)=>String(a.releaseDate).localeCompare(String(b.releaseDate))).map((item,i)=><View key={item.id||item.name+i} style={styles.infoCard}><Text style={styles.productTitle}>{item.name}</Text><Text style={styles.muted}>Release date: {formatReleaseDate(item.releaseDate)}</Text>{item.status ? <Text style={styles.muted}>Status: {item.status}</Text> : null}<Text style={styles.unverifiedText}>{item.verified ? 'Date source verified' : '⚠ Date not independently verified'}</Text>{item.officialUrl ? <Btn label="OFFICIAL PRODUCT PAGE ↗" onPress={() => openUrl(item.officialUrl)} /> : <Btn label="CHECK MATTEL LAUNCH CALENDAR ↗" onPress={() => openUrl('https://creations.mattel.com/pages/launch-calendar')} />}{item.wikiUrl ? <Btn label="WIKI DETAILS ↗" kind="outline" onPress={() => openUrl(item.wikiUrl)} /> : null}{item.sourceUrl ? <Btn label="VIEW RELEASE SOURCE ↗" kind="outline" onPress={() => openUrl(item.sourceUrl)} /> : null}</View>) : <View style={styles.infoCard}><Text style={styles.productTitle}>No upcoming release dates published</Text><Text style={styles.body}>The screen is ready, but the remote release-calendar.json must be populated with real, sourced dates before it can show upcoming products or schedule notifications.</Text><Btn label="OPEN OFFICIAL MATTEL LAUNCH CALENDAR ↗" onPress={() => openUrl('https://creations.mattel.com/pages/launch-calendar')} /></View>}<Btn label="SCHEDULE RELEASE NOTIFICATIONS" kind="purple" onPress={scheduleReleaseReminders} /></>}
              {screen === 'History' && <><TopBar title="SCAN HISTORY" onBack={goHome} />{history.length ? history.map((h,i) => <Pressable key={h.at+i} style={styles.productRow} onPress={() => {setCode(h.code);setManualCode(h.code);setScreen('Result');}}><View style={{flex:1}}><Text style={styles.productTitle}>{h.code}</Text><Text style={styles.muted}>{new Date(h.at).toLocaleString()}</Text></View><Text style={styles.chevron}>›</Text></Pressable>) : <Text style={styles.body}>Your recent scans will appear here.</Text>}<Btn label="CLEAR SCAN HISTORY" kind="outline" onPress={() => Alert.alert('Clear history?', 'This cannot be undone.', [{text:'Cancel',style:'cancel'},{text:'Clear',style:'destructive',onPress:()=>setHistory([])}])} /></>}
              {screen === 'Settings' && <><TopBar title="SETTINGS" onBack={goHome} /><View style={styles.infoCard}><Text style={styles.productTitle}>Your data stays on this device</Text><Text style={styles.body}>Your owned list, wishlist, favorites, notes, and scan history are saved locally. No account or paid server is required. Clearing app data may erase this information.</Text></View><View style={styles.infoCard}><Text style={styles.productTitle}>Catalog synchronization</Text><Text style={styles.body}>The app checks the public GitHub catalog and release-calendar JSON when launched. The last good download is cached for offline use. To update all users without an app release, the repository owner must publish updated catalog.json and release-calendar.json files.</Text><Text style={styles.muted}>{catalogSyncAt ? 'Last successful sync: ' + new Date(catalogSyncAt).toLocaleString() : 'No successful online sync yet.'}</Text></View><Btn label={catalogSyncing ? 'REFRESHING…' : 'REFRESH CATALOG NOW'} kind="teal" onPress={() => refreshRemoteCatalog(true)} /><View style={styles.infoCard}><Text style={styles.productTitle}>Barcode stability delay</Text><Text style={styles.body}>How long a barcode must remain visible before it becomes selectable. Default: 900 ms. This affects live barcode detection only; it does not take photos.</Text><View style={styles.filterRow}>{SCAN_DELAY_OPTIONS.map(ms => <Pressable key={ms} onPress={() => setScanDelayMs(ms)} style={[styles.chip, scanDelayMs===ms && styles.chipActive]}><Text style={styles.chipText}>{ms} ms{scanDelayMs===ms?' ✓':''}</Text></Pressable>)}</View></View><Btn label="UPCOMING RELEASES & ALERTS" kind="purple" onPress={() => setScreen('Releases')} /><Btn label="SCHEDULE RELEASE NOTIFICATIONS" kind="outline" onPress={scheduleReleaseReminders} /><Btn label="OFFICIAL MONSTER HIGH ↗" onPress={() => openUrl('https://creations.mattel.com/collections/monster-high')} /><Btn label="MATTEL PRODUCT SUPPORT ↗" kind="outline" onPress={() => openUrl('https://service.mattel.com/')} /><Btn label="RESET LOCAL APP DATA" kind="outline" onPress={() => Alert.alert('Reset Ghoul ID?', 'This erases your local collection, notes, favorites, and scan history.', [{text:'Cancel',style:'cancel'},{text:'Reset',style:'destructive',onPress:async()=>{setOwned([]);setWanted([]);setFavorites([]);setNotes({});setHistory([]);setPhotos({});setCustomItems([]);setReleaseNotificationsEnabled(false);await Notifications.cancelAllScheduledNotificationsAsync().catch(()=>{});await AsyncStorage.removeItem(STORE_KEY).catch(()=>{});}}])} /></>}
              <View style={styles.footer}><Text style={styles.footerBrand}>GHOUL ID</Text><Text style={styles.footerText}>SCAN • IDENTIFY • COLLECT</Text><Text style={styles.footerText}>Independent collector companion. Monster High and related trademarks belong to their respective owners.</Text></View>
            </ScrollView>
            {['Home','Catalog','Collection','Settings'].includes(screen) && <View style={[styles.bottomNav,{height:62+Math.max(insets.bottom,0),paddingBottom:Math.max(insets.bottom,0)}]}>{[['Home','⌂'],['Collection','♡'],['Catalog','▤'],['Settings','⚙']].map(([name,icon]) => <Pressable key={name} onPress={() => {setScanning(false);setScreen(name);if(name==='Collection')setCollectionFilter('All');}} style={styles.navItem}><Text style={[styles.navIcon,screen===name&&{color:PINK}]}>{icon}</Text><Text style={[styles.navLabel,screen===name&&{color:PINK}]}>{name.toUpperCase()}</Text></Pressable>)}</View>}
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function TopBar({ title, onBack }) { return <View style={styles.topBar}><Pressable onPress={onBack} style={styles.backButton}><Text style={styles.navText}>‹ BACK</Text></Pressable><Text style={styles.screenTitle}>{title}</Text><View style={{width:54}} /></View>; }

const styles = StyleSheet.create({
  container:{flex:1,backgroundColor:BG}, content:{padding:18,paddingBottom:28}, header:{alignItems:'center',paddingTop:8,paddingBottom:22}, logoMark:{width:76,height:68,borderWidth:2,borderColor:TEAL,borderRadius:20,alignItems:'center',justifyContent:'center',backgroundColor:'#1b1325',marginBottom:7},logoSkull:{fontSize:43,color:'#fff'},logoBow:{position:'absolute',right:4,top:0,color:PINK,fontSize:27,fontWeight:'900'},brand:{color:'#fff',fontSize:36,fontWeight:'900',letterSpacing:2},tagline:{color:'#d8c6e2',fontSize:10,fontWeight:'900',letterSpacing:2,marginTop:4},hero:{backgroundColor:PANEL,borderWidth:1,borderColor:'#58304f',borderRadius:22,padding:19,marginBottom:15},heroEyebrow:{color:TEAL,fontSize:9,fontWeight:'900',letterSpacing:1.5},heroTitle:{fontSize:37,fontWeight:'900',color:'#fff',lineHeight:40,marginTop:9,marginBottom:8},body:{color:'#d8cde0',fontSize:14,lineHeight:21,marginTop:4,marginBottom:6},button:{backgroundColor:PINK,borderRadius:12,paddingVertical:14,paddingHorizontal:14,alignItems:'center',justifyContent:'center',marginTop:9,minHeight:46},buttonTeal:{backgroundColor:TEAL},buttonPurple:{backgroundColor:PURPLE},buttonOutline:{backgroundColor:'transparent',borderWidth:1,borderColor:'#9e69a8'},buttonSmall:{paddingVertical:10,minHeight:38,flex:1},buttonText:{color:'#1b0d1b',fontSize:12,fontWeight:'900',letterSpacing:.5,textAlign:'center'},statsRow:{flexDirection:'row',gap:8,marginBottom:22},stat:{flex:1,backgroundColor:PANEL,borderRadius:13,padding:13,alignItems:'center'},statNum:{fontSize:24,color:PINK,fontWeight:'900'},statLabel:{fontSize:9,color:'#c9b7d2',fontWeight:'900',letterSpacing:1,marginTop:3},sectionTitle:{color:PINK,fontSize:11,fontWeight:'900',letterSpacing:1.8,marginTop:15,marginBottom:10},quickGrid:{flexDirection:'row',flexWrap:'wrap',gap:9},quickTile:{width:'48%',flexGrow:1,backgroundColor:PANEL,borderWidth:1,borderColor:'#3f2c4b',borderRadius:14,padding:14},quickIcon:{fontSize:24,color:TEAL},quickLabel:{fontSize:11,color:'#fff',fontWeight:'900',letterSpacing:1,marginTop:8},noteCard:{borderLeftWidth:3,borderLeftColor:TEAL,backgroundColor:'#191322',padding:13,marginTop:20,borderRadius:8},noteTitle:{fontSize:10,color:TEAL,fontWeight:'900',letterSpacing:1.5},topBar:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:20,paddingTop:4},backButton:{width:54},navText:{color:TEAL,fontSize:12,fontWeight:'900'},screenTitle:{color:'#fff',fontSize:15,fontWeight:'900',letterSpacing:1},input:{backgroundColor:'#241a30',borderWidth:1,borderColor:'#62486c',borderRadius:12,color:'#fff',paddingHorizontal:13,paddingVertical:13,fontSize:14,marginTop:10,marginBottom:7},scanScreen:{flex:1,padding:15},cameraFrame:{height:340,borderRadius:18,overflow:'hidden',backgroundColor:'#050408',borderWidth:1,borderColor:'#56344e',marginTop:10},camera:{flex:1},scanTop:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:9},scanCorners:{...StyleSheet.absoluteFillObject},corner:{position:'absolute',width:35,height:35,borderColor:PINK},c1:{top:18,left:18,borderTopWidth:4,borderLeftWidth:4,borderTopLeftRadius:8},c2:{top:18,right:18,borderTopWidth:4,borderRightWidth:4,borderTopRightRadius:8},c3:{bottom:18,left:18,borderBottomWidth:4,borderLeftWidth:4,borderBottomLeftRadius:8},c4:{bottom:18,right:18,borderBottomWidth:4,borderRightWidth:4,borderBottomRightRadius:8},centerMuted:{textAlign:'center',color:'#c4b4cf',fontSize:12,marginTop:10},scanControls:{flexDirection:'row',gap:10,marginTop:5},manualBox:{marginTop:12},permissionBox:{flex:1,alignItems:'center',justifyContent:'center',padding:20},resultHero:{backgroundColor:PANEL,borderRadius:18,borderWidth:1,borderColor:'#753d73',padding:18,marginBottom:10},resultLabel:{color:TEAL,fontWeight:'900',fontSize:10,letterSpacing:1.5},unverifiedBanner:{backgroundColor:'#382a0d',borderColor:'#facc15',borderWidth:1,borderRadius:10,padding:12,marginTop:10,marginBottom:10},unverifiedFlag:{color:'#facc15',fontSize:11,fontWeight:'900',letterSpacing:.8},unverifiedText:{color:'#fff0bd',fontSize:12,lineHeight:18,marginTop:5},scannedCode:{fontSize:25,color:PINK,fontWeight:'900',marginTop:8,marginBottom:8},resultName:{fontSize:20,color:'#fff',fontWeight:'900',marginTop:4},muted:{color:'#b9a9c5',fontSize:11,lineHeight:16,marginTop:4},actionGrid:{gap:2,marginVertical:7},chip:{paddingHorizontal:13,paddingVertical:9,borderRadius:20,backgroundColor:'#2a2034',borderWidth:1,borderColor:'#594463'},chipActive:{backgroundColor:'#7e276d',borderColor:PINK},chipText:{color:'#f5eaf9',fontSize:11,fontWeight:'800'},filterRow:{flexDirection:'row',flexWrap:'wrap',gap:7,marginBottom:12},productRow:{flexDirection:'row',alignItems:'center',gap:12,padding:12,backgroundColor:PANEL,borderRadius:13,borderWidth:1,borderColor:'#3d2d49',marginBottom:8},productThumb:{width:48,height:52,borderRadius:10,backgroundColor:'#32203e',alignItems:'center',justifyContent:'center',overflow:'hidden'},thumbImage:{width:'100%',height:'100%'},resultPhoto:{width:'100%',height:210,marginBottom:14,borderRadius:12,backgroundColor:'#17111f'},productPhoto:{width:'100%',height:260,marginBottom:12,borderRadius:12,backgroundColor:'#17111f'},ocrPhoto:{width:'100%',height:220,marginVertical:12,borderRadius:12,backgroundColor:'#17111f'},loadingBox:{padding:30,alignItems:'center',justifyContent:'center'},ocrCandidate:{backgroundColor:'#25172f',borderColor:PINK,borderWidth:1,borderRadius:12,padding:13,marginBottom:8},ocrCandidateLabel:{color:TEAL,fontSize:9,fontWeight:'900',letterSpacing:1,marginBottom:5},ocrLine:{padding:10,borderBottomWidth:1,borderBottomColor:'#302238'},thumbSkull:{fontSize:28,color:'#fff'},productTitle:{color:'#fff',fontSize:14,fontWeight:'900'},chevron:{color:PINK,fontSize:27},infoCard:{backgroundColor:PANEL,borderRadius:14,padding:16,borderWidth:1,borderColor:'#493653',marginTop:10},bigSkull:{height:120,alignItems:'center',justifyContent:'center'},bigSkullText:{fontSize:90,color:'#fff'},bigBow:{position:'absolute',right:'25%',top:7,color:PINK,fontSize:40},footer:{alignItems:'center',marginTop:27,paddingTop:15,borderTopWidth:1,borderTopColor:'#302238',gap:5},footerBrand:{color:PINK,fontSize:15,fontWeight:'900',letterSpacing:3},footerText:{color:'#897b94',fontSize:9,textAlign:'center',lineHeight:14},bottomNav:{height:62,backgroundColor:'#191321',borderTopWidth:1,borderTopColor:'#3a2a44',flexDirection:'row',justifyContent:'space-around',alignItems:'center'},navItem:{alignItems:'center',justifyContent:'center',flex:1},navIcon:{fontSize:20,color:'#a99bb4'},navLabel:{fontSize:8,color:'#a99bb4',fontWeight:'900',letterSpacing:.4,marginTop:2},filterRow:{gap:7},centerMuted:{textAlign:'center',color:'#c4b4cf',fontSize:12,marginTop:10}
});
