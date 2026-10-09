-- The organization_id column on user_role_assignments was never given a
-- foreign key: nothing stopped an assignment from naming an organization that
-- does not exist, or an organization from being deleted while assignments
-- still referenced it — the dangling-access-record case the Restrict policy
-- on the user relation was written to prevent.
--
-- Restrict (not Cascade), deliberately: assignments are audit-relevant access
-- records. They are revoked explicitly when an org is decommissioned, never
-- as a side effect of deleting the org — same reasoning as the user relation.
--
-- Ordering check against existing rows: run this BEFORE the ALTER. Any rows
-- returned are orphans that must be cleaned up first; otherwise the
-- constraint creation fails and the migration with it.
--   SELECT ura.id, ura.organization_id
--     FROM user_role_assignments ura
--     LEFT JOIN organizations o ON o.id = ura.organization_id
--    WHERE o.id IS NULL;
ALTER TABLE "user_role_assignments"
  ADD CONSTRAINT "user_role_assignments_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
