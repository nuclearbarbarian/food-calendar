'use strict';

const SLOTS = ['breakfast', 'lunch', 'dinner'];

// Canonical unit list. Keep small and stable — shopping-list merging depends on
// exact-match on (name, unit). Adding a unit later is cheap; splitting one is not.
const UNITS = [
  'count',
  'pinch',
  'dash',
  'tsp',
  'tbsp',
  'cup',
  'fl_oz',
  'pint',
  'quart',
  'gallon',
  'ml',
  'l',
  'oz',
  'lb',
  'g',
  'kg',
  'to_taste',
];

const UNIT_LABELS = {
  count: 'count',
  pinch: 'pinch',
  dash: 'dash',
  tsp: 'tsp',
  tbsp: 'tbsp',
  cup: 'cup',
  fl_oz: 'fl oz',
  pint: 'pint',
  quart: 'quart',
  gallon: 'gallon',
  ml: 'ml',
  l: 'L',
  oz: 'oz',
  lb: 'lb',
  g: 'g',
  kg: 'kg',
  to_taste: 'to taste',
};


function isSlot(value) {
  return SLOTS.includes(value);
}

function isUnit(value) {
  return value === null || value === undefined || UNITS.includes(value);
}

// Add N days to an ISO YYYY-MM-DD string. Returns a new ISO string.
// Uses UTC arithmetic on day-only strings — no time-of-day component.
function addDaysToIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + n);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Returns YYYY-MM-DD in the given IANA timezone. Never use toISOString().slice(0,10).
function formatDate(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  SLOTS,
  UNITS,
  UNIT_LABELS,
  isSlot,
  isUnit,
  formatDate,
  addDaysToIso,
  escapeHtml,
};
