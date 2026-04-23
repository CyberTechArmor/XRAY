import { encrypt, decrypt } from './crypto';

// Versioned envelope. The `enc:v1:` prefix is the contract that
// migration 017's trigger validates — do not change without a v2 path.
const PREFIX = 'enc:v1:';

// Step 6 (v) retired the plaintext-read fallback. Before step 6,
// decryptSecret / decryptJsonField returned plaintext input unchanged
// and emitted a single WARN per (table, column, row_id), tolerating
// rows that pre-dated step 1's encryption backfill. Every VPS that
// upgrades through step 1 runs the backfill, so any plaintext row
// reaching decrypt now is a bug signal (missed backfill, direct DB
// write bypassing the enforcement triggers, or a trigger that was
// DISABLEd) — preferable to throw loudly than silently return a
// credential that was never meant to be stored unencrypted.

function decryptFailure(reason: string, location: string): Error {
  return new Error(
    `[encrypted-column] ${reason} at ${location}. ` +
    `Rows must carry the enc:v1: envelope. If this is a legacy ` +
    `row, run backfill-encrypt-credentials once and retry.`
  );
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
    throw decryptFailure('plaintext row detected', location);
  }
  return decrypt(ciphertext.slice(PREFIX.length));
}

// JSONB columns store { "_enc": "enc:v1:<base64>" }. The empty object {}
// is the schema default and is passed through as-is (no credentials to
// protect). Non-empty plaintext objects are a bug signal — throw.
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
  throw decryptFailure('plaintext JSON object detected', location);
}
