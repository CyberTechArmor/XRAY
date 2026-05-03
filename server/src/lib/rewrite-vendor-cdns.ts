// Vendor-CDN rewriter for dashboard HTML coming back from n8n / other
// integration sources.
//
// Why: dashboards are authored as portable HTML in n8n (or other
// upstreams) and typically reference Chart.js (and friends) from
// public CDNs like jsdelivr. When the HTML is rendered inside XRay's
// authenticated DOM (iframe srcdoc inside app.xray.<domain>), browsers
// with Tracking Prevention (Edge default, Brave, Safari) periodically
// block the third-party CDN load under site-engagement scoring decay.
// Chart.js then fails to define `window.Chart`, every `new Chart(...)`
// throws ReferenceError, and the dashboard renders as an empty
// "skeleton" even though the upstream returned a perfect HTML payload.
//
// The fix is to rewrite the well-known CDN URLs to XRay's own
// /vendor/<lib>/<file> path before the HTML reaches the browser.
// Same-origin assets are NOT subject to Tracking Prevention.
// Operators don't have to touch n8n templates — XRay is the single
// place a CDN swap can happen for every dashboard at once.
//
// The vendored files themselves are fetched at install / update time
// by scripts/fetch-vendor-assets.sh and served as static assets by
// the Express layer (or nginx in local-proxy mode) under /vendor/.

interface VendorMapping {
  // RegExp matching the CDN URL inside an `src="…"` / `src='…'`. Must
  // capture the URL as the only group so the replacement can swap it.
  // Use `[^"']+` patterns rather than `.*` to avoid swallowing the
  // closing quote.
  pattern: RegExp;
  // Same-origin path the matched CDN URL maps to. Always relative to
  // the XRay origin — the rewriter prepends the absolute origin so
  // the iframe srcdoc (origin = about:srcdoc) resolves it correctly.
  vendorPath: string;
  // Friendly label for log lines.
  label: string;
}

// Order matters only for performance — most-common library first.
const VENDOR_MAPPINGS: VendorMapping[] = [
  {
    label: 'Chart.js',
    // Matches both jsdelivr `/npm/chart.js@<ver>/dist/chart.umd.min.js`
    // and unpkg `chart.js@<ver>/dist/chart.umd.min.js`. Version range
    // is anything that doesn't contain a quote or slash so we don't
    // grab the closing quote.
    pattern: /https?:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/chart\.js@[^"'/]+\/dist\/chart\.umd(?:\.min)?\.js/g,
    vendorPath: '/vendor/chart.js@4.4.1/chart.umd.min.js',
  },
];

/**
 * Rewrite known CDN script URLs in `html` to absolute XRay-origin
 * /vendor/ paths. Returns the rewritten HTML and a list of which
 * mappings hit (for audit / log). No-op if no mapping matches.
 */
export function rewriteVendorCdns(
  html: string,
  xrayOrigin: string,
): { html: string; rewrites: Array<{ label: string; count: number }> } {
  if (!html || typeof html !== 'string') return { html, rewrites: [] };

  // Strip any trailing slash on the origin so concatenation produces
  // a single `/`. config.webauthn.origin can be either form.
  const origin = xrayOrigin.replace(/\/+$/, '');

  const rewrites: Array<{ label: string; count: number }> = [];
  let result = html;
  for (const m of VENDOR_MAPPINGS) {
    let count = 0;
    result = result.replace(m.pattern, () => {
      count++;
      return origin + m.vendorPath;
    });
    if (count > 0) rewrites.push({ label: m.label, count });
  }
  return { html: result, rewrites };
}
