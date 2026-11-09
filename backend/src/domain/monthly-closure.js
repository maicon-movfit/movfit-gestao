import { createHash } from 'node:crypto';

export function normalizeCompetence(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day] = match;
  if (Number(month) < 1 || Number(month) > 12 || (day && day !== '01')) return null;
  return `${year}-${month}-01`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function checksumSnapshot(snapshot) {
  return createHash('sha256').update(JSON.stringify(canonicalize(snapshot))).digest('hex');
}
