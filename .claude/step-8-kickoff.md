# XRay — Step 8 kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing step 8 of the XRay platform hardening track.
Step 7 closed out platform DB RLS hardening: tenant-context helpers
fully adopted, pre-commit guard locked the allow-list, embed
projection tightened, inbox user_scope RLS shipped, portability
gap-fill landed, and the `tenant_invitation` template branded the
admin invite path. See the **Step 7** section of `CONTEXT.md` and
`.claude/withclient-audit.md` for the migrated call-site inventory.

The full forward-looking roadmap (steps 8 → 21) is in the
**"Roadmap — steps 8 through 21"** section at the end of
`CONTEXT.md`. Read that section first — it explains why step 8 is
CI plumbing and not auth hardening (next step's territory) or
Pipeline DB Model D (step 12).

Step 8 is **CI / supply-chain plumbing.** It's deliberately a small
protective baseline — Dependabot, secret scanning, SAST, container
scanning, lockfile-strict — landing *before* steps 9-12 add more
sensitive code. Most of step 8 is YAML config files in `.github/`,
not application code.

## Current step

**Step 8 — CI plumbing.**

The roadmap allocates 6-8 commits. Items, in suggested order:

### A. Repository foundation (no `.github` exists yet)

The repo currently has no `.github/` directory, no CI, no
automated dep scanning. Step 8 creates the foundation.

1. **Bootstrap `.github/`** — empty directory + a placeholder
   `CODEOWNERS` if appropriate. One commit.
2. **`.github/dependabot.yml`** — daily / weekly check schedule
   for both `npm` (server/) and `docker` (Dockerfile base
   image). Group minor/patch updates into single PRs to reduce
   noise. Open one PR per major upgrade. One commit.

### B. Static analysis in CI

3. **`.github/workflows/ci.yml`** — the baseline CI workflow.
   Triggers on `push` + `pull_request`. Steps:
   - Checkout
   - Setup Node (match server/package.json's engines field)
   - `npm ci` (NOT `npm install` — fails on lockfile drift)
   - `npm run typecheck` (verify the script exists, add if missing)
   - `npm test` (the existing 135 active specs)

   Single commit. Verify it green-lights against the current
   tree before adding anything heavier.

4. **CodeQL workflow** — `.github/workflows/codeql.yml` using the
   GitHub-published `github/codeql-action`. Languages:
   `javascript-typescript`. Schedule: weekly + on `push` to main.
   One commit.

5. **Trivy image scan** — append a `image-scan` job to `ci.yml`
   that builds the server Docker image and runs
   `aquasecurity/trivy-action` against it. Severity gate: fail on
   `CRITICAL` and `HIGH` for OS + library CVEs. Allow-list known-
   accepted findings via `.trivyignore` if any false positives
   surface during the first run. One commit.

### C. Secret scanning + lockfile strictness

6. **gitleaks pre-commit hook** — extend `.githooks/pre-commit`
   (the existing withClient guard already lives there) to run
   `gitleaks protect --staged --redact`. Document one-time
   `git config core.hooksPath .githooks` enable in CLAUDE.md
   (already mentioned for the withClient guard — extend the
   note). One commit.

7. **Dockerfile lockfile strictness** — confirm `server/Dockerfile`
   uses `npm ci --only=production`. If it uses `npm install`,
   migrate. Verify `package-lock.json` is committed in `server/`
   (assume yes; the install.sh path requires it). One commit
   only if changes needed; can fold into the dependabot commit
   if Dockerfile is already correct.

8. **GitHub repo settings checklist** — NOT a code change, but a
   doc in `.claude/step-8-repo-settings.md` listing the toggles
   the operator must flip in `https://github.com/cybertecharmor/xray/settings`:
   - **Security & analysis** → enable Dependabot alerts,
     Dependabot security updates, secret scanning, push
     protection.
   - **Branch protection** for `main` — require PRs, require
     status checks (ci, codeql), require approval, dismiss stale
     reviews on push.
   - **Code scanning** — enable for CodeQL.

   These are repo-admin actions, not code. Doc + ask the
   operator to confirm flipped post-merge. One commit.

## Working rhythm

- One concern per commit. Same rhythm as steps 6-7.
- Run `npm test` + `npx tsc --noEmit` after each application-
  affecting change (most of step 8 is CI YAML; tests apply if
  the typecheck script needs to be added/edited).
- After each workflow file lands, push the branch and verify the
  workflow actually fires + passes on GitHub. CI files that
  fail to parse or fail their first run aren't shipped, even if
  they typecheck locally.
- Develop on `claude/xray-ci-plumbing-<suffix>` branched from
  the post-step-7 head. Confirm branch name with the operator
  before pushing.

## Acceptance

- `.github/` exists with `dependabot.yml`, `workflows/ci.yml`,
  `workflows/codeql.yml`.
- All workflows are green on the branch's first push.
- `gitleaks` runs on staged files via the pre-commit hook
  alongside the existing withClient guard.
- `server/Dockerfile` uses `npm ci`, not `npm install`.
- `.claude/step-8-repo-settings.md` documents the GitHub web-UI
  toggles for the operator.
- `npm test`: 135 green (unchanged from step 7's baseline).
- `tsc --noEmit`: clean.

## Updating CONTEXT.md

Append a **"Step 8 — CI plumbing (shipped)"** section at the end
of `CONTEXT.md`, before the "Roadmap" section, modeled on the step
7 section's shape: commit trail table, what shipped, what didn't,
acceptance, deploy notes (mostly "merge → operator flips repo
settings"), verification (run the workflows on a test PR).

## What step 8 must NOT do

- **No application code changes** beyond `package.json`'s
  `typecheck` script (if it doesn't exist) and Dockerfile lockfile
  strictness. Step 8's protection is *plumbing*.
- **No auth changes** — that's step 9's territory.
- **No new tables, no migrations, no RLS changes.**
- **No CSRF middleware, no rate-limit middleware** — both are
  step 9 / step 10.
- **No secret rotation** if `gitleaks` flags historical commits.
  Surface findings in a doc, defer the rotation runbook to a
  separate concern. (The step assumes a clean history. If
  gitleaks finds something pre-existing, STOP and flag.)

## After step 8 — production-ready?

**No.** Step 8 is CI plumbing only. Production-readiness is
gated on step 12 (after auth hardening, privacy docs, and
pipeline DB Model D ship). See the "Production-readiness gate"
sub-section in CONTEXT.md's roadmap for the full list.

Step 8's value is *reducing the cost of every step that follows*:
Dependabot catches CVEs the moment they're disclosed in deps that
land in step 9-12; CodeQL flags injection patterns before they
hit main; secret scanning prevents the irreversible "leaked key
in a commit" failure mode; the green-CI baseline gives you
confidence that step 9 doesn't break step 7's tests.

## First action

Read this kickoff + the Roadmap section of `CONTEXT.md` + the
existing `.githooks/pre-commit` (it has the withClient guard
that gitleaks will extend, not replace). Produce a plan that:

- Confirms the commit shape (1-7 above) is right.
- Flags any GitHub Actions runner version or Node version
  ambiguity (e.g., does CI Node match the Dockerfile's Node?).
- Identifies whether `package-lock.json` is committed (verify
  with `git ls-files server/package-lock.json`); if not, the
  step's first commit is the lockfile commit.

Wait for operator approval before pushing the first commit.
