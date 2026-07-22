-- DEV ONLY. A representative slice of the old localStorage demo data.
-- Never run against the production project once real data exists.
insert into gardens (id, name, address, sqft, qr_token) values
  ('11111111-1111-1111-1111-111111111101', 'Millbrook Community Garden', '847 Oak St, Altoona PA', 1200, 'mcg-millbrook'),
  ('11111111-1111-1111-1111-111111111102', 'Juniata Valley Meadow Restoration', 'Rt 22, Huntingdon PA', 3400, 'jvmr-juniata');

insert into volunteers (id, name, phone, email, skills, availability, status, joined_at) values
  ('22222222-2222-2222-2222-222222222201', 'Sarah Mitchell', '(814) 555-0201', 'sarah.m@email.com', '["planting","watering"]', 'Available weekends', 'active', '2025-06-01'),
  ('22222222-2222-2222-2222-222222222202', 'Bob Kowalski', '(814) 555-0212', 'bob.k@email.com', '["pruning","heavy_labor"]', 'Saturdays only', 'active', '2025-07-15');

insert into tasks (garden_id, title, cadence_days, est_minutes, owner, volunteer_id, volunteer_name, skill_level, active, last_completed, next_due) values
  ('11111111-1111-1111-1111-111111111101', 'Water raised beds', 3, 45, 'volunteer', '22222222-2222-2222-2222-222222222201', 'Sarah Mitchell', 'none', true, now() - interval '2 days', now() + interval '1 day'),
  ('11111111-1111-1111-1111-111111111101', 'Weed main paths', 14, 90, 'open', null, null, 'none', true, now() - interval '10 days', now() + interval '4 days'),
  ('11111111-1111-1111-1111-111111111102', 'Mow paths', 21, 90, 'jordan', null, null, 'none', true, now() - interval '15 days', now() + interval '6 days');

insert into walkins (garden_id, title, est_minutes, active) values
  ('11111111-1111-1111-1111-111111111101', 'Trash pickup', 15, true),
  ('11111111-1111-1111-1111-111111111101', 'Pull weeds anywhere', 30, true);

insert into clients (name, address, email, phone) values
  ('Robert & Carol Smith', '412 Pine Ridge Rd', 'rmsmith@email.com', '(814) 555-0192');
