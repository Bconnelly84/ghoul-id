const normalize = value => String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
const decodeHtml = value => String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/ig, (_, n) => String.fromCharCode(parseInt(n, 16)));
const stripHtml = value => decodeHtml(String(value || '').replace(/<script[\s\S]*?<\/script>/ig, ' ').replace(/<style[\s\S]*?<\/style>/ig, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const isEbayUrl = value => { try { const host = new URL(String(value || '')).hostname.toLowerCase(); return host === 'ebay.com' || host.endsWith('.ebay.com') || host === 'ebay.co.uk' || host.endsWith('.ebay.co.uk'); } catch (_) { return false; } };

const isGenericTitle = value => /^(monster high|mattel|monster high mattel doll|mattel monster high doll|monster high mattel|mattel doll|monster high dolls|search results|results for|sign in|shop by category|skip to|menu|home)$/i.test(stripHtml(value));
const safeCandidateTitle = value => {
  const title = stripHtml(value).replace(/\s*[|–—-]\s*(Google Search|eBay|Mattel.*|Monster High Wiki.*|Search.*)$/i, '').trim();
  if (title.length < 8 || title.length > 180 || isGenericTitle(title)) return '';
  if (!/monster high|draculaura|frankie stein|clawdeen|lagoona|cleo de nile|ghoulia|abbey bominable|skullector|twyla|toralei|spectra|operetta|nefera|deuce|mattel/i.test(title)) return '';
  if (/fashion pack|accessory pack|replacement part|doll stand|clothing pack/i.test(title)) return '';
  if (/^(monster high\s+)?(mattel\s+)?doll$/i.test(title)) return '';
  return title;
};

const extractWebCandidates = (html, sourceName, sourceUrl, scannedCode) => {
  const output = [];
  const text = String(html || '');
  const anchors = [...text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig)];
  for (const match of anchors) {
    const href = decodeHtml(match[1]);
    const title = safeCandidateTitle(stripHtml(match[2]));
    if (!title || /^(https?:|javascript:)/i.test(title)) continue;
    let url = href;
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.startsWith('/')) {
      try { url = new URL(url, sourceUrl).toString(); } catch (_) { url = sourceUrl; }
    }
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host.endsWith('duckduckgo.com')) url = parsed.searchParams.get('uddg') || parsed.searchParams.get('rut') || url;
      else if (host.endsWith('google.com') && parsed.pathname === '/url') url = parsed.searchParams.get('q') || parsed.searchParams.get('url') || url;
    } catch (_) {}
    if (!/^https?:\/\//i.test(url) || /google\.com\/search|duckduckgo\.com\/html|accounts\.google|ebay\.com\/sch\//i.test(url)) url = sourceUrl;

    const context = text.slice(Math.max(0, match.index - 500), Math.min(text.length, match.index + match[0].length + 900));
    const codeExact = !!normalize(scannedCode) && context.toUpperCase().includes(normalize(scannedCode));
    const model = ((title + ' ' + href).match(/\b[A-Z]{2,5}\d{2,5}\b/i) || [])[0] || '';
    const hasProductTerm = /\b(doll|2.pack|three.pack|playset|skullector|collector|frankie|draculaura|clawdeen|lagoona|cleo|ghoulia|abbey|twyla|toralei|spectra|operetta|nefera|deuce)\b/i.test(title);
    // Avoid generic product-search pages: candidate must be a real product title and have
    // exact scanned-code evidence or a recognizable Mattel model number.
    if (isGenericTitle(title) || !hasProductTerm || (!codeExact && !model)) continue;

    output.push({
      name: title,
      sourceName,
      sourceUrl: url,
      searchPageUrl: sourceUrl,
      imageUrl: '',
      exactCodeMention: codeExact,
      mattelCode: model.toUpperCase(),
      isEbayListing: isEbayUrl(url),
      isGoogleIndexedEbayListing: /google/i.test(sourceName) && isEbayUrl(url),
      score: (codeExact ? 8 : 0) + (model ? 2 : 0) + (hasProductTerm ? 2 : 0)
    });
    if (output.length >= 30) break;
  }
  return output;
};

