'use strict';

function isValidGtin(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  const body = digits.slice(0, -1).split('').reverse().map(Number);
  const sum = body.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.slice(-1));
}

function parseBarcodeCandidate(value) {
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  return { raw, digits, checksumValid: isValidGtin(digits) };
}

function getBarcodeBounds(event) {
  const bounds = event?.bounds || event?.boundingBox || null;
  const points = Array.isArray(event?.cornerPoints)
    ? event.cornerPoints
    : Array.isArray(bounds?.cornerPoints) ? bounds.cornerPoints : null;
  if (points?.length) {
    const xs = points.map(point => Number(point?.x)).filter(Number.isFinite);
    const ys = points.map(point => Number(point?.y)).filter(Number.isFinite);
    if (xs.length && ys.length) {
      return {
        origin: { x: Math.min(...xs), y: Math.min(...ys) },
        size: { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      };
    }
  }
  if (bounds?.origin && bounds?.size) return bounds;
  if (bounds && Number.isFinite(Number(bounds.x)) && Number.isFinite(Number(bounds.y))) {
    return { origin: { x: Number(bounds.x), y: Number(bounds.y) }, size: { width: Number(bounds.width) || 48, height: Number(bounds.height) || 32 } };
  }
  return null;
}

module.exports = { parseBarcodeCandidate, getBarcodeBounds, isValidGtin };
