import { createHash, timingSafeEqual } from 'crypto';

/**
 * Small security helpers shared by the webhooks and logs.
 */

/** Compares a secret someone sent with the expected one in constant time, so response timing
 * can't be used to guess it a character at a time. False when either is missing. */
export function safeEqual(given: unknown, expected: string | undefined | null): boolean {
  if (typeof given !== 'string' || !given || !expected) return false;
  // Hashing first gives equal-length buffers whatever the inputs' lengths.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** "+97150•••••67" — enough to tell numbers apart in logs without storing who it is. */
export function maskPhone(phone: string | null | undefined): string {
  const d = (phone || '').replace(/\D/g, '');
  if (d.length < 6) return d ? '•••' : '';
  return `+${d.slice(0, 5)}${'•'.repeat(Math.max(3, d.length - 7))}${d.slice(-2)}`;
}

/** "an•••@acme.com" */
export function maskEmail(email: string | null | undefined): string {
  const e = (email || '').trim();
  const at = e.indexOf('@');
  if (at < 1) return e ? '•••' : '';
  return `${e.slice(0, Math.min(2, at))}•••${e.slice(at)}`;
}
