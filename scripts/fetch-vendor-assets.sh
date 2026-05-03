#!/usr/bin/env bash
# Fetch self-hosted vendor assets — Chart.js (and any other 3rd-party
# JS we want immune to browser Tracking Prevention / CDN outages /
# jsdelivr rate limits).
#
# Why self-host: dashboards rendered inside XRay's authenticated DOM
# pull <script src="https://cdn.jsdelivr.net/...chart.umd.min.js">
# from n8n's HTML payload. Edge / Brave / Safari periodically block
# the load via Tracking Prevention's site-engagement scoring, which
# decays after a few minutes of no interaction with that origin. The
# Chart constructor then throws ReferenceError, halting render mid-
# flight. Hosting the file on XRay's own origin makes it same-origin
# from the iframe's parent — Tracking Prevention does not apply.
#
# Idempotent. Safe to re-run on every deploy. Skips a download if the
# target file already exists AND its sha256 matches the pinned hash.
# update.sh and install.sh both call this before the frontend deploy
# step.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="${SCRIPT_DIR}/../frontend/vendor"
mkdir -p "${VENDOR_DIR}"

# ── Asset table ────────────────────────────────────────────────
# One row per vendored file:
#   <relative path under frontend/vendor>|<source URL>|<sha256>
#
# To add a new vendored asset:
#   1. Add a row here.
#   2. Reference it from your dashboard HTML as
#      <script src="https://<xray-origin>/vendor/<relative path>">
#      (absolute URL — the dashboard is rendered in a srcdoc iframe
#      whose origin is about:srcdoc, so relative URLs don't resolve
#      to the XRay origin).
#
# To bump a version:
#   1. Update the relative path (so the old file stays cached for any
#      dashboard still pointing at it).
#   2. Update source URL + sha256.
#   3. Operators run update.sh; the new file ships alongside the old.
#
# sha256 protects against a CDN supply-chain attack — a tampered
# upload won't match the hash and the deploy aborts.
#
# Pinning workflow: leave sha256 EMPTY for a brand-new asset. The
# first run logs the actual sha; copy that value into the row and
# commit. Subsequent runs verify against it.
ASSETS=(
  "chart.js@4.4.1/chart.umd.min.js|https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js|"
)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
err()  { echo -e "  ${RED}✗${NC} $1" >&2; }

if ! command -v curl >/dev/null 2>&1; then
  err "curl not on PATH — install curl or run this on a host with internet access"
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  err "sha256sum not on PATH"
  exit 1
fi

fetched=0
verified=0
failed=0
for row in "${ASSETS[@]}"; do
  IFS='|' read -r relpath url expected_sha <<< "$row"
  target="${VENDOR_DIR}/${relpath}"
  mkdir -p "$(dirname "$target")"

  if [ -f "$target" ]; then
    actual_sha="$(sha256sum "$target" | awk '{print $1}')"
    if [ -z "$expected_sha" ]; then
      verified=$((verified + 1))
      warn "${relpath}: cached locally; pin sha256=${actual_sha} in fetch-vendor-assets.sh to enable verification"
      continue
    fi
    if [ "$actual_sha" = "$expected_sha" ]; then
      verified=$((verified + 1))
      continue
    fi
    warn "${relpath}: sha256 mismatch on local copy — re-fetching"
    rm -f "$target"
  fi

  # Download to a tmp file so a partial fetch never gets served. curl
  # follows redirects (-L), fails on HTTP errors (-f), is silent
  # except errors (-S). 30s connect, 120s overall.
  tmp="${target}.partial"
  if ! curl -fsSLo "$tmp" --connect-timeout 30 --max-time 120 "$url"; then
    err "${relpath}: download failed from ${url}"
    rm -f "$tmp"
    failed=$((failed + 1))
    continue
  fi

  actual_sha="$(sha256sum "$tmp" | awk '{print $1}')"
  if [ -z "$expected_sha" ]; then
    mv "$tmp" "$target"
    fetched=$((fetched + 1))
    warn "${relpath} (UNVERIFIED first download). Pin sha256=${actual_sha} in fetch-vendor-assets.sh and commit."
    continue
  fi
  if [ "$actual_sha" != "$expected_sha" ]; then
    err "${relpath}: sha256 mismatch — got ${actual_sha}, expected ${expected_sha}"
    rm -f "$tmp"
    failed=$((failed + 1))
    continue
  fi

  mv "$tmp" "$target"
  fetched=$((fetched + 1))
  ok "${relpath} (sha256 verified)"
done

if [ "$failed" -gt 0 ]; then
  err "${failed} vendor asset(s) failed to fetch — dashboards depending on them will fall through to the CDN"
  exit 1
fi

