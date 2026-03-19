#!/usr/bin/env bash
set -euo pipefail

# ============================================================
#  XRay BI Platform — Uninstall Script
#  Tears down XRay in reverse order with confirmation prompts.
#  Run as root:  sudo bash uninstall.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info() { echo -e "  ${CYAN}→${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }

# ── Prerequisites ──────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}This script must be run as root. Use: sudo bash uninstall.sh${NC}"
  exit 1
fi

echo ""
echo -e "${RED}${BOLD}"
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║    XRay BI Platform — Uninstall           ║"
echo "  ║    This will remove the XRay deployment   ║"
echo "  ╚═══════════════════════════════════════════╝"
echo -e "${NC}"

# ── Step 1: Confirmation ──────────────────────────────────
read -rp "  Are you sure you want to uninstall XRay? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
  echo "  Cancelled."
  exit 0
fi

# ── Step 2: Docker containers & volumes ───────────────────
echo ""
echo -e "${BOLD}[1/6] Docker containers${NC}"

if command -v docker &>/dev/null && [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  read -rp "  Delete database volumes (all data will be lost)? [y/N]: " DELETE_VOLUMES

  info "Stopping containers..."
  if [[ "$DELETE_VOLUMES" =~ ^[Yy] ]]; then
    docker compose down -v 2>/dev/null || true
    ok "Containers stopped and volumes removed"
  else
    docker compose down 2>/dev/null || true
    ok "Containers stopped (volumes preserved)"
  fi
else
  warn "Docker or docker-compose.yml not found — skipping"
fi

# ── Step 3: Docker images ─────────────────────────────────
echo ""
echo -e "${BOLD}[2/6] Docker images${NC}"

if command -v docker &>/dev/null; then
  # Find XRay-specific images
  XRAY_IMAGES=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i 'xray' || true)
  if [ -n "$XRAY_IMAGES" ]; then
    info "Found XRay images:"
    echo "$XRAY_IMAGES" | while read -r img; do echo "    $img"; done
    read -rp "  Remove these images? [y/N]: " RM_IMAGES
    if [[ "$RM_IMAGES" =~ ^[Yy] ]]; then
      echo "$XRAY_IMAGES" | xargs docker rmi -f 2>/dev/null || true
      ok "Images removed"
    else
      ok "Images kept"
    fi
  else
    ok "No XRay images found"
  fi
else
  warn "Docker not found — skipping"
fi

# ── Step 4: Nginx configuration ──────────────────────────
echo ""
echo -e "${BOLD}[3/6] Nginx configuration${NC}"

NGINX_AVAILABLE="/etc/nginx/sites-available/xray.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/xray.conf"

if [ -f "$NGINX_AVAILABLE" ] || [ -L "$NGINX_ENABLED" ]; then
  read -rp "  Remove Nginx configuration for XRay? [y/N]: " RM_NGINX
  if [[ "$RM_NGINX" =~ ^[Yy] ]]; then
    rm -f "$NGINX_ENABLED" 2>/dev/null || true
    rm -f "$NGINX_AVAILABLE" 2>/dev/null || true

    # Remove static files
    if [ -d "/var/www/xray" ]; then
      rm -rf /var/www/xray
      ok "Static files removed from /var/www/xray"
    fi

    # Remove SSL params if we installed them
    rm -f /etc/nginx/snippets/ssl-params.conf 2>/dev/null || true
    rm -f /etc/nginx/ssl-params.conf 2>/dev/null || true

    if command -v nginx &>/dev/null; then
      nginx -t 2>/dev/null && systemctl reload nginx
    fi
    ok "Nginx configuration removed and reloaded"
  else
    ok "Nginx configuration kept"
  fi
else
  ok "No XRay Nginx configuration found"
fi

# ── Step 5: TLS certificate ──────────────────────────────
echo ""
echo -e "${BOLD}[4/6] TLS certificate${NC}"

# Try to extract domain from .env
DOMAIN=""
if [ -f "$SCRIPT_DIR/.env" ]; then
  DOMAIN=$(grep -oP '(?<=RP_ID=).+' "$SCRIPT_DIR/.env" 2>/dev/null || true)
fi

if [ -n "$DOMAIN" ] && [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  info "Found TLS certificate for: ${DOMAIN}"
  read -rp "  Remove Let's Encrypt certificate for ${DOMAIN}? [y/N]: " RM_CERT
  if [[ "$RM_CERT" =~ ^[Yy] ]]; then
    if command -v certbot &>/dev/null; then
      certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null || true
      ok "Certificate removed"
    else
      warn "Certbot not found — cannot remove certificate automatically"
      warn "Manually remove from /etc/letsencrypt/live/${DOMAIN}/"
    fi
  else
    ok "Certificate kept"
  fi
else
  ok "No TLS certificate found to remove"
fi

# ── Step 6: .env file ────────────────────────────────────
echo ""
echo -e "${BOLD}[5/6] Environment file${NC}"

if [ -f "$SCRIPT_DIR/.env" ]; then
  read -rp "  Remove .env file (contains secrets)? [y/N]: " RM_ENV
  if [[ "$RM_ENV" =~ ^[Yy] ]]; then
    # Overwrite before deleting for security
    dd if=/dev/urandom of="$SCRIPT_DIR/.env" bs=1024 count=1 2>/dev/null || true
    rm -f "$SCRIPT_DIR/.env"
    ok ".env securely deleted"
  else
    ok ".env kept"
  fi
else
  ok "No .env file found"
fi

# ── Step 7: Project directory ─────────────────────────────
echo ""
echo -e "${BOLD}[6/6] Project directory${NC}"

echo -e "  ${YELLOW}Current directory: ${SCRIPT_DIR}${NC}"
read -rp "  Remove entire project directory? [y/N]: " RM_DIR
if [[ "$RM_DIR" =~ ^[Yy] ]]; then
  read -rp "  Type 'DELETE' to confirm: " CONFIRM_DELETE
  if [ "$CONFIRM_DELETE" = "DELETE" ]; then
    cd /
    rm -rf "$SCRIPT_DIR"
    ok "Project directory removed"
  else
    warn "Confirmation failed — directory kept"
  fi
else
  ok "Project directory kept"
fi

echo ""
echo -e "${GREEN}${BOLD}  XRay BI Platform has been uninstalled.${NC}"
echo ""
