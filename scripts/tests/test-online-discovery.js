const assert = require('node:assert/strict');
const { extractWebCandidates, rankWebCandidates, sourceFamily } = require('../../online-discovery');

const upc = '194735256648';
const title = 'Monster High Betelgeuse and Lydia Wedding 2-Pack';
const result = (sourceName, url, score = 4, exactCodeMention = false) => ({
  name: title, sourceName, sourceUrl: url, searchPageUrl: url,
  score, exactCodeMention, mattelCode: 'HYV96'
});

assert.equal(sourceFamily('Google'), sourceFamily('Bing'));
assert.equal(sourceFamily('Bing'), sourceFamily('DuckDuckGo'));
assert.notEqual(sourceFamily('Google'), sourceFamily('eBay'));
assert.equal(sourceFamily('Mattel web search'), sourceFamily('Google'), 'a site-restricted Google query is still general-search evidence');
assert.notEqual(sourceFamily('Mattel Product Support'), sourceFamily('Google'), 'official Mattel support is a distinct evidence family');

const googleHtml = `<div><a href="https://www.ebay.com/itm/123">${title}</a></div>`;
const parsed = extractWebCandidates(googleHtml, 'Google', 'https://www.google.com/search?q=test', upc);
assert.equal(parsed.length, 1, 'extract a product title from search-result HTML');
assert.match(parsed[0].sourceUrl, /^https:\/\/www\.ebay\.com\/itm\//, 'preserve direct result URL');

const wrappedDDG = `<a href="https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://shop.mattel.com/products/example')}">${title}</a>`;
const ddgParsed = extractWebCandidates(wrappedDDG, 'DuckDuckGo', 'https://html.duckduckgo.com/html/?q=test', upc);
assert.equal(ddgParsed[0].sourceUrl, 'https://shop.mattel.com/products/example', 'unwrap DuckDuckGo destination URL');

const sameWebResults = rankWebCandidates([
  result('Google', 'https://one.example/product', 5, true),
  result('Bing', 'https://two.example/product', 10, true),
  result('DuckDuckGo', 'https://three.example/product', 8, true),
]);
assert.equal(sameWebResults.length, 1);
assert.equal(sameWebResults[0].sourceFamilies.length, 1, 'search engines are one evidence family');
assert.equal(sameWebResults[0].score, 15, 'same family contributes only its strongest score plus one exact-family bonus');

const independentResults = rankWebCandidates([
  result('Google', 'https://search.example/product', 5, true),
  result('Monster High Wiki', 'https://monsterhigh.fandom.com/wiki/example', 4, true),
  result('eBay', 'https://www.ebay.com/itm/123', 3, false),
]);
assert.equal(independentResults[0].sourceFamilies.length, 3);
assert.equal(independentResults[0].score, 30, 'independent families add agreement and exact-code evidence');
assert.equal(independentResults[0].exactCodeSources, 2);

console.log('online-discovery tests passed');
