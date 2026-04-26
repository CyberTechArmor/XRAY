-- Migration 041: seed v1 of the six required policy slugs.
--
-- Step 11 — gives the operator something to edit on first deploy
-- so the public /legal/<slug> pages render and the re-acceptance
-- modal has something to gate against. Six slugs:
--
--   terms_of_service   — the master TOS
--   privacy_policy     — GDPR Art. 13/14 disclosures
--   cookie_policy      — disclosure for the landing-page cookie banner
--   dpa                — Data Processing Agreement (GDPR Art. 28)
--   subprocessors      — list of third parties (Stripe, AWS, …)
--   acceptable_use     — content / behaviour gates
--
-- Operator-decision recap (see .claude/step-11-kickoff.md):
--   Decision 4 (seed strategy): placeholder body — short, prominent
--     "this is a placeholder, the operator must publish v2 before
--     opening signups" copy. Public page surfaces a placeholder
--     warning when version = 1 AND the body still contains the
--     marker substring, so accidental ship is loud (rendered
--     warning) rather than silent (real-but-unreviewed template).
--   Decision 5 (required vs optional): all six seeded with
--     is_required = TRUE. Operator can flip a specific slug
--     (typically subprocessors) to FALSE post-deploy via Admin →
--     Policies so its version bumps don't gate the re-acceptance
--     modal. Default is "gate everything" — safer than the
--     reverse.
--
-- ON CONFLICT DO NOTHING on (slug, version) so re-runs preserve
-- any v1 the admin has already edited (admin edits mint v2+ and
-- never touch v1; but a pristine v1 may have been replaced with
-- a different v1 via direct DB write during pre-prod).
--
-- The body_md placeholder substring `[XRAY-POLICY-PLACEHOLDER]` is
-- the marker policy.service.getLatest looks for to set the
-- `is_placeholder: true` flag in the JSON response, which the
-- public /legal/<slug> SPA route uses to render the warning
-- banner. Stripping the marker (operator publishes a real v2)
-- removes the warning automatically.
--
-- Idempotent. No data migration required.

BEGIN;

INSERT INTO platform.policy_documents (slug, version, title, body_md, is_required)
VALUES
  ('terms_of_service', 1, 'Terms of Service',
   E'# Terms of Service\n\n[XRAY-POLICY-PLACEHOLDER] This document is a placeholder. The operator should publish v2 with the actual policy text before opening signups.\n\nUntil then, by using this service you acknowledge that the binding terms have not yet been published.\n',
   TRUE),
  ('privacy_policy', 1, 'Privacy Policy',
   E'# Privacy Policy\n\n[XRAY-POLICY-PLACEHOLDER] This document is a placeholder. The operator should publish v2 with the actual policy text (GDPR Art. 13/14 disclosures: data categories, lawful basis, retention, third-party recipients, data subject rights) before opening signups.\n',
   TRUE),
  ('cookie_policy', 1, 'Cookie Policy',
   E'# Cookie Policy\n\n[XRAY-POLICY-PLACEHOLDER] This document is a placeholder. The operator should publish v2 listing each cookie set by the application, its category (essential / analytics / marketing), retention, and lawful basis before opening signups.\n',
   TRUE),
  ('dpa', 1, 'Data Processing Agreement',
   E'# Data Processing Agreement\n\n[XRAY-POLICY-PLACEHOLDER] This document is a placeholder. The operator should publish v2 with the GDPR Art. 28 controller-processor agreement (subject matter, duration, nature, types of personal data, categories of data subjects, controller obligations) before opening signups.\n',
   TRUE),
  ('subprocessors', 1, 'Sub-processors',
   E'# Sub-processors\n\n[XRAY-POLICY-PLACEHOLDER] This document is a placeholder. The operator should publish v2 enumerating every third-party data processor (cloud hosting, payments, email, analytics, …) with the data categories shared and the legal basis before opening signups.\n',
   TRUE),
  ('acceptable_use', 1, 'Acceptable Use Policy',
   E'# Acceptable Use Policy\n\n[XRAY-POLICY-PLACEHOLDER] This document is a placeholder. The operator should publish v2 describing prohibited content, abuse handling, and enforcement before opening signups.\n',
   TRUE)
ON CONFLICT (slug, version) DO NOTHING;

COMMIT;
