/**
 * Ecotopia Portal — DataStore
 * All demo data + localStorage CRUD for every entity.
 */
const DataStore = (() => {
  const KEYS = {
    gardens: 'eco_gardens',
    clients: 'eco_clients',
    jobs: 'eco_jobs',
    volunteers: 'eco_volunteers',
    tasks: 'eco_tasks',
    walkins: 'eco_walkins',
    checkins: 'eco_checkins',
    events: 'eco_events',
    invoices: 'eco_invoices',
    grants: 'eco_grants',
    observations: 'eco_observations',
    intake_submissions: 'eco_intake_submissions',
    volunteer_applications: 'eco_volunteer_applications',
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function load(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || null;
    } catch (e) { return null; }
  }

  function save(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
  }

  function getAll(key) {
    return load(key) || [];
  }

  function setAll(key, arr) {
    save(key, arr);
  }

  function getById(key, id) {
    return getAll(key).find(r => r.id === id) || null;
  }

  function insert(key, record) {
    const all = getAll(key);
    const newRecord = { id: uid(), createdAt: new Date().toISOString(), ...record };
    all.push(newRecord);
    setAll(key, all);
    return newRecord;
  }

  function update(key, id, changes) {
    const all = getAll(key);
    const idx = all.findIndex(r => r.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...changes, updatedAt: new Date().toISOString() };
    setAll(key, all);
    return all[idx];
  }

  function remove(key, id) {
    const all = getAll(key).filter(r => r.id !== id);
    setAll(key, all);
  }

  // ── Seed data ───────────────────────────────────────────────────────────────
  function seedAll() {
    // Only seed once — check if gardens already exist
    if (load(KEYS.gardens)) return;

    // ── Gardens ────────────────────────────────────────────────────────────
    const gardens = [
      {
        id: 'g1', name: 'Millbrook Community Garden',
        address: '847 Oak St, Altoona PA', sqft: 1200,
        qrToken: 'mcg-millbrook', createdAt: '2024-03-01T00:00:00Z'
      },
      {
        id: 'g2', name: 'Juniata Valley Meadow Restoration',
        address: 'Rt 22, Huntingdon PA', sqft: 3400,
        qrToken: 'jvmr-juniata', createdAt: '2024-04-15T00:00:00Z'
      },
      {
        id: 'g3', name: 'Blair Food Forest',
        address: '200 Chestnut Ave, Altoona PA', sqft: 950,
        qrToken: 'bff-blair', createdAt: '2024-05-20T00:00:00Z'
      }
    ];
    setAll(KEYS.gardens, gardens);

    // ── Clients ────────────────────────────────────────────────────────────
    const clients = [
      {
        id: 'c1', name: 'Robert & Carol Smith',
        address: '412 Pine Ridge Rd', email: 'rmsmith@email.com',
        phone: '(814) 555-0192', createdAt: '2025-01-10T00:00:00Z'
      },
      {
        id: 'c2', name: 'Dave Johnson',
        address: '88 Walnut Dr', email: 'djohnson@email.com',
        phone: '(814) 555-0147', createdAt: '2025-02-14T00:00:00Z'
      },
      {
        id: 'c3', name: 'Peters Family',
        address: '304 Creek Rd', email: 'cpeters@email.com',
        phone: '(814) 555-0183', createdAt: '2025-03-05T00:00:00Z'
      },
      {
        id: 'c4', name: 'Williams Estate',
        address: '1200 Country Club Rd', email: 'mwilliams@email.com',
        phone: '(814) 555-0168', createdAt: '2025-03-22T00:00:00Z'
      }
    ];
    setAll(KEYS.clients, clients);

    // ── Jobs ───────────────────────────────────────────────────────────────
    const jobs = [
      {
        id: 'j1', clientId: 'c1', clientName: 'Robert & Carol Smith',
        title: 'Lawn to Meadow Conversion', address: '412 Pine Ridge Rd',
        type: 'meadow_conversion', status: 'active', sqft: '1.2 acres',
        price: null, grantFunded: true, grantName: 'DCNR Lawn-to-Meadow',
        grantAmount: 2400,
        notes: 'DCNR approved. Planting starts June 3.',
        activityLog: [
          { ts: '2026-04-10T10:00:00Z', note: 'Grant approved by DCNR.' },
          { ts: '2026-05-01T09:00:00Z', note: 'Site prep complete. Seeds ordered.' }
        ],
        createdAt: '2026-04-01T00:00:00Z'
      },
      {
        id: 'j2', clientId: 'c2', clientName: 'Dave Johnson',
        title: 'Rain Garden Design', address: '88 Walnut Dr',
        type: 'rain_garden', status: 'proposal', sqft: '640 sqft',
        price: 320, grantFunded: false, grantName: null, grantAmount: null,
        notes: 'Proposal sent 5/15. Awaiting response.',
        activityLog: [
          { ts: '2026-05-15T11:00:00Z', note: 'Proposal emailed to client.' }
        ],
        createdAt: '2026-05-10T00:00:00Z'
      },
      {
        id: 'j3', clientId: 'c3', clientName: 'Peters Family',
        title: 'Ecological Landscaping', address: '304 Creek Rd',
        type: 'ecological_landscaping', status: 'active', sqft: '480 sqft',
        price: 850, grantFunded: false, grantName: null, grantAmount: null,
        notes: 'Design complete. Install scheduled for June 10.',
        activityLog: [
          { ts: '2026-04-20T09:00:00Z', note: 'Design approved by client.' },
          { ts: '2026-05-02T10:00:00Z', note: 'Materials ordered.' }
        ],
        createdAt: '2026-04-15T00:00:00Z'
      },
      {
        id: 'j4', clientId: 'c4', clientName: 'Williams Estate',
        title: 'Invasive Species Removal', address: '1200 Country Club Rd',
        type: 'invasive_removal', status: 'site_visit', sqft: '~800 sqft',
        price: null, grantFunded: false, grantName: null, grantAmount: null,
        notes: 'Site visit scheduled June 2.',
        activityLog: [
          { ts: '2026-05-12T14:00:00Z', note: 'Initial call with client. Site visit booked for June 2.' }
        ],
        createdAt: '2026-05-12T00:00:00Z'
      },
      {
        id: 'j5', clientId: null, clientName: 'New Inquiry',
        title: 'Medicinal Herb Garden', address: '',
        type: 'herb_garden', status: 'inquiry', sqft: '',
        price: null, grantFunded: false, grantName: null, grantAmount: null,
        notes: 'Submitted via intake form. Follow up needed.',
        activityLog: [
          { ts: '2026-05-17T08:30:00Z', note: 'Received via intake form on website.' }
        ],
        createdAt: '2026-05-17T00:00:00Z'
      }
    ];
    setAll(KEYS.jobs, jobs);

    // ── Volunteers ─────────────────────────────────────────────────────────
    const volunteers = [
      {
        id: 'v1', name: 'Sarah Mitchell', phone: '(814) 555-0201',
        email: 'sarah.m@email.com', skills: ['planting', 'watering', 'inspection'],
        availability: 'Available weekends', status: 'active',
        joinedAt: '2025-06-01T00:00:00Z', createdAt: '2025-06-01T00:00:00Z'
      },
      {
        id: 'v2', name: 'Bob Kowalski', phone: '(814) 555-0212',
        email: 'bob.k@email.com', skills: ['pruning', 'heavy_labor', 'planting'],
        availability: 'Saturdays only', status: 'active',
        joinedAt: '2025-07-15T00:00:00Z', createdAt: '2025-07-15T00:00:00Z'
      },
      {
        id: 'v3', name: 'Maria Chen', phone: '(814) 555-0223',
        email: 'maria.c@email.com', skills: ['inspection', 'events', 'weeding'],
        availability: 'Flexible schedule', status: 'active',
        joinedAt: '2025-08-01T00:00:00Z', createdAt: '2025-08-01T00:00:00Z'
      },
      {
        id: 'v4', name: 'Tom Graziano', phone: '(814) 555-0234',
        email: 'tom.g@email.com', skills: ['weeding', 'general', 'heavy_labor'],
        availability: 'Weekday afternoons', status: 'active',
        joinedAt: '2025-09-10T00:00:00Z', createdAt: '2025-09-10T00:00:00Z'
      },
      {
        id: 'v5', name: 'Dave Patterson', phone: '(814) 555-0245',
        email: 'd.patterson@email.com', skills: ['watering', 'general'],
        availability: 'Irregular availability', status: 'active',
        joinedAt: '2025-10-05T00:00:00Z', createdAt: '2025-10-05T00:00:00Z'
      },
      {
        id: 'v6', name: 'Lisa Hern', phone: '(814) 555-0256',
        email: 'lisa.h@email.com', skills: ['events', 'planting', 'harvest'],
        availability: 'Weekends + events', status: 'active',
        joinedAt: '2025-11-01T00:00:00Z', createdAt: '2025-11-01T00:00:00Z'
      }
    ];
    setAll(KEYS.volunteers, volunteers);

    // ── Tasks ──────────────────────────────────────────────────────────────
    // cadence in days; owner: 'volunteer'|'jordan'|'open'
    const now = new Date();
    function nextDue(daysAgo, cadence) {
      const last = new Date(now.getTime() - daysAgo * 86400000);
      const next = new Date(last.getTime() + cadence * 86400000);
      return next.toISOString();
    }

    const tasks = [
      // Millbrook
      {
        id: 't1', gardenId: 'g1', title: 'Water raised beds',
        cadenceDays: 3, estMinutes: 45, owner: 'volunteer',
        volunteerId: 'v1', volunteerName: 'Sarah Mitchell',
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(3, 0), nextDue: nextDue(2, 3),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't2', gardenId: 'g1', title: 'Weed main paths',
        cadenceDays: 14, estMinutes: 90, owner: 'open',
        volunteerId: null, volunteerName: null,
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(10, 0), nextDue: nextDue(10, 14),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't3', gardenId: 'g1', title: 'Prune fruit trees',
        cadenceDays: 56, estMinutes: 120, owner: 'volunteer',
        volunteerId: 'v2', volunteerName: 'Bob Kowalski',
        skillLevel: 'experienced', active: true,
        lastCompleted: nextDue(20, 0), nextDue: nextDue(20, 56),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't4', gardenId: 'g1', title: 'Harvest + distribute produce',
        cadenceDays: 7, estMinutes: 60, owner: 'jordan',
        volunteerId: null, volunteerName: null,
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(5, 0), nextDue: nextDue(5, 7),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't5', gardenId: 'g1', title: 'Pest & disease inspection',
        cadenceDays: 14, estMinutes: 30, owner: 'volunteer',
        volunteerId: 'v3', volunteerName: 'Maria Chen',
        skillLevel: 'basic', active: true,
        lastCompleted: nextDue(12, 0), nextDue: nextDue(12, 14),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't6', gardenId: 'g1', title: 'Turn compost bins',
        cadenceDays: 30, estMinutes: 45, owner: 'open',
        volunteerId: null, volunteerName: null,
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(25, 0), nextDue: nextDue(25, 30),
        createdAt: '2025-01-01T00:00:00Z'
      },
      // Juniata
      {
        id: 't7', gardenId: 'g2', title: 'Invasive species patrol',
        cadenceDays: 30, estMinutes: 180, owner: 'jordan',
        volunteerId: null, volunteerName: null,
        skillLevel: 'experienced', active: true,
        lastCompleted: nextDue(20, 0), nextDue: nextDue(20, 30),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't8', gardenId: 'g2', title: 'Seeding bare patches',
        cadenceDays: 90, estMinutes: 120, owner: 'open',
        volunteerId: null, volunteerName: null,
        skillLevel: 'basic', active: true,
        lastCompleted: nextDue(60, 0), nextDue: nextDue(60, 90),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't9', gardenId: 'g2', title: 'Mow paths',
        cadenceDays: 21, estMinutes: 90, owner: 'volunteer',
        volunteerId: 'v4', volunteerName: 'Tom Graziano',
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(15, 0), nextDue: nextDue(15, 21),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't10', gardenId: 'g2', title: 'Photo documentation',
        cadenceDays: 30, estMinutes: 30, owner: 'volunteer',
        volunteerId: 'v3', volunteerName: 'Maria Chen',
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(22, 0), nextDue: nextDue(22, 30),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't11', gardenId: 'g2', title: 'Remove trash/debris',
        cadenceDays: 14, estMinutes: 45, owner: 'open',
        volunteerId: null, volunteerName: null,
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(8, 0), nextDue: nextDue(8, 14),
        createdAt: '2025-01-01T00:00:00Z'
      },
      // Blair
      {
        id: 't12', gardenId: 'g3', title: 'Water young trees',
        cadenceDays: 4, estMinutes: 60, owner: 'volunteer',
        volunteerId: 'v5', volunteerName: 'Dave Patterson',
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(3, 0), nextDue: nextDue(3, 4),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't13', gardenId: 'g3', title: 'Mulch tree circles',
        cadenceDays: 30, estMinutes: 120, owner: 'jordan',
        volunteerId: null, volunteerName: null,
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(18, 0), nextDue: nextDue(18, 30),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't14', gardenId: 'g3', title: 'Harvest + log yield',
        cadenceDays: 7, estMinutes: 45, owner: 'volunteer',
        volunteerId: 'v6', volunteerName: 'Lisa Hern',
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(4, 0), nextDue: nextDue(4, 7),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't15', gardenId: 'g3', title: 'Pest check',
        cadenceDays: 14, estMinutes: 30, owner: 'open',
        volunteerId: null, volunteerName: null,
        skillLevel: 'basic', active: true,
        lastCompleted: nextDue(11, 0), nextDue: nextDue(11, 14),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't16', gardenId: 'g3', title: 'Weed suppression',
        cadenceDays: 30, estMinutes: 120, owner: 'open',
        volunteerId: null, volunteerName: null,
        skillLevel: 'none', active: true,
        lastCompleted: nextDue(27, 0), nextDue: nextDue(27, 30),
        createdAt: '2025-01-01T00:00:00Z'
      },
      {
        id: 't17', gardenId: 'g3', title: 'Prune & train',
        cadenceDays: 42, estMinutes: 150, owner: 'jordan',
        volunteerId: null, volunteerName: null,
        skillLevel: 'experienced', active: true,
        lastCompleted: nextDue(30, 0), nextDue: nextDue(30, 42),
        createdAt: '2025-01-01T00:00:00Z'
      }
    ];
    setAll(KEYS.tasks, tasks);

    // ── Walk-in tasks ──────────────────────────────────────────────────────
    const walkins = [
      // Millbrook
      { id: 'w1', gardenId: 'g1', title: 'Trash pickup', estMinutes: 15, active: true },
      { id: 'w2', gardenId: 'g1', title: 'Plant inspection + notes', estMinutes: 20, active: true },
      { id: 'w3', gardenId: 'g1', title: 'Pull weeds anywhere', estMinutes: 30, active: true },
      { id: 'w4', gardenId: 'g1', title: 'Water if dry', estMinutes: 20, active: true },
      // Juniata
      { id: 'w5', gardenId: 'g2', title: 'Trash pickup', estMinutes: 15, active: true },
      { id: 'w6', gardenId: 'g2', title: 'Plant inspection + notes', estMinutes: 20, active: true },
      { id: 'w7', gardenId: 'g2', title: 'Pull weeds anywhere', estMinutes: 30, active: true },
      { id: 'w8', gardenId: 'g2', title: 'Water if dry', estMinutes: 20, active: true },
      // Blair
      { id: 'w9', gardenId: 'g3', title: 'Trash pickup', estMinutes: 15, active: true },
      { id: 'w10', gardenId: 'g3', title: 'Plant inspection + notes', estMinutes: 20, active: true },
      { id: 'w11', gardenId: 'g3', title: 'Pull weeds anywhere', estMinutes: 30, active: true },
      { id: 'w12', gardenId: 'g3', title: 'Water if dry', estMinutes: 20, active: true },
      { id: 'w13', gardenId: 'g3', title: 'Harvest ripe fruit/veg', estMinutes: 25, active: true }
    ];
    setAll(KEYS.walkins, walkins);

    // ── Events ─────────────────────────────────────────────────────────────
    const events = [
      {
        id: 'e1', title: 'Monthly Volunteer Workday',
        date: '2026-06-07', gardenId: 'g1', gardenName: 'Millbrook Community Garden',
        description: 'Monthly garden maintenance day. All skill levels welcome.',
        type: 'workday', openSignup: true, signups: ['Sarah Mitchell', 'Bob Kowalski', 'Lisa Hern'],
        createdAt: '2026-05-01T00:00:00Z'
      },
      {
        id: 'e2', title: 'Spring Native Plant Sale',
        date: '2026-05-30', gardenId: 'g3', gardenName: 'Blair Food Forest',
        description: 'Annual spring plant sale. Volunteers needed for setup, sales, and breakdown.',
        type: 'plant_sale', openSignup: true, signups: ['Lisa Hern', 'Maria Chen'],
        createdAt: '2026-05-01T00:00:00Z'
      }
    ];
    setAll(KEYS.events, events);

    // ── Invoices ───────────────────────────────────────────────────────────
    const invoices = [
      {
        id: 'inv1', clientId: 'c3', clientName: 'Peters Family',
        jobId: 'j3', jobTitle: 'Ecological Landscaping',
        amount: 850.00, status: 'overdue', dueDate: '2026-05-10',
        issuedDate: '2026-04-10', paidDate: null,
        createdAt: '2026-04-10T00:00:00Z'
      },
      {
        id: 'inv2', clientId: 'c2', clientName: 'Dave Johnson',
        jobId: 'j2', jobTitle: 'Rain Garden Design',
        amount: 320.00, status: 'draft', dueDate: null,
        issuedDate: null, paidDate: null,
        createdAt: '2026-05-15T00:00:00Z'
      }
    ];
    setAll(KEYS.invoices, invoices);

    // ── Grants ─────────────────────────────────────────────────────────────
    const grants = [
      {
        id: 'gr1', funder: 'DCNR', program: 'Lawn-to-Meadow Program',
        jobId: 'j1', jobTitle: 'Lawn to Meadow Conversion — Smith Residence',
        amount: 2400, status: 'active',
        notes: 'Approved April 2026. Documentation due August 2026.',
        deadline: '2026-08-31', appliedDate: '2026-03-01',
        approvedDate: '2026-04-10', createdAt: '2026-03-01T00:00:00Z'
      }
    ];
    setAll(KEYS.grants, grants);

    // ── Historical check-ins (last 30 days) ────────────────────────────────
    const base = Date.now();
    function daysAgo(d) { return new Date(base - d * 86400000).toISOString(); }

    const checkins = [
      {
        id: 'ci1', gardenId: 'g1', gardenName: 'Millbrook Community Garden',
        volunteerId: 'v1', volunteerName: 'Sarah Mitchell',
        taskId: 't1', taskTitle: 'Water raised beds',
        hoursLogged: 0.75, checkInTime: daysAgo(2), checkOutTime: daysAgo(2),
        type: 'scheduled', notes: ''
      },
      {
        id: 'ci2', gardenId: 'g3', gardenName: 'Blair Food Forest',
        volunteerId: 'v6', volunteerName: 'Lisa Hern',
        taskId: 't14', taskTitle: 'Harvest + log yield',
        hoursLogged: 0.75, checkInTime: daysAgo(3), checkOutTime: daysAgo(3),
        type: 'scheduled', notes: 'Good harvest today — tomatoes and zucchini.'
      },
      {
        id: 'ci3', gardenId: 'g1', gardenName: 'Millbrook Community Garden',
        volunteerId: 'v3', volunteerName: 'Maria Chen',
        taskId: 't5', taskTitle: 'Pest & disease inspection',
        hoursLogged: 0.5, checkInTime: daysAgo(5), checkOutTime: daysAgo(5),
        type: 'scheduled', notes: 'Saw some aphids on the kale. Left note.'
      },
      {
        id: 'ci4', gardenId: 'g2', gardenName: 'Juniata Valley Meadow Restoration',
        volunteerId: 'v4', volunteerName: 'Tom Graziano',
        taskId: 't9', taskTitle: 'Mow paths',
        hoursLogged: 1.5, checkInTime: daysAgo(6), checkOutTime: daysAgo(6),
        type: 'scheduled', notes: ''
      },
      {
        id: 'ci5', gardenId: 'g1', gardenName: 'Millbrook Community Garden',
        volunteerId: 'v1', volunteerName: 'Sarah Mitchell',
        taskId: 't1', taskTitle: 'Water raised beds',
        hoursLogged: 0.75, checkInTime: daysAgo(9), checkOutTime: daysAgo(9),
        type: 'scheduled', notes: ''
      },
      {
        id: 'ci6', gardenId: 'g3', gardenName: 'Blair Food Forest',
        volunteerId: 'v5', volunteerName: 'Dave Patterson',
        taskId: 't12', taskTitle: 'Water young trees',
        hoursLogged: 1.0, checkInTime: daysAgo(11), checkOutTime: daysAgo(11),
        type: 'scheduled', notes: 'Trees looking good after last rain.'
      },
      {
        id: 'ci7', gardenId: 'g2', gardenName: 'Juniata Valley Meadow Restoration',
        volunteerId: 'v3', volunteerName: 'Maria Chen',
        taskId: 't10', taskTitle: 'Photo documentation',
        hoursLogged: 0.5, checkInTime: daysAgo(14), checkOutTime: daysAgo(14),
        type: 'scheduled', notes: 'Spring wildflowers emerging nicely.'
      },
      {
        id: 'ci8', gardenId: 'g1', gardenName: 'Millbrook Community Garden',
        volunteerId: 'v2', volunteerName: 'Bob Kowalski',
        taskId: null, taskTitle: 'Pull weeds anywhere',
        hoursLogged: 1.0, checkInTime: daysAgo(18), checkOutTime: daysAgo(18),
        type: 'walkin', notes: ''
      }
    ];
    setAll(KEYS.checkins, checkins);

    // ── Observations ───────────────────────────────────────────────────────
    const observations = [
      {
        id: 'obs1', gardenId: 'g1', gardenName: 'Millbrook Community Garden',
        submittedBy: 'Maria Chen', note: 'Aphids spotted on kale in bed 3. Not severe.',
        flagged: false, createdAt: daysAgo(5)
      },
      {
        id: 'obs2', gardenId: 'g3', gardenName: 'Blair Food Forest',
        submittedBy: 'Lisa Hern', note: 'One of the young apple trees has some leaf curl.',
        flagged: true, createdAt: daysAgo(3)
      }
    ];
    setAll(KEYS.observations, observations);
  }

  // ── Public entity helpers ──────────────────────────────────────────────────
  const api = {
    // Seeds
    init() { seedAll(); },

    // Gardens
    getGardens: () => getAll(KEYS.gardens),
    getGarden: (id) => getById(KEYS.gardens, id),
    getGardenByToken: (token) => getAll(KEYS.gardens).find(g => g.qrToken === token) || null,
    addGarden: (r) => insert(KEYS.gardens, r),
    updateGarden: (id, ch) => update(KEYS.gardens, id, ch),

    // Clients
    getClients: () => getAll(KEYS.clients),
    getClient: (id) => getById(KEYS.clients, id),
    addClient: (r) => insert(KEYS.clients, r),
    updateClient: (id, ch) => update(KEYS.clients, id, ch),

    // Jobs
    getJobs: () => getAll(KEYS.jobs),
    getJob: (id) => getById(KEYS.jobs, id),
    addJob: (r) => insert(KEYS.jobs, r),
    updateJob: (id, ch) => update(KEYS.jobs, id, ch),
    addJobNote: (id, note) => {
      const job = getById(KEYS.jobs, id);
      if (!job) return null;
      const log = job.activityLog || [];
      log.push({ ts: new Date().toISOString(), note });
      return update(KEYS.jobs, id, { activityLog: log });
    },

    // Volunteers
    getVolunteers: () => getAll(KEYS.volunteers),
    getVolunteer: (id) => getById(KEYS.volunteers, id),
    addVolunteer: (r) => insert(KEYS.volunteers, r),
    updateVolunteer: (id, ch) => update(KEYS.volunteers, id, ch),

    // Tasks
    getTasks: () => getAll(KEYS.tasks),
    getTasksByGarden: (gId) => getAll(KEYS.tasks).filter(t => t.gardenId === gId),
    getTasksByVolunteer: (vId) => getAll(KEYS.tasks).filter(t => t.volunteerId === vId),
    getJordanTasks: () => getAll(KEYS.tasks).filter(t => t.owner === 'jordan'),
    getOpenTasks: () => getAll(KEYS.tasks).filter(t => t.owner === 'open'),
    getTask: (id) => getById(KEYS.tasks, id),
    addTask: (r) => insert(KEYS.tasks, r),
    updateTask: (id, ch) => update(KEYS.tasks, id, ch),
    claimTask: (taskId, volunteerId, volunteerName) =>
      update(KEYS.tasks, taskId, { owner: 'volunteer', volunteerId, volunteerName }),

    // Walk-in tasks
    getWalkins: () => getAll(KEYS.walkins),
    getWalkinsByGarden: (gId) => getAll(KEYS.walkins).filter(w => w.gardenId === gId && w.active),
    updateWalkin: (id, ch) => update(KEYS.walkins, id, ch),

    // Check-ins
    getCheckins: () => getAll(KEYS.checkins),
    getCheckinsByGarden: (gId) => getAll(KEYS.checkins).filter(c => c.gardenId === gId),
    getCheckinsByVolunteer: (vId) => getAll(KEYS.checkins).filter(c => c.volunteerId === vId),
    addCheckin: (r) => insert(KEYS.checkins, r),
    getRecentCheckins: (n = 5) => {
      return getAll(KEYS.checkins)
        .sort((a, b) => new Date(b.checkInTime) - new Date(a.checkInTime))
        .slice(0, n);
    },
    getHoursLast30: (volunteerId) => {
      const cutoff = new Date(Date.now() - 30 * 86400000);
      return getAll(KEYS.checkins)
        .filter(c => c.volunteerId === volunteerId && new Date(c.checkInTime) >= cutoff)
        .reduce((sum, c) => sum + (c.hoursLogged || 0), 0);
    },

    // Events
    getEvents: () => getAll(KEYS.events),
    getEvent: (id) => getById(KEYS.events, id),
    addEvent: (r) => insert(KEYS.events, r),
    updateEvent: (id, ch) => update(KEYS.events, id, ch),
    signupForEvent: (eventId, name) => {
      const ev = getById(KEYS.events, eventId);
      if (!ev) return null;
      const signups = ev.signups || [];
      if (!signups.includes(name)) signups.push(name);
      return update(KEYS.events, eventId, { signups });
    },
    getUpcomingEvents: () => {
      const today = new Date().toISOString().slice(0, 10);
      return getAll(KEYS.events)
        .filter(e => e.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date));
    },

    // Invoices
    getInvoices: () => getAll(KEYS.invoices),
    getInvoice: (id) => getById(KEYS.invoices, id),
    addInvoice: (r) => insert(KEYS.invoices, r),
    updateInvoice: (id, ch) => update(KEYS.invoices, id, ch),
    markInvoicePaid: (id) => update(KEYS.invoices, id, { status: 'paid', paidDate: new Date().toISOString().slice(0, 10) }),
    getUnpaidInvoices: () => getAll(KEYS.invoices).filter(i => i.status !== 'paid'),

    // Grants
    getGrants: () => getAll(KEYS.grants),
    getGrant: (id) => getById(KEYS.grants, id),
    addGrant: (r) => insert(KEYS.grants, r),
    updateGrant: (id, ch) => update(KEYS.grants, id, ch),

    // Observations
    getObservations: () => getAll(KEYS.observations),
    getObservationsByGarden: (gId) => getAll(KEYS.observations).filter(o => o.gardenId === gId),
    addObservation: (r) => insert(KEYS.observations, r),
    flagObservation: (id) => update(KEYS.observations, id, { flagged: true }),

    // Intake submissions
    addIntakeSubmission: (r) => insert(KEYS.intake_submissions, r),
    getIntakeSubmissions: () => getAll(KEYS.intake_submissions),

    // Volunteer applications (from board)
    addVolunteerApplication: (r) => insert(KEYS.volunteer_applications, r),
    getVolunteerApplications: () => getAll(KEYS.volunteer_applications),

    // Utility
    uid,
    formatDate(isoStr) {
      if (!isoStr) return '—';
      const d = new Date(isoStr);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },
    formatTime(isoStr) {
      if (!isoStr) return '—';
      const d = new Date(isoStr);
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    },
    daysUntil(isoStr) {
      if (!isoStr) return null;
      const diff = new Date(isoStr).setHours(0,0,0,0) - new Date().setHours(0,0,0,0);
      return Math.round(diff / 86400000);
    }
  };

  return api;
})();

// Auto-seed on load
DataStore.init();
