import { encrypt, decrypt } from './crypto';

// Versioned envelope. The `enc:v1:` prefix is the contract that
// migration 017's trigger validates — do not change without a v2 path.
const PREFIX = 'enc:v1:';

// Transitional: some existing rows are still plaintext until the backfill
// script rewrites them. When we read one, emit a single WARN per
// (table, column, row_id) so operators can track which rows are left
// without spamming every dashboard render.
const seenPlaintext = new Set<string>();

function warnPlaintext(location: string): void {
  if (seenPlaintext.has(location)) return;
  seenPlaintext.add(location);
  console.warn(`[encrypted-column] plaintext row detected at ${location} — run backfill-encrypt-credentials`);
}

export function isEncryptedString(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  if (plaintext === '') return '';
  if (plaintext.startsWith(PREFIX)) return plaintext;
  return PREFIX + encrypt(plaintext);
}

export function decryptSecret(ciphertext: string | null | undefined, location: string): string | null {
  if (ciphertext == null) return null;
  if (ciphertext === '') return '';
  if (!ciphertext.startsWith(PREFIX)) {
    warnPlaintext(location);
    return ciphertext;
  }
  return decrypt(ciphertext.slice(PREFIX.length));
}

// JSONB columns store { "_enc": "enc:v1:<base64>" }. The empty object {}
// is the schema default and is passed through as-is (no credentials to
// protect). Non-empty plaintext objects are transitional and logged.
export function encryptJsonField(
  obj: Record<string, unknown> | null | undefined
): Record<string, string> | Record<string, never> | null {
  if (obj == null) return null;
  const keys = Object.keys(obj);
  if (keys.length === 0) return {};
  if (keys.length === 1 && typeof obj._enc === 'string' && obj._enc.startsWith(PREFIX)) {
    return obj as Record<string, string>;
  }
  return { _enc: PREFIX + encrypt(JSON.stringify(obj)) };
}

export function decryptJsonField(
  value: unknown,
  location: string
): Record<string, unknown> {
  if (value == null) return {};
  const obj: Record<string, unknown> = typeof value === 'string' ? JSON.parse(value) : (value as Record<string, unknown>);
  if (!obj || typeof obj !== 'object') return {};
  const keys = Object.keys(obj);
  if (keys.length === 0) return {};
  if (keys.length === 1 && typeof obj._enc === 'string' && obj._enc.startsWith(PREFIX)) {
    const plaintext = decrypt((obj._enc as string).slice(PREFIX.length));
    return JSON.parse(plaintext) as Record<string, unknown>;
  }
  warnPlaintext(location);
  return obj;
}

// Testing hook — lets specs reset the dedup cache between cases.
export function __resetPlaintextWarnings(): void {
  seenPlaintext.clear();
}
