#!/usr/bin/env bash
# Step 7 (B1): pre-commit guard for the tenant-context helper convention.
#
# Fails the commit if a file outside the allow-list contains a direct
# call to `withClient(` — the intent being that every tenant-scoped
# path goes through `withTenantContext` and every deliberate
# cross-tenant read goes through `withAdminClient`. See CLAUDE.md
# "Database context helpers" and .claude/withclient-audit.md for the
# full story.
#
# The allow-list is the short roster of files that legitimately hold
# unauth / bootstrap / carve-out paths:
#   - server/src/db/connection.ts   (helper definitions)
#   - server/src/services/auth.service.ts   (U paths: magic link, passkey challenge)
#   - server/src/services/settings.service.ts   (platform_settings, no RLS)
#   - server/src/services/email.service.ts   (email_templates, no RLS)
#   - server/src/services/email-templates.ts   (boot seed into email_templates)
#
# Usage:
#   scripts/check-withclient-allowlist.sh                  # scan full tree
#   scripts/check-withclient-allowlist.sh --staged         # scan staged files only (for pre-commit)
#   scripts/check-withclient-allowlist.sh --allowlist      # print the allow-list and exit
#
# Exit codes:
#   0 — OK (no violations)
#   1 — at least one file outside the allow-list contains `withClient(`
#   2 — usage / internal error

set -euo pipefail

ALLOWLIST=(
  # Helper definitions themselves.
  "server/src/db/connection.ts"
  # Unauth / U paths + no-RLS carve-out tables.
  "server/src/services/auth.service.ts"
  "server/src/services/settings.service.ts"
  "server/src/services/email.service.ts"
  "server/src/services/email-templates.ts"
  # Carve-out-only readers (platform_settings, tenants, roles,
  # role_permissions, permissions, connection_templates). The tables
  # these files read/write have no RLS per migration 029's carve-out
  # list, so plain withClient is semantically correct.
  "server/src/services/meet.service.ts"
  "server/src/services/rbac.service.ts"
  "server/src/services/role.service.ts"
  "server/src/services/tenant.service.ts"
)

print_allowlist() {
  printf '%s\n' "${ALLOWLIST[@]}"
}

is_allowed() {
  local f="$1"
  for a in "${ALLOWLIST[@]}"; do
    if [ "$f" = "$a" ]; then
      return 0
    fi
  done
  return 1
}

MODE="full"
if [ "${1:-}" = "--staged" ]; then
  MODE="staged"
elif [ "${1:-}" = "--allowlist" ]; then
  print_allowlist
  exit 0
elif [ -n "${1:-}" ]; then
  echo "usage: $0 [--staged|--allowlist]" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Build the file list.
if [ "$MODE" = "staged" ]; then
  FILES="$(git diff --cached --name-only --diff-filter=ACMR -- 'server/src/**/*.ts' || true)"
else
  FILES="$(find server/src -type f -name '*.ts' 2>/dev/null || true)"
fi

VIOLATIONS=0
VIOLATION_LINES=""

while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  # Skip test files — tests can exercise withClient directly.
  case "$f" in
    *.test.ts) continue ;;
  esac
  if is_allowed "$f"; then
    continue
  fi
  # `\bwithClient\s*\(` matches a direct call (not `withAdminClient(`).
  # Using grep -P for word-boundary.
  matches="$(grep -nP '\bwithClient\s*\(' "$f" || true)"
  if [ -n "$matches" ]; then
    VIOLATIONS=$((VIOLATIONS + 1))
    VIOLATION_LINES+="$f:"$'\n'"$matches"$'\n\n'
  fi
done <<< "$FILES"

if [ "$VIOLATIONS" -gt 0 ]; then
  cat >&2 <<EOF
────────────────────────────────────────────────────────────────────
withClient allow-list violation

The following file(s) call withClient() directly but are NOT on the
tenant-context helper allow-list. Migrate each site to one of:

  withTenantContext(tenantId, fn)   — tenant-scoped paths (default)
  withAdminClient(fn)               — deliberate cross-tenant reads
  withTenantTransaction(tenantId, fn) / withAdminTransaction(fn)

Or, if this file genuinely belongs on the allow-list (unauth / bootstrap
/ no-RLS carve-out table), update scripts/check-withclient-allowlist.sh
and CLAUDE.md with the rationale.

Violations:
$VIOLATION_LINES
Allow-list (post-step-7):
$(print_allowlist | sed 's/^/  /')
────────────────────────────────────────────────────────────────────
EOF
  exit 1
fi

exit 0
