-- google_calendar_ics_url is a bearer credential; only admins may read it.
-- Other settings (calendar_feed_token) stay readable by all active staff.
drop policy ps_read on public.portal_settings;
create policy ps_read on public.portal_settings for select to authenticated
  using (public.is_portal_user() and (key <> 'google_calendar_ics_url' or public.is_portal_admin()));
