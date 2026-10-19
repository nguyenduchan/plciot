/**
 * Vietnamese phone identity.
 * Canonical username form: 84XXXXXXXXX (11 digits, no +).
 * Accepts: 09…, 9…, +84…, 84…
 */

/** Mobile prefixes after country code 84 (first 2 digits of the 9-digit national number). */
const VN_MOBILE_2 = new Set([
  '32', '33', '34', '35', '36', '37', '38', '39',
  '52', '56', '58', '59',
  '70', '76', '77', '78', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '90', '91', '92', '93', '94', '96', '97', '98', '99',
  '55', // virtual / newer
]);

/** Normalize to digits; VN leading 0 → 84… (no +). */
export function normalizePhone(input) {
  let s = String(input || '').trim();
  if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/\D/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  // 9 digits starting 3–9 → assume missing 0 / 84
  if (s.length === 9 && /^[3-9]/.test(s)) s = '84' + s;
  // 10 digits starting with 0
  if (s.startsWith('0') && s.length === 10) s = '84' + s.slice(1);
  // already 84…
  return s;
}

/** True if canonical VN mobile username (84 + 9 digits, known prefix). */
export function isValidVnPhone(input) {
  const n = normalizePhone(input);
  if (!/^84\d{9}$/.test(n)) return false;
  const pref2 = n.slice(2, 4);
  return VN_MOBILE_2.has(pref2);
}

/** Display: 0xxxxxxxxx */
export function formatVnLocal(input) {
  const n = normalizePhone(input);
  if (n.startsWith('84') && n.length === 11) return '0' + n.slice(2);
  return n;
}

/** Display international: +84… */
export function formatVnIntl(input) {
  const n = normalizePhone(input);
  return n ? `+${n}` : '';
}

export function phoneVariants(input) {
  const n = normalizePhone(input);
  const set = new Set([n, `+${n}`]);
  if (n.startsWith('84') && n.length === 11) {
    set.add('0' + n.slice(2));
    set.add(n.slice(2));
  }
  return [...set].filter(Boolean);
}
