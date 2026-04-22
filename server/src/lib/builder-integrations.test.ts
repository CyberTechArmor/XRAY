import { describe, expect, it } from 'vitest';

// Behavior contract for window.__xrayBuildIntegrationOptions in
// frontend/app.js. The bundle's dashboard builder uses it to populate
// the Integration dropdown. This spec mirrors the helper locally — keep
// in sync with app.js if the logic there changes.
//
// Contract:
//   - Always leads with { value: '', label: 'Custom (no auth)' }.
//   - Appends one option per active integration row, in input order.
//   - Uses display_name when set, otherwise falls back to the slug.
//   - Skips rows without a slug (defensive).
//   - Preserves currentValue when it doesn't match any catalog row,
//     labelling it '<slug> (not in catalog)' with preserved=true so
//     render-path graceful-degrade stays the source of truth for
//     missing-slug behavior.
//   - Does not add a preserved row when currentValue is empty or null.
type IntegrationRow = {
  slug: string;
  display_name?: string | null;
};
type Option = { value: string; label: string; preserved?: true };

function buildIntegrationOptions(
  integrations: IntegrationRow[] | null | undefined,
  currentValue: string | null | undefined
): Option[] {
  const out: Option[] = [{ value: '', label: 'Custom (no auth)' }];
  if (Array.isArray(integrations)) {
    for (const it of integrations) {
      if (!it || !it.slug) continue;
      out.push({ value: it.slug, label: it.display_name || it.slug });
    }
  }
  if (currentValue && !out.some((o) => o.value === currentValue)) {
    out.push({ value: currentValue, label: currentValue + ' (not in catalog)', preserved: true });
  }
  return out;
}

describe('builder-integrations.buildIntegrationOptions', () => {
  it('always leads with the Custom (no auth) sentinel', () => {
    const opts = buildIntegrationOptions([], '');
    expect(opts[0]).toEqual({ value: '', label: 'Custom (no auth)' });
  });

  it('appends active catalog entries as options — HouseCall Pro + QuickBooks', () => {
    const opts = buildIntegrationOptions(
      [
        { slug: 'housecall_pro', display_name: 'HouseCall Pro' },
        { slug: 'quickbooks', display_name: 'QuickBooks' },
      ],
      ''
    );
    expect(opts).toHaveLength(3);
    expect(opts[1]).toEqual({ value: 'housecall_pro', label: 'HouseCall Pro' });
    expect(opts[2]).toEqual({ value: 'quickbooks', label: 'QuickBooks' });
  });

  it('falls back to the slug when display_name is missing or blank', () => {
    const opts = buildIntegrationOptions(
      [
        { slug: 'hcp', display_name: '' },
        { slug: 'qbo' },
      ],
      ''
    );
    expect(opts[1]).toEqual({ value: 'hcp', label: 'hcp' });
    expect(opts[2]).toEqual({ value: 'qbo', label: 'qbo' });
  });

  it('skips rows without a slug (defensive against partial server responses)', () => {
    const opts = buildIntegrationOptions(
      [
        { slug: '', display_name: 'No slug' } as IntegrationRow,
        { slug: 'hcp', display_name: 'HouseCall Pro' },
      ],
      ''
    );
    // Sentinel + hcp only; the slug-less row is dropped.
    expect(opts).toHaveLength(2);
    expect(opts[1]!.value).toBe('hcp');
  });

  it('preserves a current value not present in the catalog with a "(not in catalog)" suffix', () => {
    const opts = buildIntegrationOptions(
      [{ slug: 'housecall_pro', display_name: 'HouseCall Pro' }],
      'legacy_slug'
    );
    expect(opts).toHaveLength(3);
    expect(opts[2]).toEqual({
      value: 'legacy_slug',
      label: 'legacy_slug (not in catalog)',
      preserved: true,
    });
  });

  it('does not duplicate the current value when it matches a catalog row', () => {
    const opts = buildIntegrationOptions(
      [{ slug: 'housecall_pro', display_name: 'HouseCall Pro' }],
      'housecall_pro'
    );
    expect(opts).toHaveLength(2);
    expect(opts.filter((o) => o.value === 'housecall_pro')).toHaveLength(1);
  });

  it('does not add a preserved row when currentValue is empty, null, or undefined', () => {
    for (const cv of ['', null, undefined]) {
      const opts = buildIntegrationOptions(
        [{ slug: 'hcp', display_name: 'HouseCall Pro' }],
        cv as string | null | undefined
      );
      expect(opts).toHaveLength(2);
      expect(opts.every((o) => o.preserved !== true)).toBe(true);
    }
  });

  it('tolerates a null or non-array integrations input', () => {
    expect(buildIntegrationOptions(null, '')).toEqual([{ value: '', label: 'Custom (no auth)' }]);
    expect(buildIntegrationOptions(undefined, '')).toEqual([
      { value: '', label: 'Custom (no auth)' },
    ]);
  });
});
