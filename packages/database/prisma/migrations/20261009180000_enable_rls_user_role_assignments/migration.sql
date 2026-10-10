-- Row-Level Security for user_role_assignments (Issue 097, ADR-0002).
--
-- This table decides who holds which role — including super-admin — in which
-- organization, and it was missing from the original RLS migration
-- (20260904033449). Same tenant_isolation shape as the other four tables.
--
-- FORCE, like the original: ENABLE alone exempts the table owner, and the
-- owner is who the application connects as — without FORCE the policy would
-- be silently inert for the only role that matters. (FORCE still does not
-- constrain a superuser, so the application must connect as a non-superuser
-- role; see docs/security/multi-tenancy.md and the RLS spec's APP_ROLE.)
ALTER TABLE "user_role_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_role_assignments" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "user_role_assignments"
    USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
