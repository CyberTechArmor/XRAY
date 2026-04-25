# Step 8 — GitHub repo settings checklist

The step-8 commits ship Dependabot, CI, CodeQL, Trivy, and
gitleaks. Most of the protection only takes effect once an admin
flips the corresponding repo toggles in the GitHub web UI.

URL: <https://github.com/cybertecharmor/xray/settings>

## Security & analysis (Settings → Code security and analysis)

- [ ] **Dependabot alerts** — enable.
- [ ] **Dependabot security updates** — enable. Pairs with
      `.github/dependabot.yml` (step 8/1) so security PRs open
      automatically when a CVE drops.
- [ ] **Secret scanning** — enable.
- [ ] **Push protection for secret scanning** — enable. Blocks a
      push when GitHub detects a known secret pattern. Layered
      with the local gitleaks pre-commit (step 8/5).
- [ ] **Code scanning** — enable for CodeQL. Auto-detects the
      `.github/workflows/codeql.yml` shipped in step 8/3.

## Branch protection — `main` (Settings → Branches → Add rule)

- [ ] **Require a pull request before merging** — on.
  - [ ] **Require approvals** — at least 1.
  - [ ] **Dismiss stale pull request approvals when new commits
        are pushed** — on.
- [ ] **Require status checks to pass before merging** — on.
      After the first PR runs, mark these as required:
  - [ ] `ci / typecheck + test (server)`
  - [ ] `ci / trivy (server image)`
  - [ ] `codeql / analyze (javascript-typescript)`
- [ ] **Require branches to be up to date before merging** — on.
- [ ] **Require linear history** — recommended (matches the
      one-commit-per-concern rhythm 6 → 7 → 8 use).
- [ ] **Do not allow bypassing the above settings** — on.

## Merging behaviour (Settings → General → Pull Requests)

- [ ] **Allow squash merging** — on, "PR title" as default
      commit message.
- [ ] **Allow merge commits** — off.
- [ ] **Allow rebase merging** — off (avoids divergence with the
      squash default; flip on later if a use case appears).
- [ ] **Automatically delete head branches** — on.

## Confirmation

When the toggles are flipped, ack in the step-8 PR thread (or
the post-merge close-out issue) so future audits have a paper
trail. Anything left off blunts the step's protection — the
workflows ship the gates, but the repo admin enforces them.
