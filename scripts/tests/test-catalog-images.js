'use strict';
const assert = require('node:assert/strict');
const { getCatalogImageCandidates } = require('../../catalog-images');
const product = {
  officialImageUrl: 'https://images.mattel.com/doll.jpg',
  imageUrl: 'https://images.mattel.com/doll.jpg',
  wikiImageUrl: 'https://static.wikia.nocookie.net/mh/wiki.jpg'
};
assert.deepEqual(getCatalogImageCandidates(product), [product.officialImageUrl, product.wikiImageUrl]);
assert.deepEqual(getCatalogImageCandidates(product, [product.officialImageUrl]), [product.wikiImageUrl]);
assert.deepEqual(getCatalogImageCandidates({imageUrl:'not a url',wikiImageUrl:'https://example.org/wiki.jpg'}), ['https://example.org/wiki.jpg']);
assert.deepEqual(getCatalogImageCandidates({officialImageUrl:'https://mattel.example/dead.jpg', wikiImageUrl:'https://wiki.example/doll.jpg', imageUrl:'https://mattel.example/dead.jpg'}, ['https://mattel.example/dead.jpg']), ['https://wiki.example/doll.jpg']);
assert.deepEqual(getCatalogImageCandidates(null), []);
console.log('Catalog image priority/fallback tests passed.');
