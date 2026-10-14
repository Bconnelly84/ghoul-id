const normalize = value => String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
const decodeHtml = value => String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/ig, (_, n) => String.fromCharCode(parseInt(n, 16)));
const stripHtml = value => decodeHtml(String(value || '').replace(/<script[\s\S]*?<\/script>/ig, ' ').replace(/<style[\s\S]*?<\/style>/ig, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const safeCandidateTitle = value => {
  const title = stripHtml(value).replace(/\s*[|–—-]\s*(Google Search|eBay|Mattel.*|Monster High Wiki.*|Search.*)$/i, '').trim();
  if (title.length < 8 || title.length > 180) return '';
  if (/^(monster high|search results|results for|sign in|shop by category|skip to|menu|home)$/i.test(title)) return '';
  if (!/monster high|draculaura|frankie stein|clawdeen|lagoona|cleo de nile|ghoulia|abbey bominable|skullector|mattel/i.test(title)) return '';
  if (/fashion pack|accessory pack|replacement part|doll stand|clothing pack/i.test(title)) return '';
  return title;
};
const extractWebCandidates = (html, sourceName, sourceUrl, scannedCode) => {
  const output = [];
  const text = String(html || '');
  const anchors = [...text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig)];
  for (const match of anchors) {
    const href = decodeHtml(match[1]);
    const rawText = stripHtml(match[2]);
    const title = safeCandidateTitle(rawText);
    if (!title || /^(https?:|javascript:)/i.test(title)) continue;
    let url = href;
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.startsWith('/')) {
      try { url = new URL(url, sourceUrl).toString(); } catch (_) { url = sourceUrl; }
    }
    // Search engines wrap destinations in redirect URLs. Unwrap only recognized
    // redirect parameters; otherwise keep the original source/search URL safely.
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host.endsWith('duckduckgo.com')) url = parsed.searchParams.get('uddg') || parsed.searchParams.get('rut') || url;
      else if (host.endsWith('bing.com')) {
        const wrapped = parsed.searchParams.get('u');
        if (wrapped && wrapped.startsWith('a1')) { try { url = atob(wrapped.slice(2)); } catch (_) {} }
      } else if (host.endsWith('google.com') && parsed.pathname === '/url') url = parsed.searchParams.get('q') || parsed.searchParams.get('url') || url;
    } catch (_) {}
    if (!/^https?:\/\//i.test(url) || /google\.com\/search|bing\.com\/search|duckduckgo\.com\/html|accounts\.google|ebay\.com\/sch\//i.test(url)) url = sourceUrl;
    const context = text.slice(Math.max(0, match.index - 500), Math.min(text.length, match.index + match[0].length + 900));
    const codeExact = context.toUpperCase().includes(normalize(scannedCode));
    const model = ((title + ' ' + href).match(/\b[A-Z]{2,5}\d{2,5}\b/i) || [])[0] || '';
    output.push({ name: title, sourceName, sourceUrl: url, searchPageUrl: sourceUrl, exactCodeMention: codeExact, mattelCode: model.toUpperCase(), score: (codeExact ? 8 : 0) + (model ? 2 : 0) + (/\b(doll|2.pack|three.pack|playset|skullector)\b/i.test(title) ? 2 : 0) });
    if (output.length >= 30) break;
  }
  // Some sites expose a meaningful page title but no extractable result anchors.
  if (!output.length) {
    const pageTitle = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const title = safeCandidateTitle(pageTitle);
    if (title) output.push({ name: title, sourceName, sourceUrl, searchPageUrl: sourceUrl, exactCodeMention: text.toUpperCase().includes(normalize(scannedCode)), mattelCode: '', score: text.toUpperCase().includes(normalize(scannedCode)) ? 5 : 1 });
  }
  return output;
};
const sourceFamily = sourceName => {
  const name = String(sourceName || '').toLowerCase();
  if (/google|bing|duckduckgo|web search|mattel web search/.test(name)) return 'general-web-search';
  if (/ebay/.test(name)) return 'marketplace';
  if (/wiki/.test(name)) return 'community-wiki';
  if (/mattel product support|mattel support/.test(name)) return 'mattel-support';
  if (/mattel/.test(name)) return 'official-mattel';
  return name || 'unknown-source';
};
const rankWebCandidates = results => {
  const grouped = new Map();
  for (const candidate of results) {
    const key = String(candidate.name || '').toLowerCase().replace(/^monster high[™®]?\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    const family = sourceFamily(candidate.sourceName);
    const old = grouped.get(key) || { ...candidate, sources: [], sourceUrls: [], sourceFamilies: [], score: 0, exactCodeSources: 0, _familyScores: {}, _exactFamilies: [] };
    if (candidate.sourceName && !old.sources.includes(candidate.sourceName)) old.sources.push(candidate.sourceName);
    if (candidate.sourceUrl && !old.sourceUrls.includes(candidate.sourceUrl)) old.sourceUrls.push(candidate.sourceUrl);
    if (!old.sourceFamilies.includes(family)) old.sourceFamilies.push(family);
    // Keep only the strongest observation within a source family. Google/Bing/DuckDuckGo
    // can overlap heavily, so their copies must not count as independent evidence.
    old._familyScores[family] = Math.max(old._familyScores[family] || 0, Number(candidate.score) || 0);
    if (candidate.exactCodeMention && !old._exactFamilies.includes(family)) old._exactFamilies.push(family);
    if (!old.mattelCode && candidate.mattelCode) old.mattelCode = candidate.mattelCode;
    if (candidate.name.length > old.name.length) old.name = candidate.name;
    grouped.set(key, old);
  }
  return [...grouped.values()].map(item => {
    const baseScore = Object.values(item._familyScores).reduce((sum, value) => sum + value, 0);
    const independentAgreement = Math.max(0, item.sourceFamilies.length - 1) * 4;
    const exactCodeBonus = item._exactFamilies.length * 5;
    const { _familyScores, _exactFamilies, ...clean } = item;
    return { ...clean, score: baseScore + independentAgreement + exactCodeBonus, exactCodeSources: _exactFamilies.length };
  }).sort((a,b) => b.score-a.score || b.sourceFamilies.length-a.sourceFamilies.length || a.name.localeCompare(b.name)).slice(0, 12);
};


module.exports = { decodeHtml, stripHtml, safeCandidateTitle, extractWebCandidates, sourceFamily, rankWebCandidates };
