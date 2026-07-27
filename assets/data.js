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

    // Quotes (staff only - no anon policy). Each quote stores subtotal, admin_fee
    // (5 percent, collected by BagCarriers), and total. adminFeesTotal excludes drafts.
    getQuotes: async () =>
      fromDbAll(unwrap(await sb.from('quotes').select('*')
        .order('quote_year', { ascending: false })
        .order('quote_number', { ascending: false }))),
    getQuote: (id) => getOne('quotes', id),
    addQuote: (r) => insert('quotes', r),
    updateQuote: (id, ch) => update('quotes', id, ch),
    deleteQuote: async (id) => { unwrap(await sb.from('quotes').delete().eq('id', id)); },
    nextQuoteNumber: async (year) => {
      const rows = unwrap(await sb.from('quotes').select('quote_number')
        .eq('quote_year', year).order('quote_number', { ascending: false }).limit(1));
      return (rows && rows.length) ? Number(rows[0].quote_number) + 1 : 1;
    },
    adminFeesTotal: async (year) => {
      const rows = unwrap(await sb.from('quotes').select('admin_fee')
        .eq('quote_year', year).in('status', ['sent', 'accepted', 'invoiced']));
      return (rows || []).reduce((sum, q) => sum + (Number(q.admin_fee) || 0), 0);
    },

    // Grants
    getGrants: () => list('grants'),
    getGrant: (id) => getOne('grants', id),
    addGrant: (r) => insert('grants', r),
    updateGrant: (id, ch) => update('grants', id, ch),

    // Grant finder (auto-discovered opportunities; staff triage). Query stays
    // simple; grant-finder.html orders client-side (new first, then close_date
    // ascending nulls last).
    getGrantOpportunities: () => list('grant_opportunities'),
    updateGrantOpportunity: (id, ch) => update('grant_opportunities', id, ch),

    // Observations
    getObservations: () => list('observations'),
    getObservationsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('observations').select('*').eq('garden_id', gId))),
    addObservation: (r) => insert('observations', r),
    flagObservation: (id) => update('observations', id, { flagged: true }),

    // Gallery (staff library + volunteer submissions)
    getGalleryPhotos: async () =>
      fromDbAll(unwrap(await sb.from('gallery_photos').select('*')
        .order('created_at', { ascending: false }))),
    addGalleryPhoto: (r) => insert('gallery_photos', r), // staff path
    submitGalleryPhoto: (r) => submit('gallery_photos', { ...r, source: 'volunteer' }), // anon
    updateGalleryPhoto: (id, ch) => update('gallery_photos', id, ch),
    deleteGalleryPhoto: async (id, storagePath) => {
      // Remove the storage object first, then the row. A missing object is fine
      // (already gone): ignore any storage error so the row still gets deleted.
      if (storagePath) {
        try { await sb.storage.from('gallery').remove([storagePath]); } catch (e) { /* ignore */ }
      }
      unwrap(await sb.from('gallery_photos').delete().eq('id', id));
    },
    galleryPublicUrl: (storagePath) =>
      sb.storage.from('gallery').getPublicUrl(storagePath).data.publicUrl, // sync

    // Service lead-gen settings + waitlist (staff)
    getServiceSettings: () => list('service_settings', 'name'),
    updateServiceSetting: async (slug, ch) =>
      fromDb(unwrap(await sb.from('service_settings').update(toDb(ch)).eq('slug', slug).select().single())),
    getWaitlist: async () =>
      fromDbAll(unwrap(await sb.from('service_waitlist').select('*')
        .order('created_at', { ascending: false }))),
    getWaitlistByService: async (slug) =>
      fromDbAll(unwrap(await sb.from('service_waitlist').select('*')
        .eq('service_slug', slug).order('created_at', { ascending: false }))),
    deleteWaitlistEntry: async (id) => {
      unwrap(await sb.from('service_waitlist').delete().eq('id', id));
    },

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
    // Client-side downscale, shared by gallery.html + qr-checkin.html. Browser
    // only: needs createImageBitmap + canvas (NOT available in Node). Returns a
    // JPEG Blob (q0.85) no larger than maxDim on its long edge. GIFs (may be
    // animated) and images already within maxDim on both axes pass through as-is.
    async resizeImage(file, maxDim = 1600) {
      if (!file || file.type === 'image/gif') return file;
      let bitmap;
      try {
        // from-image: apply EXIF orientation so phone portraits are not stored sideways
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) {
        return file; // decode failed: fall back to the original file
      }
      const w0 = bitmap.width, h0 = bitmap.height;
      if (w0 <= maxDim && h0 <= maxDim) {
        if (bitmap.close) bitmap.close();
        return file;
      }
      const scale = maxDim / Math.max(w0, h0);
      const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      if (bitmap.close) bitmap.close();
      return await new Promise((resolve) =>
        canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.85));
    },
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
