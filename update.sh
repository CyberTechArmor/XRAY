#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# XRay SaaS Platform — Update Script
# Pulls latest code and redeploys frontend + backend
# Usage:  sudo bash update.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
err()  { echo -e "  ${RED}✗${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║       XRay Platform — Update          ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ── Step 1: Pull latest code ──
echo "  [1/4] Pulling latest code..."
cd "$SCRIPT_DIR"
if git rev-parse --is-inside-work-tree &>/dev/null; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  git pull origin "$BRANCH" --ff-only 2>/dev/null && ok "Code updated (branch: $BRANCH)" || {
    warn "Git pull failed — using local files as-is"
  }
else
  warn "Not a git repo — using local files"
fi

# ── Step 2: Deploy frontend files ──
echo "  [2/4] Deploying frontend..."
WEBROOT="/var/www/xray"
if [ -d "$WEBROOT" ]; then
  mkdir -p "$WEBROOT/bundles"
  if [ -f "$SCRIPT_DIR/frontend/index.html" ]; then
    cp "$SCRIPT_DIR/frontend/index.html" "$WEBROOT/"
    ok "index.html updated"
  fi
  if [ -d "$SCRIPT_DIR/frontend/bundles" ]; then
    cp "$SCRIPT_DIR/frontend/bundles/"* "$WEBROOT/bundles/"
    ok "Bundles updated"
  fi
  chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true
else
  warn "Webroot $WEBROOT not found — skipping frontend deploy"
fi

# ── Step 3: Rebuild and restart backend ──
echo "  [3/4] Rebuilding backend..."
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  cd "$SCRIPT_DIR"
  docker compose build --quiet 2>/dev/null && ok "Backend rebuilt" || warn "Docker build failed"
  docker compose up -d 2>/dev/null && ok "Backend restarted" || warn "Docker restart failed"
else
  warn "No docker-compose.yml found — skipping backend rebuild"
fi

# ── Step 4: Reload nginx ──
echo "  [4/4] Reloading nginx..."
if command -v nginx &>/dev/null; then
  nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null && ok "Nginx reloaded" || warn "Nginx reload failed"
else
  warn "Nginx not found"
fi

echo ""
ok "Update complete!"
echo ""