# ── Google Fonts bundle ────────────────────────────────────────
# Special handling because Google Fonts has TWO layers:
#   1. A CSS file at fonts.googleapis.com/css2?family=...
#   2. woff2 binaries at fonts.gstatic.com/s/...woff2 — referenced
#      from inside the CSS via `src: url(...)`.
#
# Rewriting just the <link> href to a same-origin URL doesn't help —
# the browser still goes off-origin to fetch each woff2 when it parses
# the CSS body. So we vendor BOTH layers: download the CSS, extract
# every gstatic URL, download each woff2, rewrite the CSS body in
# place to point at /vendor/fonts/files/<path>, and serve the whole
# bundle from /vendor/fonts/google-fonts.css.
#
# The bundle URL below covers every family + weight any current
# XRay dashboard pulls in (DM Sans + JetBrains Mono per the
# housecall_pro / finops console dashboards). To add a family,
# extend the URL with another `&family=...` segment and re-run
# update.sh — the CSS + woff2s refresh in place.
#
# UA matters: googleapis returns DIFFERENT CSS based on User-Agent.
# An old / generic UA gets TTF references; modern Chrome UA gets
# woff2 (smaller, faster). Force a recent Chrome UA so woff2 is
# what we vendor.
GOOGLE_FONTS_URL="${GOOGLE_FONTS_URL:-https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap}"
GOOGLE_FONTS_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
FONTS_DIR="${VENDOR_DIR}/fonts"
FONTS_FILES_DIR="${FONTS_DIR}/files"
FONTS_CSS="${FONTS_DIR}/google-fonts.css"
mkdir -p "${FONTS_FILES_DIR}"

fetch_google_fonts_bundle() {
  local css_tmp
  css_tmp="$(mktemp)"
  if ! curl -fsSL -A "$GOOGLE_FONTS_UA" --connect-timeout 30 --max-time 120 \
       -o "$css_tmp" "$GOOGLE_FONTS_URL"; then
    err "Google Fonts CSS download failed from ${GOOGLE_FONTS_URL}"
    rm -f "$css_tmp"
    return 1
  fi

  # Extract every gstatic.com URL referenced inside the CSS body.
  # Format inside the CSS is `src: url(https://fonts.gstatic.com/s/.../<hash>.woff2)`.
  # Sort -u in case the same woff2 appears in multiple unicode-range
  # blocks (it doesn't typically, but defensive).
  local gstatic_urls
  gstatic_urls=$(grep -oE 'https://fonts\.gstatic\.com/s/[^)]+\.woff2' "$css_tmp" | sort -u)

  if [ -z "$gstatic_urls" ]; then
    warn "Google Fonts CSS contained no woff2 references — vendoring CSS as-is (browser may still fetch off-origin)"
    mv "$css_tmp" "$FONTS_CSS"
    return 0
  fi

  local woff_count=0
  local woff_failed=0
  while IFS= read -r url; do
    # Strip the host so we can preserve the original path inside
    # /vendor/fonts/files/ — keeps the CSS rewrite simple (single
    # find/replace per URL) and avoids name collisions across
    # families.
    local rel_path="${url#https://fonts.gstatic.com/s/}"
    local local_target="${FONTS_FILES_DIR}/${rel_path}"
    mkdir -p "$(dirname "$local_target")"
    if [ ! -f "$local_target" ]; then
      if ! curl -fsSL -A "$GOOGLE_FONTS_UA" --connect-timeout 30 --max-time 60 \
           -o "$local_target" "$url"; then
        warn "Google Fonts woff2 fetch failed: ${url}"
        woff_failed=$((woff_failed + 1))
        continue
      fi
    fi
    woff_count=$((woff_count + 1))
    # Rewrite this URL inside the CSS to the same-origin path. `|`
    # delimiter avoids escaping the slashes in the URL. The replaced
    # path is absolute (starts with /vendor/...) so it works
    # regardless of where the CSS file ends up being served from.
    local replacement="/vendor/fonts/files/${rel_path}"
    sed -i "s|${url}|${replacement}|g" "$css_tmp"
  done <<< "$gstatic_urls"

  # Move the rewritten CSS into place atomically.
  mv "$css_tmp" "$FONTS_CSS"

  if [ "$woff_failed" -gt 0 ]; then
    warn "Google Fonts: ${woff_count} woff2(s) vendored, ${woff_failed} failed — affected glyphs will fall back to system fonts"
  else
    ok "Google Fonts: ${woff_count} woff2 file(s) vendored, CSS rewritten to same-origin"
  fi
  return 0
}

if fetch_google_fonts_bundle; then
  : # success messages already printed
else
  warn "Google Fonts bundle skipped — dashboards using it will fall through to the public CDN"
fi

ok "Vendor assets ready: ${fetched} fetched, ${verified} already current"
