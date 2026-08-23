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
    // Public quote acceptance (anon-safe, token-gated RPCs; no anon table policy on
    // quotes). getQuoteByToken resolves only sent/accepted/invoiced quotes (never
    // drafts) and returns null for a missing/short/unknown token. acceptQuote flips a
    // still-'sent' quote to 'accepted' and returns true only when THIS call did it (a
    // second call returns false). Used by the public quote-view.html page.
    getQuoteByToken: async (token) => {
      const rows = unwrap(await sb.rpc('get_quote_by_token', { p_token: token }));
      return rows && rows.length ? fromDb(rows[0]) : null;
    },
    acceptQuote: async (token, name) =>
      unwrap(await sb.rpc('accept_quote', { p_token: token, p_name: name })),

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
    // Event photos live in the same public gallery bucket under events/.
    eventPhotoUrl: (photoPath) =>
      sb.storage.from('gallery').getPublicUrl(photoPath).data.publicUrl, // sync

    // Service lead-gen settings + waitlist (staff)
    getServiceSettings: () => list('service_settings', 'name'),
    updateServiceSetting: async (slug, ch) =>
      fromDb(unwrap(await sb.from('service_settings').update(toDb(ch)).eq('slug', slug).select().single())),
    // Plant size seasons (staff switch; anon-readable so plants.html can render
    // only the sizes that are open). Keyed by size_key ('plug' / 'gallon'), not id.
    getPlantSizeSettings: () => list('plant_size_settings', 'sort'),
    updatePlantSizeSetting: async (sizeKey, ch) =>
      fromDb(unwrap(await sb.from('plant_size_settings').update(toDb(ch))
        .eq('size_key', sizeKey).select().single())),

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

    // Planting-site suggestions (anon public form -> staff review). Anon inserts
    // use return=minimal (submit) so no anon select policy is needed; reads,
    // status updates, and deletes are staff-only (authenticated + is_portal_user).
    submitPlantingSuggestion: (r) => submit('planting_suggestions', r),
    getPlantingSuggestions: async () =>
      fromDbAll(unwrap(await sb.from('planting_suggestions').select('*')
        .order('created_at', { ascending: false }))),
    getPlantingSuggestionsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('planting_suggestions').select('*')
        .eq('garden_id', gId).order('created_at', { ascending: false }))),
    updatePlantingSuggestion: (id, ch) => update('planting_suggestions', id, ch),
    deletePlantingSuggestion: async (id) => {
      unwrap(await sb.from('planting_suggestions').delete().eq('id', id));
    },

    // Planting records: what the team actually put in the ground. Distinct from
    // planting_suggestions above, which is the public "suggest a site" form.
    // species_label is always written, even when a catalogue species is chosen, so
    // the record survives that species being deleted from the shop.
    //
    // planted_on is a date, not a timestamp, and the team plants in batches, so a
    // whole planting day shares one value and ties are the common case, not an edge.
    // created_at breaks the tie so two loads cannot return the same day's rows in a
    // different order. It matters more than cosmetics: the moment anything here
    // grows a .limit() or .range(), an unstable sort makes rows repeat on one page
    // and vanish from another.
    getPlantingsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('garden_plantings').select('*')
        .eq('garden_id', gId).order('planted_on', { ascending: false })
        .order('created_at', { ascending: false }))),
    getAllPlantings: async () =>
      fromDbAll(unwrap(await sb.from('garden_plantings').select('*')
        .order('planted_on', { ascending: false })
        .order('created_at', { ascending: false }))),
    addPlanting: (r) => insert('garden_plantings', r),
    updatePlanting: (id, ch) => update('garden_plantings', id, ch),
    deletePlanting: async (id) => {
      unwrap(await sb.from('garden_plantings').delete().eq('id', id));
    },

    // Plant catalog (staff-editable species + habitat kits). The public
    // plants.html reads active rows directly over anon (RLS scopes it); these
    // staff methods use the authenticated policy, which returns inactive rows
    // too, so the portal can manage hidden entries. Photo uploads land in the
    // gallery bucket under plants/<uuid>.jpg; 'static:<file>' photo_paths are
    // repo assets (assets/img/plants/) and are never touched in storage.
    getPlantSpecies: async () =>
      fromDbAll(unwrap(await sb.from('plant_species').select('*')
        .order('sort', { ascending: true }).order('common', { ascending: true }))),
    addPlantSpecies: (r) => insert('plant_species', r),
    updatePlantSpecies: (id, ch) => update('plant_species', id, ch),
    deletePlantSpecies: async (id, photoPath) => {
      if (photoPath && String(photoPath).slice(0, 7) !== 'static:') {
        try { await sb.storage.from('gallery').remove([photoPath]); } catch (e) { /* ignore */ }
      }
      unwrap(await sb.from('plant_species').delete().eq('id', id));
    },
    // iNaturalist enrichment. Approving keeps the photo and marks it reviewed.
    // Rejecting removes the stored object, clears photo_path so the card falls
    // back to no image, and keeps inat_photo_id so the sync never proposes that
    // same photo again (canAutoFill refuses any row carrying one).
    approveInatPhoto: (id) => update('plant_species', id, { inat_photo_status: 'approved' }),
    rejectInatPhoto: async (id, photoPath) => {
      // Row first, object second. If the delete fails we leak one orphan object,
      // which is harmless. The reverse order leaves a live plant card pointing at
      // an object that no longer exists, because plants.html reads the row over
      // anon and renders photo_path immediately. Same reasoning as the photo pass
      // in supabase/functions/inat-sync/index.ts.
      const row = await update('plant_species', id,
        { photo_path: null, inat_photo_status: 'rejected' });
      if (photoPath && String(photoPath).slice(0, 7) !== 'static:') {
        try { await sb.storage.from('gallery').remove([photoPath]); } catch (e) { /* ignore */ }
      }
      return row;
    },
    // A hand-entered taxon id is permanent: the sync never revisits a 'manual' row.
    // resolveAndEnrich selects on .is('inat_taxon_id', null), so a row that has one
    // is out of the pass entirely and will not be re-enriched from the new taxon.
    //
    // That is why the badge columns are cleared here. On a 'fuzzy' row the staff
    // member is overriding a match the system got wrong, and inat_matched_name,
    // inat_establishment and inat_conservation all describe the taxon they just
    // rejected. Left in place, inatBadges() would show "PA native" or a
    // conservation rank derived from a taxon a human explicitly said was
    // incorrect. No badge is honest; a badge from the wrong plant is not.
    setInatTaxon: (id, taxonId) =>
      update('plant_species', id, {
        inat_taxon_id: taxonId,
        inat_match: 'manual',
        inat_matched_name: null,
        inat_establishment: null,
        inat_conservation: null,
      }),
    getPlantKits: async () =>
      fromDbAll(unwrap(await sb.from('plant_kits').select('*')
        .order('sort', { ascending: true }).order('name', { ascending: true }))),
    addPlantKit: (r) => insert('plant_kits', r),
    updatePlantKit: (id, ch) => update('plant_kits', id, ch),
    deletePlantKit: async (id, photoPath) => {
      if (photoPath && String(photoPath).slice(0, 7) !== 'static:') {
        try { await sb.storage.from('gallery').remove([photoPath]); } catch (e) { /* ignore */ }
      }
      unwrap(await sb.from('plant_kits').delete().eq('id', id));
    },
    // Public URL for a gallery-bucket plant photo (NOT the 'static:' repo-asset
    // form, which resolves to a local path without touching storage).
    plantPhotoUrl: (photoPath) =>
      sb.storage.from('gallery').getPublicUrl(photoPath).data.publicUrl, // sync
    // Same lookup, honestly named for callers that are not plants. The bucket is
    // shared, so this is an alias rather than a second implementation.
    galleryPhotoUrl: (photoPath) =>
      sb.storage.from('gallery').getPublicUrl(photoPath).data.publicUrl, // sync

    // Team members (staff-editable, rendered on the public about page). Public
    // listing only: a row here grants no portal access. The anon read policy is
    // itself scoped to active rows (migration 0032), so hiding a member takes them
    // out of anon reads entirely, not just out of the rendered grid: the
    // .eq('active', true) below is a second guard rather than the only one. Staff
    // methods use the authenticated policy, which returns hidden rows too, so the
    // portal can manage them. Uploads land in the gallery bucket under
    // team/<uuid>.jpg; 'static:<file>' paths are repo assets, never touched in
    // storage. Both listings order by sort then name: sort has no unique
    // constraint and defaults to 0, so name is what keeps ties stable.
    getTeamMembers: async () =>
      fromDbAll(unwrap(await sb.from('team_members').select('*')
        .order('sort', { ascending: true }).order('name', { ascending: true }))),
    getPublicTeam: async () =>
      fromDbAll(unwrap(await sb.from('team_members').select('*')
        .eq('active', true)
        .order('sort', { ascending: true }).order('name', { ascending: true }))),
    addTeamMember: (r) => insert('team_members', r),
    updateTeamMember: (id, ch) => update('team_members', id, ch),
    removeTeamMember: async (id) => {
      unwrap(await sb.from('team_members').delete().eq('id', id));
    },
    teamPhotoUrl: (photoPath) =>
      sb.storage.from('gallery').getPublicUrl(photoPath).data.publicUrl, // sync

    // Public questions (anon "Ask us anything" -> staff inbox). Anon inserts use
    // return=minimal (submit) so no anon select policy is needed; reads, answers,
    // status updates, and deletes are staff-only (authenticated + is_portal_user).
    // Status flow: new -> answered / published / dismissed. 'published' is reserved
    // for a future public Q&A (there is no public read policy yet).
    submitQuestion: (r) => submit('questions', r),
    getQuestions: async () =>
      fromDbAll(unwrap(await sb.from('questions').select('*')
        .order('created_at', { ascending: false }))),
    updateQuestion: (id, ch) => update('questions', id, ch),
    deleteQuestion: async (id) => {
      unwrap(await sb.from('questions').delete().eq('id', id));
    },

    // Merch catalog (non-plant shop items). The public shop.html reads active rows
    // directly over anon (RLS scopes it); these staff methods use the authenticated
    // policy, which returns inactive rows too, so the portal can manage hidden items.
    // Photo uploads land in the gallery bucket under shop/<uuid>.jpg; 'static:<path>'
    // photo_paths are repo assets (assets/img/) and are never touched in storage.
    getMerchItems: async () =>
      fromDbAll(unwrap(await sb.from('merch_items').select('*')
        .order('sort', { ascending: true }).order('name', { ascending: true }))),
    addMerchItem: (r) => insert('merch_items', r),
    updateMerchItem: (id, ch) => update('merch_items', id, ch),
    deleteMerchItem: async (id, photoPath) => {
      if (photoPath && String(photoPath).slice(0, 7) !== 'static:') {
        try { await sb.storage.from('gallery').remove([photoPath]); } catch (e) { /* ignore */ }
      }
      unwrap(await sb.from('merch_items').delete().eq('id', id));
    },
    // Public URL for a gallery-bucket merch photo (NOT the 'static:' repo-asset form,
    // which resolves to a local path without touching storage).
    merchPhotoUrl: (photoPath) =>
      sb.storage.from('gallery').getPublicUrl(photoPath).data.publicUrl, // sync

    // First-party reviews (anon "Leave a review" -> staff moderation -> approved
    // shown publicly). No Google Business Profile, so the site collects its own.
    // Anon inserts use return=minimal (submit) so no anon select policy is needed
    // for writes; the anon read policy scopes public reads to approved rows only.
    // Reads (all statuses), approve/dismiss, and deletes are staff-only
    // (authenticated + is_portal_user). Status flow: pending -> approved / dismissed.
    submitReview: (r) => submit('reviews', { ...r, status: 'pending' }),
    getReviews: async () =>
      fromDbAll(unwrap(await sb.from('reviews').select('*')
        .order('created_at', { ascending: false }))),
    updateReview: (id, ch) => update('reviews', id, ch),
    deleteReview: async (id) => {
      unwrap(await sb.from('reviews').delete().eq('id', id));
    },

    // Orders (Supabase-owned; Square only ever sees a computed total). The public
    // plants/shop pages create orders through the square-pay edge function (server-side
    // validation + pricing); these staff methods read and progress them. Staff RLS
    // (authenticated + is_portal_user) allows full CRUD. "Mark paid" is NOT a plain
    // update: it must also decrement tracked stock (service-role only), so it goes
    // through the square-pay `staff_mark_paid` action, not this DataStore.
    getOrders: async () =>
      fromDbAll(unwrap(await sb.from('orders').select('*')
        .order('created_at', { ascending: false }))),
    updateOrder: (id, ch) => update('orders', id, ch),

    // Sync utilities (unchanged from the demo version)
    esc(v) {
      if (v == null) return '';
      return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    // Parse a staff-entered Google My Maps value into a bare mid. Accepts either
    // a bare mid or any URL/string containing mid=<value> (extracted by regex).
    // Returns { mid } (null for empty input) or { error } with a message when the
    // input looks like a link but has no mid, or the mid fails the charset guard.
    // Charset MUST match the public renderer's guard (/^[A-Za-z0-9_-]+$/): map_mid
    // is rendered into an iframe src, so a value that would break out is refused.
    parseMapMid(raw) {
      const s = (raw == null ? '' : String(raw)).trim();
      if (!s) return { mid: null };
      const m = s.match(/[?&]mid=([^&#\s]+)/);
      let mid = m ? decodeURIComponent(m[1]).trim() : s;
      const looksLikeLink = /^https?:\/\//i.test(s) || s.indexOf('/') !== -1;
      if (!m && looksLikeLink) {
        return { error: 'That looks like a link but has no mid= value. Paste the full Google My Maps share link, or just the map ID.' };
      }
      if (!/^[A-Za-z0-9_-]+$/.test(mid)) {
        return { error: 'The map ID should contain only letters, numbers, hyphens, and underscores.' };
      }
      return { mid };
    },
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
