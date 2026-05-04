// Runtime fallback for /vendor/fonts/google-fonts.css and the woff2
// files it references.
//
// Why: scripts/fetch-vendor-assets.sh fetches the Google Fonts bundle
// at install/update time and ships it inside the server image. When
// that fetch fails on the deploy host (no outbound to googleapis.com,
// curl missing, sha mismatch on a CDN regression, etc.), the static
// file isn't there and Express falls through to the SPA shell — which
// in some configurations surfaces as a 500 against a CSS request and
// always means dashboards render without their fonts.
//
// This module proxies the bundle on demand so the runtime path is
// self-healing:
//   GET /vendor/fonts/google-fonts.css
//     1. Serve frontend/vendor/fonts/google-fonts.css if present.
//     2. Otherwise fetch the canonical googleapis.com CSS, rewrite
//        every `https://fonts.gstatic.com/s/<rel>` reference to a
//        same-origin `/vendor/fonts/files/<rel>` path, cache and
//        return.
//
//   GET /vendor/fonts/files/<rel>.woff2
//     1. Serve frontend/vendor/fonts/files/<rel> if present.
//     2. Otherwise fetch from fonts.gstatic.com/s/<rel>, cache (in
//        memory, capped) and return.
//
// Same-origin delivery preserves the Tracking-Prevention immunity the
// vendor flow exists to provide. The in-memory cache is small (one
// CSS string + a handful of woff2 buffers) so it's safe to keep on
// the request path.

import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

const GOOGLE_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap';
// googleapis.com returns DIFFERENT CSS bodies based on UA — an old/
// generic UA gets TTF references; a recent Chrome UA gets woff2 (what
// we actually want to vendor). Force a modern Chrome UA on every hop.
const GOOGLE_FONTS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let cachedCss: string | null = null;
let cssFetchInflight: Promise<string> | null = null;
const fileCache = new Map<string, Buffer>();
const FILE_CACHE_MAX = 64; // a full DM Sans + JetBrains Mono bundle is ~30 woff2

function localCandidates(rel: string): string[] {
  // Mirror the frontendCandidates probe in index.ts so this module
  // works in both the in-image (/app/frontend) layout and the dev
  // (<repo>/frontend) layout without an env override.
  return [
    path.resolve(__dirname, '../../frontend/vendor/fonts', rel),
    path.resolve(__dirname, '../../../frontend/vendor/fonts', rel),
  ];
}

function tryServeLocal(res: Response, rel: string, contentType: string, immutable: boolean): boolean {
  for (const p of localCandidates(rel)) {
    try {
      if (fs.statSync(p).isFile()) {
        res.setHeader('Content-Type', contentType);
        res.setHeader(
          'Cache-Control',
          immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
        );
        res.sendFile(p);
        return true;
      }
    } catch {
      /* ignore — try next candidate */
    }
  }
  return false;
}

async function fetchAndRewriteCss(): Promise<string> {
  const r = await fetch(GOOGLE_FONTS_URL, {
    headers: { 'User-Agent': GOOGLE_FONTS_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`googleapis css fetch failed: ${r.status}`);
  const css = await r.text();
  // The format inside the CSS is `src: url(https://fonts.gstatic.com/s/.../<hash>.woff2)`.
  // Rewrite every gstatic URL to the same-origin proxy path so the
  // browser stays on the XRay origin for the woff2 fetch too.
  return css.replace(
    /https:\/\/fonts\.gstatic\.com\/s\/([^)"']+\.woff2)/g,
    '/vendor/fonts/files/$1',
  );
}

export async function serveGoogleFontsCss(_req: Request, res: Response): Promise<void> {
  if (tryServeLocal(res, 'google-fonts.css', 'text/css; charset=utf-8', false)) return;

  if (cachedCss) {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(cachedCss);
    return;
  }

  if (!cssFetchInflight) {
    cssFetchInflight = fetchAndRewriteCss()
      .then((c) => {
        cachedCss = c;
        return c;
      })
      .catch((e) => {
        // Drop the inflight promise so the next request retries.
        cssFetchInflight = null;
        throw e;
      });
  }

  try {
    const css = await cssFetchInflight;
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(css);
  } catch {
    res.status(502).type('text/plain').send('google-fonts.css unavailable');
  }
}

export async function serveGoogleFontsFile(req: Request, res: Response): Promise<void> {
  const rel = String((req.params as Record<string, string>)[0] ?? '').trim();
  // Defensive: only allow a sane woff2 path. Reject traversal and
  // anything that isn't a leaf woff2 file under the gstatic /s/ tree.
  if (!rel || rel.includes('..') || !/^[A-Za-z0-9_./-]+\.woff2$/.test(rel)) {
    res.status(400).type('text/plain').send('bad path');
    return;
  }

  if (tryServeLocal(res, path.join('files', rel), 'font/woff2', true)) return;

  const cached = fileCache.get(rel);
  if (cached) {
    res.setHeader('Content-Type', 'font/woff2');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(cached);
    return;
  }

  try {
    const upstreamUrl = 'https://fonts.gstatic.com/s/' + rel;
    const r = await fetch(upstreamUrl, {
      headers: { 'User-Agent': GOOGLE_FONTS_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      res.status(502).type('text/plain').send(`upstream ${r.status}`);
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (fileCache.size < FILE_CACHE_MAX) fileCache.set(rel, buf);
    res.setHeader('Content-Type', 'font/woff2');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch {
    res.status(502).type('text/plain').send('fetch failed');
  }
}
