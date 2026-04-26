-- Migration 043: flip placeholder policy rows to is_required=FALSE.
--
-- Operator feedback after step 11 ship: the v1 placeholders should
-- not block every signed-in user with the re-acceptance modal until
-- the operator publishes real v2 content. Step 11 originally seeded
-- all six slugs as is_required=TRUE (decision #5 in the kickoff —
-- "gate everything by default, operator can flip individual slugs to
-- optional post-deploy"); this migration reverses that default for
-- rows that still carry the [XRAY-POLICY-PLACEHOLDER] marker.
--
-- Real-content rows (operator already published v2 with the marker
-- stripped) are NOT touched — those reflect the operator's
-- considered choice and shouldn't get clobbered.
--
-- Forward-looking: migration 041 in this same commit changes its
-- seed default to FALSE so a fresh deploy doesn't inherit the
-- old gate-everything posture. This 043 migration just cleans up
-- existing platforms that already ran the old 041.
--
-- The new admin UI badge (commit follow-up) lets operators toggle
-- is_required per slug without bumping the policy version.
--
-- Idempotent. Re-running matches no extra rows because the marker
-- is the only condition.

BEGIN;

UPDATE platform.policy_documents
   SET is_required = FALSE
 WHERE body_md LIKE '%[XRAY-POLICY-PLACEHOLDER]%'
   AND is_required = TRUE;

COMMIT;
