'use strict';

/** Return unique image URLs in priority order: Mattel official, selected image, Wiki fallback. */
function getCatalogImageCandidates(product, failedUrls = []) {
  if (!product || typeof product !== 'object') return [];
  const failed = new Set(failedUrls);
  const urls = [product.officialImageUrl, product.imageUrl, product.wikiImageUrl]
    .filter(value => typeof value === 'string' && /^https?:\/\//i.test(value.trim()))
    .map(value => value.trim());
  return [...new Set(urls)].filter(url => !failed.has(url));
}

module.exports = { getCatalogImageCandidates };
