import { describe, it, expect, beforeAll } from 'vitest';

// Pure-logic specs for stripe.service helpers. DB- and Stripe-backed
// flows (webhook handlers, Checkout Session, Cancel/Resume ownership
// guard) need a network stub; the settings-parse layer does not and
// is the contract that gates the tenant billing page.

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

async function importLib() {
  return await import('./stripe.service');
}

describe('stripe.service.resolveSubscribableProductIds', () => {
  it('prefers stripe_billing_page_products when it has entries', async () => {
    const { resolveSubscribableProductIds } = await importLib();
    const out = resolveSubscribableProductIds(
      JSON.stringify(['prod_billing_1', 'prod_billing_2']),
      JSON.stringify(['prod_gate_1'])
    );
    expect(out.ids).toEqual(['prod_billing_1', 'prod_billing_2']);
    expect(out.source).toBe('billing');
  });

  it('falls back to stripe_gate_products when billing is empty', async () => {
    const { resolveSubscribableProductIds } = await importLib();
    const out = resolveSubscribableProductIds(
      JSON.stringify([]),
      JSON.stringify(['prod_gate_1'])
    );
    expect(out.ids).toEqual(['prod_gate_1']);
    expect(out.source).toBe('gate');
  });

  it('falls back to gate when billing setting is absent entirely', async () => {
    const { resolveSubscribableProductIds } = await importLib();
    const out = resolveSubscribableProductIds(null, JSON.stringify(['prod_gate_x']));
    expect(out.ids).toEqual(['prod_gate_x']);
    expect(out.source).toBe('gate');
  });

  it('returns empty when neither setting is configured', async () => {
    const { resolveSubscribableProductIds } = await importLib();
    const out = resolveSubscribableProductIds(null, null);
    expect(out.ids).toEqual([]);
    expect(out.source).toBe('none');
  });

  it('tolerates malformed JSON by treating it as empty', async () => {
    // Malformed setting must never throw — the tenant billing page
    // calls listSubscribableProducts on mount and a throw here would
    // leave the page broken until an admin intervened.
    const { resolveSubscribableProductIds } = await importLib();
    const out = resolveSubscribableProductIds('not-json', 'also-not-json');
    expect(out.ids).toEqual([]);
    expect(out.source).toBe('none');
  });

  it('falls back to gate when billing setting is malformed', async () => {
    const { resolveSubscribableProductIds } = await importLib();
    const out = resolveSubscribableProductIds('{nope', JSON.stringify(['prod_gate_x']));
    expect(out.ids).toEqual(['prod_gate_x']);
    expect(out.source).toBe('gate');
  });

  it('strips non-string entries defensively', async () => {
    // Defends against an admin editing the raw setting and leaving a
    // stray number or null — we silently drop those rather than
    // passing them to stripe.products.retrieve(nonString).
    const { resolveSubscribableProductIds } = await importLib();
    const out = resolveSubscribableProductIds(
      JSON.stringify(['prod_good', 123, null, 'prod_also_good']),
      null
    );
    expect(out.ids).toEqual(['prod_good', 'prod_also_good']);
    expect(out.source).toBe('billing');
  });

  it('treats a non-array JSON value as empty', async () => {
    const { resolveSubscribableProductIds } = await importLib();
    const out = resolveSubscribableProductIds('"just a string"', null);
    expect(out.ids).toEqual([]);
    expect(out.source).toBe('none');
  });
});