const sourceFamily = sourceName => {
  const name = String(sourceName || '').toLowerCase();
  if (/google|duckduckgo|web search|mattel web search/.test(name)) return 'general-web-search';
  if (/ebay/.test(name)) return 'marketplace';
  if (/wiki/.test(name)) return 'community-wiki';
  if (/mattel product support|mattel support/.test(name)) return 'mattel-support';
  if (/mattel/.test(name)) return 'official-mattel';
  return name || 'unknown-source';
};

const rankWebCandidates = results => {
  const grouped = new Map();
  for (const candidate of results) {
    if (!candidate || !safeCandidateTitle(candidate.name) || isGenericTitle(candidate.name)) continue;
    if (!candidate.exactCodeMention && !candidate.mattelCode) continue;
    const key = String(candidate.name || '').toLowerCase().replace(/^monster high[™®]?\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    const family = sourceFamily(candidate.sourceName);
    const old = grouped.get(key) || { ...candidate, sources: [], sourceUrls: [], sourceFamilies: [], score: 0, exactCodeSources: 0, _familyScores: {}, _exactFamilies: [], _ebayListingUrls: [], _googleEbayListingUrls: [] };
    if (candidate.sourceName && !old.sources.includes(candidate.sourceName)) old.sources.push(candidate.sourceName);
    if (candidate.sourceUrl && !old.sourceUrls.includes(candidate.sourceUrl)) old.sourceUrls.push(candidate.sourceUrl);
    // Count distinct eBay listing URLs, not search-engine pages or source labels. Google-indexed
    // eBay listings receive the strongest weight because they have been most useful for matches.
    if (candidate.sourceUrl && (candidate.isEbayListing || isEbayUrl(candidate.sourceUrl)) && !old._ebayListingUrls.includes(candidate.sourceUrl)) old._ebayListingUrls.push(candidate.sourceUrl);
    if (candidate.sourceUrl && (candidate.isGoogleIndexedEbayListing || (/google/i.test(candidate.sourceName || '') && isEbayUrl(candidate.sourceUrl))) && !old._googleEbayListingUrls.includes(candidate.sourceUrl)) old._googleEbayListingUrls.push(candidate.sourceUrl);
    if (!old.sourceFamilies.includes(family)) old.sourceFamilies.push(family);
    old._familyScores[family] = Math.max(old._familyScores[family] || 0, Number(candidate.score) || 0);
    if (candidate.exactCodeMention && !old._exactFamilies.includes(family)) old._exactFamilies.push(family);
    if (!old.mattelCode && candidate.mattelCode) old.mattelCode = candidate.mattelCode;
    if (!old.imageUrl && candidate.imageUrl) old.imageUrl = candidate.imageUrl;
    if (candidate.name.length > old.name.length) old.name = candidate.name;
    grouped.set(key, old);
  }
  return [...grouped.values()].map(item => {
    const baseScore = Object.values(item._familyScores).reduce((sum, value) => sum + value, 0);
    const independentAgreement = Math.max(0, item.sourceFamilies.length - 1) * 4;
    const exactCodeBonus = item._exactFamilies.length * 5;
    const trustedSourceBonus = (item.sourceFamilies.includes('official-mattel') ? 12 : 0) + (item.sourceFamilies.includes('community-wiki') ? 7 : 0);
    const googleEbayResultCount = item._googleEbayListingUrls.length;
    const ebayResultCount = item._ebayListingUrls.length;
    // Repeated, distinct eBay listing matches are a first-class ranking signal. Cap the
    // bonus to prevent a huge scrape from overwhelming exact-code evidence completely.
    const ebayConsensusBonus = Math.min(googleEbayResultCount, 8) * 10 + Math.min(Math.max(0, ebayResultCount - googleEbayResultCount), 4) * 3;
    const { _familyScores, _exactFamilies, _ebayListingUrls, _googleEbayListingUrls, ...clean } = item;
    return { ...clean, score: baseScore + independentAgreement + exactCodeBonus + trustedSourceBonus + ebayConsensusBonus, exactCodeSources: _exactFamilies.length, googleEbayResultCount, ebayResultCount };
  }).sort((a,b) => b.googleEbayResultCount-a.googleEbayResultCount || b.ebayResultCount-a.ebayResultCount || b.score-a.score || b.sourceFamilies.length-a.sourceFamilies.length || a.name.localeCompare(b.name)).slice(0, 12);
};

module.exports = { decodeHtml, stripHtml, safeCandidateTitle, extractWebCandidates, sourceFamily, rankWebCandidates };
