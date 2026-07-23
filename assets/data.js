/**
 * Ecotopia Portal - DataStore (Supabase-backed).
 * Every data method returns a Promise and throws Error on failure.
 * Rows come back camelCase (EcoMapping); writes accept camelCase.
 * submit* methods use return=minimal inserts so anon RLS (no select) works.
 */
const DataStore = (() => {
  const sb = window.ecoSupabase;
  const { toDb, fromDb, fromDbAll } = globalThis.EcoMapping;

  function unwrap({ data, error }) {
    if (error) throw new Error(error.message);
    return data;
  }

  async function list(table, orderCol = 'created_at') {
    return fromDbAll(unwrap(await sb.from(table).select('*').order(orderCol, { ascending: true })));
  }
  async function getOne(table, id) {
    if (!id) return null;
    const row = unwrap(await sb.from(table).select('*').eq('id', id).maybeSingle());
    return row ? fromDb(row) : null;
  }
  async function insert(table, record) {
    return fromDb(unwrap(await sb.from(table).insert(toDb(record)).select().single()));
  }
  // Anon-safe insert: no RETURNING, so no select policy is needed.
  async function submit(table, record) {
    unwrap(await sb.from(table).insert(toDb(record)));
    return record;
  }
  async function update(table, id, changes) {
    return fromDb(unwrap(await sb.from(table).update(toDb(changes)).eq('id', id).select().single()));
  }

  const api = {
    // Gardens
    getGardens: () => list('gardens'),
    getGarden: (id) => getOne('gardens', id),
    getGardenByToken: async (token) => {
      const row = unwrap(await sb.from('gardens').select('*').eq('qr_token', token).maybeSingle());
      return row ? fromDb(row) : null;
    },
    addGarden: (r) => insert('gardens', r),
    updateGarden: (id, ch) => update('gardens', id, ch),

    // Clients
    getClients: () => list('clients'),
    getClient: (id) => getOne('clients', id),
    addClient: (r) => insert('clients', r),
    updateClient: (id, ch) => update('clients', id, ch),

    // Jobs
    getJobs: () => list('jobs'),
    getJob: (id) => getOne('jobs', id),
    addJob: (r) => insert('jobs', r),
    submitInquiryJob: (r) => submit('jobs', { ...r, status: 'inquiry' }), // public intake path
    updateJob: (id, ch) => update('jobs', id, ch),
    addJobNote: async (id, note) => {
      const job = await getOne('jobs', id);
      if (!job) return null;
      const log = job.activityLog || [];
      log.push({ ts: new Date().toISOString(), note });
      return update('jobs', id, { activityLog: log });
    },

    // Volunteers
    getVolunteers: () => list('volunteers'),
    getVolunteer: (id) => getOne('volunteers', id),
    addVolunteer: (r) => insert('volunteers', r),
    updateVolunteer: (id, ch) => update('volunteers', id, ch),
    // Kiosk (anon): names only + phone matching + task completion via RPC
    getVolunteersPublic: async () =>
      fromDbAll(unwrap(await sb.from('volunteers_public').select('*').order('name'))),
    matchVolunteerByPhone: async (phone) => {
      const rows = unwrap(await sb.rpc('match_volunteer_by_phone', { p_phone: phone }));
      return rows && rows.length ? fromDb(rows[0]) : null;
    },
    completeTask: async (taskId) => { unwrap(await sb.rpc('complete_task', { p_task_id: taskId })); },

    // Tasks
    getTasks: () => list('tasks'),
    getTask: (id) => getOne('tasks', id),
    getTasksByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('tasks').select('*').eq('garden_id', gId))),
    getTasksByVolunteer: async (vId) =>
      fromDbAll(unwrap(await sb.from('tasks').select('*').eq('volunteer_id', vId))),
    getJordanTasks: async () =>
      fromDbAll(unwrap(await sb.from('tasks').select('*').eq('owner', 'jordan'))),
    getOpenTasks: async () =>
      fromDbAll(unwrap(await sb.from('tasks').select('*').eq('owner', 'open'))),
    addTask: (r) => insert('tasks', r),
    updateTask: (id, ch) => update('tasks', id, ch),
    claimTask: (taskId, volunteerId, volunteerName) =>
      update('tasks', taskId, { owner: 'volunteer', volunteerId, volunteerName }),

    // Walk-ins
    getWalkins: () => list('walkins'),
    getWalkinsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('walkins').select('*').eq('garden_id', gId).eq('active', true))),
    addWalkin: (r) => insert('walkins', r),
    updateWalkin: (id, ch) => update('walkins', id, ch),

    // Check-ins
    getCheckins: () => list('checkins'),
    getCheckinsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('checkins').select('*').eq('garden_id', gId))),
    getCheckinsByVolunteer: async (vId) =>
      fromDbAll(unwrap(await sb.from('checkins').select('*').eq('volunteer_id', vId))),
    addCheckin: (r) => submit('checkins', r), // submit: kiosk runs as anon
    getRecentCheckins: async (n = 5) =>
      fromDbAll(unwrap(await sb.from('checkins').select('*')
        .order('check_in_time', { ascending: false }).limit(n))),
    getHoursLast30: async (volunteerId) => {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const rows = unwrap(await sb.from('checkins').select('hours_logged')
        .eq('volunteer_id', volunteerId).gte('check_in_time', cutoff));
      return (rows || []).reduce((sum, c) => sum + (Number(c.hours_logged) || 0), 0);
    },

    // Events
    getEvents: () => list('events'),
    getEvent: (id) => getOne('events', id),
    addEvent: (r) => insert('events', r),
    updateEvent: (id, ch) => update('events', id, ch),
    signupForEvent: async (eventId, name) => {
      const ev = await getOne('events', eventId);
      if (!ev) return null;
      const signups = ev.signups || [];
      if (!signups.includes(name)) signups.push(name);
      return update('events', eventId, { signups });
    },
    getUpcomingEvents: async () => {
      const today = new Date().toISOString().slice(0, 10);
      return fromDbAll(unwrap(await sb.from('events').select('*')
        .gte('date', today).order('date', { ascending: true })));
    },

    // Invoices
    getInvoices: () => list('invoices'),
    getInvoice: (id) => getOne('invoices', id),
    addInvoice: (r) => insert('invoices', r),
    updateInvoice: (id, ch) => update('invoices', id, ch),
    markInvoicePaid: (id) =>
      update('invoices', id, { status: 'paid', paidDate: new Date().toISOString().slice(0, 10) }),
    getUnpaidInvoices: async () =>
      fromDbAll(unwrap(await sb.from('invoices').select('*').neq('status', 'paid'))),

    // Grants
    getGrants: () => list('grants'),
    getGrant: (id) => getOne('grants', id),
    addGrant: (r) => insert('grants', r),
    updateGrant: (id, ch) => update('grants', id, ch),

    // Observations
    getObservations: () => list('observations'),
    getObservationsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('observations').select('*').eq('garden_id', gId))),
    addObservation: (r) => insert('observations', r),
    flagObservation: (id) => update('observations', id, { flagged: true }),

    // Public form submissions (anon inserts, return=minimal)
    addIntakeSubmission: (r) => submit('intake_submissions', r),
    getIntakeSubmissions: () => list('intake_submissions'),
    addVolunteerApplication: (r) => submit('volunteer_applications', r),
    getVolunteerApplications: () => list('volunteer_applications'),

    // Sync utilities (unchanged from the demo version)
    esc(v) {
      if (v == null) return '';
      return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    formatDate(isoStr) {
      if (!isoStr) return '-';
      const d = new Date(isoStr);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },
    formatTime(isoStr) {
      if (!isoStr) return '-';
      const d = new Date(isoStr);
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    },
    daysUntil(isoStr) {
      if (!isoStr) return null;
      const diff = new Date(isoStr).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
      return Math.round(diff / 86400000);
    },
  };

  return api;
})();
