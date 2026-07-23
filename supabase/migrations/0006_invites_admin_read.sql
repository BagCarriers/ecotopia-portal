-- Invite tokens must be admin-only: a regular user reading a pending admin
-- invite's token could accept it and escalate to admin.
drop policy pi_read on public.portal_invites;
create policy pi_read on public.portal_invites for select to authenticated using (public.is_portal_admin());
