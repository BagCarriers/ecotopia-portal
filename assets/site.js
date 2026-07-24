/**
 * Ecotopian EarthCare - public marketing site runtime.
 * Public surface only: reads events + gardens + staff gallery photos over the
 * anon key (RLS enforced server-side, migration 0010). No auth, no writes.
 * Loads AFTER supabase.js + config.js + supabase-client.js + mapping.js.
 * Node-safe at load: nothing here touches `document` until a render fn runs.
 */
(function (root) {
  'use strict';

  // Same 6-line escaper as DataStore.esc (duplicated on purpose so public
  // pages never load data.js). ALWAYS wrap DB strings before innerHTML.
  function esc(v) {
    if (v == null) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const sb = () => root.ecoSupabase;
  const map = () => root.EcoMapping;

  // ── Service lead-gen forms ──────────────────────────────────────────────
  // One entry per marketing service, keyed by the same slug as
  // public.service_settings. `questions` are the service-specific inputs; a
  // standard contact block (name/phone/email/address/preferred contact) is
  // appended by the renderer. `hint` is a non-question display note.
  // These keys ARE the onclick allowlist: EcoSite.openService(slug) refuses
  // any slug not present here.
  const SERVICE_FORMS = {
    pollinator_garden: {
      name: 'Pollinator Garden / Mini Meadow',
      questions: [
        { id: 'area', label: 'Approximate area', type: 'select',
          options: ['Under 500 sq ft', '500 to 2000 sq ft', 'Over 2000 sq ft', 'Not sure'] },
        { id: 'sun', label: 'Sun exposure', type: 'select',
          options: ['Full sun', 'Part sun', 'Mostly shade', 'Mixed'] },
        { id: 'attract', label: 'What do you hope to attract?', type: 'text',
          placeholder: 'Butterflies, songbirds, native bees...' },
      ],
    },
    food_forest: {
      name: 'Food Forest Design',
      questions: [
        { id: 'space', label: 'Approximate space', type: 'select',
          options: ['Under 1000 sq ft', '1000 to 5000 sq ft', 'Over 5000 sq ft', 'Not sure'] },
        { id: 'existing_trees', label: 'Any existing trees to work around?', type: 'select',
          options: ['Yes, several', 'A few', 'None', 'Not sure'] },
      ],
    },
    rain_garden: {
      name: 'Rain Garden',
      questions: [
        { id: 'water', label: 'Where does water collect on your property?', type: 'textarea',
          placeholder: 'Low spots, near the driveway, by the downspouts...' },
        { id: 'downspout', label: 'Is a downspout involved?', type: 'select',
          options: ['Yes', 'No', 'Not sure'] },
      ],
    },
    annual_food_garden: {
      name: 'Annual Food Garden',
      questions: [
        { id: 'bed_type', label: 'Raised beds or in-ground?', type: 'select',
          options: ['Raised beds', 'In-ground', 'Both', 'Not sure'] },
        { id: 'experience', label: 'Your gardening experience', type: 'select',
          options: ['New to gardening', 'Some experience', 'Experienced grower'] },
      ],
    },
    living_willow: {
      name: 'Living Willow Fence',
      hint: 'Living willow is planted and woven in March, so we schedule these for late winter.',
      questions: [
        { id: 'structure', label: 'What would you like built?', type: 'select',
          options: ['Fence', 'Tunnel', 'Dome', 'Archway', 'Not sure'] },
      ],
    },
    garden_maintenance: {
      name: 'Routine Garden Maintenance',
      questions: [
        { id: 'property_type', label: 'Property type', type: 'select',
          options: ['Home', 'Business', 'Community space'] },
        { id: 'frequency', label: 'How often?', type: 'select',
          options: ['One-time cleanup', 'Monthly', 'Seasonal'] },
      ],
    },
    medicinal_herb: {
      name: 'Medicinal Herb Garden and Consulting',
      questions: [
        { id: 'scope', label: 'What are you looking for?', type: 'select',
          options: ['Consulting only', 'Design and install'] },
        { id: 'goals', label: 'Your health or land goals', type: 'textarea',
          placeholder: 'Teas, salves, pollinator support, a calming space...' },
      ],
    },
    forest_restoration: {
      name: 'Forest Habitat Restoration',
      questions: [
        { id: 'acreage', label: 'Approximate wooded acreage', type: 'text',
          placeholder: 'e.g. 2 acres' },
        { id: 'concern', label: 'Main concern', type: 'select',
          options: ['Invasives', 'Erosion', 'Habitat', 'Opening canopy', 'Other'] },
      ],
    },
    woodland_restoration: {
      name: 'Woodland Habitat Restoration',
      questions: [
        { id: 'acreage', label: 'Approximate wooded acreage', type: 'text',
          placeholder: 'e.g. 2 acres' },
        { id: 'concern', label: 'Main concern', type: 'select',
          options: ['Invasives', 'Erosion', 'Habitat', 'Opening canopy', 'Other'] },
      ],
    },
    lawn_to_meadow: {
      name: 'Lawn to Meadow Conversion',
      hint: 'The free PA DCNR meadow program has a half-acre minimum. Ask us and we will check if your land qualifies.',
      questions: [
        { id: 'acreage', label: 'Approximate acreage', type: 'select',
          options: ['Under half acre', 'Half to 1 acre', '1 to 3 acres', '3+ acres'] },
        { id: 'dcnr', label: 'Interested in the free DCNR program?', type: 'select',
          options: ['Yes', 'Tell me more', 'No'] },
      ],
    },
  };

  // Runtime state for the lead modal (browser only).
  let SERVICE_SETTINGS = {};   // slug -> setting row (camelCase)
  let SETTINGS_LOADED = false; // false => fetch failed; cards fall back to intake.html
  let lastFocused = null;      // focus restore target

  // ── Data (fail-loud: pages catch and render a quiet fallback line) ──────
  async function getEvents() {
    const { data, error } = await sb().from('events').select('*')
      .order('date', { ascending: true });
    if (error) throw new Error(error.message);
    return map().fromDbAll(data);
  }

  async function getGardens() {
    const { data, error } = await sb().from('gardens').select('*')
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return map().fromDbAll(data);
  }

  async function getStaffPhotos(limit = 24) {
    const { data, error } = await sb().from('gallery_photos').select('*')
      .eq('source', 'staff')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    const rows = map().fromDbAll(data);
    return rows.map((r) => ({
      ...r,
      url: sb().storage.from('gallery').getPublicUrl(r.storagePath).data.publicUrl,
    }));
  }

  // Anon read of service_settings. Fail-soft: caller treats a thrown error as
  // "settings unknown" and falls back to plain intake.html links.
  async function getServiceSettings() {
    const { data, error } = await sb().from('service_settings').select('*');
    if (error) throw new Error(error.message);
    return map().fromDbAll(data);
  }

  // ── Willow weave divider (signature motif). Three interlaced strands,
  //    low opacity, drawn inline so no external asset is needed. ───────────
  const WILLOW = {
    a: 'M 0 26 Q 12.5 26 25 37.3 Q 37.5 37.3 50 37.3 Q 62.5 37.3 75 26 Q 87.5 26 100 14.7 Q 112.5 14.7 125 14.7 Q 137.5 14.7 150 26 Q 162.5 26 175 37.3 Q 187.5 37.3 200 37.3 Q 212.5 37.3 225 26 Q 237.5 26 250 14.7 Q 262.5 14.7 275 14.7 Q 287.5 14.7 300 26 Q 312.5 26 325 37.3 Q 337.5 37.3 350 37.3 Q 362.5 37.3 375 26 Q 387.5 26 400 14.7 Q 412.5 14.7 425 14.7 Q 437.5 14.7 450 26 Q 462.5 26 475 37.3 Q 487.5 37.3 500 37.3 Q 512.5 37.3 525 26 Q 537.5 26 550 14.7 Q 562.5 14.7 575 14.7 Q 587.5 14.7 600 26 Q 612.5 26 625 37.3 Q 637.5 37.3 650 37.3 Q 662.5 37.3 675 26 Q 687.5 26 700 14.7 Q 712.5 14.7 725 14.7 Q 737.5 14.7 750 26 Q 762.5 26 775 37.3 Q 787.5 37.3 800 37.3 Q 812.5 37.3 825 26 Q 837.5 26 850 14.7 Q 862.5 14.7 875 14.7 Q 887.5 14.7 900 26 Q 912.5 26 925 37.3 Q 937.5 37.3 950 37.3 Q 962.5 37.3 975 26 Q 987.5 26 1000 14.7 Q 1012.5 14.7 1025 14.7 Q 1037.5 14.7 1050 26 Q 1062.5 26 1075 37.3 Q 1087.5 37.3 1100 37.3 Q 1112.5 37.3 1125 26 Q 1137.5 26 1150 14.7 Q 1162.5 14.7 1175 14.7 Q 1187.5 14.7 1200 26',
    b: 'M 0 26 Q 12.5 26 25 14.7 Q 37.5 14.7 50 14.7 Q 62.5 14.7 75 26 Q 87.5 26 100 37.3 Q 112.5 37.3 125 37.3 Q 137.5 37.3 150 26 Q 162.5 26 175 14.7 Q 187.5 14.7 200 14.7 Q 212.5 14.7 225 26 Q 237.5 26 250 37.3 Q 262.5 37.3 275 37.3 Q 287.5 37.3 300 26 Q 312.5 26 325 14.7 Q 337.5 14.7 350 14.7 Q 362.5 14.7 375 26 Q 387.5 26 400 37.3 Q 412.5 37.3 425 37.3 Q 437.5 37.3 450 26 Q 462.5 26 475 14.7 Q 487.5 14.7 500 14.7 Q 512.5 14.7 525 26 Q 537.5 26 550 37.3 Q 562.5 37.3 575 37.3 Q 587.5 37.3 600 26 Q 612.5 26 625 14.7 Q 637.5 14.7 650 14.7 Q 662.5 14.7 675 26 Q 687.5 26 700 37.3 Q 712.5 37.3 725 37.3 Q 737.5 37.3 750 26 Q 762.5 26 775 14.7 Q 787.5 14.7 800 14.7 Q 812.5 14.7 825 26 Q 837.5 26 850 37.3 Q 862.5 37.3 875 37.3 Q 887.5 37.3 900 26 Q 912.5 26 925 14.7 Q 937.5 14.7 950 14.7 Q 962.5 14.7 975 26 Q 987.5 26 1000 37.3 Q 1012.5 37.3 1025 37.3 Q 1037.5 37.3 1050 26 Q 1062.5 26 1075 14.7 Q 1087.5 14.7 1100 14.7 Q 1112.5 14.7 1125 26 Q 1137.5 26 1150 37.3 Q 1162.5 37.3 1175 37.3 Q 1187.5 37.3 1200 26',
    c: 'M 0 39 Q 12.5 39 25 32.5 Q 37.5 32.5 50 19.5 Q 62.5 19.5 75 13 Q 87.5 13 100 19.5 Q 112.5 19.5 125 32.5 Q 137.5 32.5 150 39 Q 162.5 39 175 32.5 Q 187.5 32.5 200 19.5 Q 212.5 19.5 225 13 Q 237.5 13 250 19.5 Q 262.5 19.5 275 32.5 Q 287.5 32.5 300 39 Q 312.5 39 325 32.5 Q 337.5 32.5 350 19.5 Q 362.5 19.5 375 13 Q 387.5 13 400 19.5 Q 412.5 19.5 425 32.5 Q 437.5 32.5 450 39 Q 462.5 39 475 32.5 Q 487.5 32.5 500 19.5 Q 512.5 19.5 525 13 Q 537.5 13 550 19.5 Q 562.5 19.5 575 32.5 Q 587.5 32.5 600 39 Q 612.5 39 625 32.5 Q 637.5 32.5 650 19.5 Q 662.5 19.5 675 13 Q 687.5 13 700 19.5 Q 712.5 19.5 725 32.5 Q 737.5 32.5 750 39 Q 762.5 39 775 32.5 Q 787.5 32.5 800 19.5 Q 812.5 19.5 825 13 Q 837.5 13 850 19.5 Q 862.5 19.5 875 32.5 Q 887.5 32.5 900 39 Q 912.5 39 925 32.5 Q 937.5 32.5 950 19.5 Q 962.5 19.5 975 13 Q 987.5 13 1000 19.5 Q 1012.5 19.5 1025 32.5 Q 1037.5 32.5 1050 39 Q 1062.5 39 1075 32.5 Q 1087.5 32.5 1100 19.5 Q 1112.5 19.5 1125 13 Q 1137.5 13 1150 19.5 Q 1162.5 19.5 1175 32.5 Q 1187.5 32.5 1200 39',
  };
  function willowSvg(strokeOpacity) {
    const o = strokeOpacity == null ? 0.4 : strokeOpacity;
    return (
      '<svg viewBox="0 0 1200 52" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
      '<g fill="none" stroke-width="2" stroke-linecap="round">' +
      '<path d="' + WILLOW.a + '" stroke="var(--green)" stroke-opacity="' + o + '"/>' +
      '<path d="' + WILLOW.b + '" stroke="var(--green)" stroke-opacity="' + o + '"/>' +
      '<path d="' + WILLOW.c + '" stroke="var(--amber)" stroke-opacity="' + (o * 0.7).toFixed(2) + '"/>' +
      '</g></svg>'
    );
  }
  function willowSvgWhite(strokeOpacity) {
    const o = strokeOpacity == null ? 1 : strokeOpacity;
    return (
      '<svg viewBox="0 0 1200 52" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
      '<g fill="none" stroke-width="2" stroke-linecap="round" stroke="#fff" stroke-opacity="' + o + '">' +
      '<path d="' + WILLOW.a + '"/><path d="' + WILLOW.b + '"/><path d="' + WILLOW.c + '"/>' +
      '</g></svg>'
    );
  }

  // ── Nav / chrome rendering (browser only) ───────────────────────────────
  const NAV = [
    { href: 'index.html', label: 'Home', key: 'home' },
    { href: 'services.html', label: 'Services', key: 'services' },
    { href: 'happenings.html', label: 'Events', key: 'events' },
    { href: 'community-gardens.html', label: 'Community Gardens', key: 'gardens' },
    { href: 'photos.html', label: 'Photos', key: 'photos' },
    { href: 'volunteer-board.html', label: 'Volunteer', key: 'volunteer' },
  ];

  function renderNav(activePage) {
    const header = document.getElementById('siteHeader');
    if (header) {
      const items = NAV.map((l) => {
        const cur = l.key === activePage ? ' aria-current="page"' : '';
        return '<li><a href="' + l.href + '"' + cur + '>' + esc(l.label) + '</a></li>';
      }).join('');
      header.innerHTML =
        '<div class="nav-inner">' +
          '<a class="brand" href="index.html"><span class="leaf" aria-hidden="true">❀</span>Ecotopian EarthCare</a>' +
          '<button class="nav-toggle" id="navToggle" aria-label="Menu" aria-expanded="false" aria-controls="navLinks">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>' +
          '</button>' +
          '<ul class="nav-links" id="navLinks">' + items +
            '<li class="nav-cta-li"><a class="nav-cta" href="intake.html">Get Started</a></li>' +
          '</ul>' +
        '</div>';
      const toggle = document.getElementById('navToggle');
      const links = document.getElementById('navLinks');
      toggle.addEventListener('click', () => {
        const open = links.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      links.addEventListener('click', (e) => {
        if (e.target.closest('a')) {
          links.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
        }
      });
    }
    decorate();
  }

  // Fill willow dividers + wire scroll reveal (idempotent, safe to call once).
  function decorate() {
    document.querySelectorAll('.willow:not([data-done])').forEach((el) => {
      const o = el.getAttribute('data-opacity');
      el.innerHTML = el.hasAttribute('data-white')
        ? willowSvgWhite(o ? Number(o) : undefined)
        : willowSvg(o ? Number(o) : undefined);
      el.setAttribute('data-done', '1');
    });

    const reveals = document.querySelectorAll('.reveal:not([data-r])');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) {
      reveals.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    reveals.forEach((el) => { el.setAttribute('data-r', '1'); io.observe(el); });
  }

  // ── Date helpers for event badges ───────────────────────────────────────
  function badge(dateStr, past) {
    if (!dateStr) return '';
    const parts = String(dateStr).split('-'); // yyyy-mm-dd (date-only, no TZ shift)
    const y = parts[0], m = Number(parts[1]) - 1, d = Number(parts[2]);
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '<div class="date-badge' + (past ? ' past' : '') + '">' +
      '<span class="mo">' + (MO[m] || '') + '</span>' +
      '<span class="day">' + (d || '') + '</span>' +
      '<span class="yr">' + esc(y) + '</span></div>';
  }

  // ── Service lead modal (browser only) ───────────────────────────────────
  // Format a yyyy-mm-dd date as "Month D, YYYY" with no timezone shift.
  function formatLongDate(dateStr) {
    if (!dateStr) return '';
    const parts = String(dateStr).split('-');
    if (parts.length < 3) return '';
    const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    const m = Number(parts[1]) - 1, d = Number(parts[2]);
    if (!(m >= 0 && m < 12) || !d) return '';
    return MO[m] + ' ' + d + ', ' + parts[0];
  }

  // Build the modal shell once and append it to <body>.
  function ensureModal() {
    if (document.getElementById('ecoLeadOverlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'eco-lead-overlay';
    overlay.id = 'ecoLeadOverlay';
    overlay.innerHTML =
      '<div class="eco-lead-modal" role="dialog" aria-modal="true" aria-labelledby="ecoLeadTitle">' +
        '<button type="button" class="eco-lead-close" id="ecoLeadClose" aria-label="Close">&times;</button>' +
        '<div class="eco-lead-body" id="ecoLeadBody"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.getElementById('ecoLeadClose').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
    });
  }

  function showModal() {
    const overlay = document.getElementById('ecoLeadOverlay');
    lastFocused = document.activeElement;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    const first = overlay.querySelector('input, select, textarea, button.eco-lead-primary');
    if (first) first.focus();
  }

  function closeModal() {
    const overlay = document.getElementById('ecoLeadOverlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    if (lastFocused && lastFocused.focus) { try { lastFocused.focus(); } catch (e) { /* ignore */ } }
    lastFocused = null;
  }

  // Render one field (service question). Values are static, esc'd anyway.
  function fieldHtml(q) {
    const id = 'eco-lead-q-' + esc(q.id);
    let control;
    if (q.type === 'select') {
      const opts = ['<option value="">Select...</option>'].concat(
        (q.options || []).map((o) => '<option value="' + esc(o) + '">' + esc(o) + '</option>')
      ).join('');
      control = '<select id="' + id + '" data-q="' + esc(q.id) + '" data-label="' + esc(q.label) + '">' + opts + '</select>';
    } else if (q.type === 'textarea') {
      control = '<textarea id="' + id + '" data-q="' + esc(q.id) + '" data-label="' + esc(q.label) + '"' +
        (q.placeholder ? ' placeholder="' + esc(q.placeholder) + '"' : '') + '></textarea>';
    } else {
      control = '<input type="text" id="' + id + '" data-q="' + esc(q.id) + '" data-label="' + esc(q.label) + '"' +
        (q.placeholder ? ' placeholder="' + esc(q.placeholder) + '"' : '') + '>';
    }
    return '<div class="eco-lead-field"><label for="' + id + '">' + esc(q.label) + '</label>' + control + '</div>';
  }

  // Standard contact block (name/phone required, email, address, preferred contact).
  function contactHtml() {
    return (
      '<div class="eco-lead-field"><label for="eco-lead-c-name">Name <span class="req">*</span></label>' +
        '<input type="text" id="eco-lead-c-name" placeholder="Full name"></div>' +
      '<div class="eco-lead-field"><label for="eco-lead-c-phone">Phone <span class="req">*</span></label>' +
        '<input type="tel" id="eco-lead-c-phone" placeholder="(814) 555-0000"></div>' +
      '<div class="eco-lead-field"><label for="eco-lead-c-email">Email</label>' +
        '<input type="email" id="eco-lead-c-email" placeholder="email@example.com"></div>' +
      '<div class="eco-lead-field"><label for="eco-lead-c-address">Property address</label>' +
        '<input type="text" id="eco-lead-c-address" placeholder="Street, town"></div>' +
      '<div class="eco-lead-field"><label for="eco-lead-c-pref">Preferred contact</label>' +
        '<select id="eco-lead-c-pref"><option value="phone">Phone call</option>' +
        '<option value="text">Text message</option><option value="email">Email</option></select></div>'
    );
  }

  // Active service: the inquiry form.
  function renderInquiry(slug, form) {
    const body = document.getElementById('ecoLeadBody');
    const qs = (form.questions || []).map(fieldHtml).join('');
    const hint = form.hint ? '<p class="eco-lead-hint">' + esc(form.hint) + '</p>' : '';
    body.innerHTML =
      '<p class="eco-lead-eyebrow">Start an inquiry</p>' +
      '<h2 id="ecoLeadTitle">' + esc(form.name) + '</h2>' +
      hint +
      '<form id="ecoLeadForm" novalidate>' +
        '<div class="eco-lead-grid">' + qs + '</div>' +
        '<p class="eco-lead-sub">How can we reach you?</p>' +
        '<div class="eco-lead-grid">' + contactHtml() + '</div>' +
        '<p class="eco-lead-error" id="ecoLeadError"></p>' +
        '<button type="submit" class="eco-lead-primary">Send inquiry</button>' +
      '</form>';
    document.getElementById('ecoLeadForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitInquiry(slug, form);
    });
  }

  // Inactive service: out-of-season message + waitlist mini form.
  function renderOff(slug, form, setting) {
    const body = document.getElementById('ecoLeadBody');
    let msg = setting && setting.offMessage ? esc(setting.offMessage) : 'This service is out of season.';
    const reopen = setting && setting.reopenDate ? formatLongDate(setting.reopenDate) : '';
    if (reopen) msg += ' We will be starting these again around ' + esc(reopen) + '.';
    body.innerHTML =
      '<p class="eco-lead-eyebrow">Out of season</p>' +
      '<h2 id="ecoLeadTitle">' + esc(form.name) + '</h2>' +
      '<p class="eco-lead-offmsg">' + msg + '</p>' +
      '<p class="eco-lead-sub">Want to join the waitlist?</p>' +
      '<form id="ecoLeadForm" novalidate>' +
        '<div class="eco-lead-grid">' +
          '<div class="eco-lead-field"><label for="eco-lead-w-name">Name <span class="req">*</span></label>' +
            '<input type="text" id="eco-lead-w-name" placeholder="Full name"></div>' +
          '<div class="eco-lead-field"><label for="eco-lead-w-email">Email</label>' +
            '<input type="email" id="eco-lead-w-email" placeholder="email@example.com"></div>' +
          '<div class="eco-lead-field"><label for="eco-lead-w-phone">Phone</label>' +
            '<input type="tel" id="eco-lead-w-phone" placeholder="(814) 555-0000"></div>' +
          '<div class="eco-lead-field eco-lead-full"><label for="eco-lead-w-note">Anything to add?</label>' +
            '<textarea id="eco-lead-w-note" placeholder="Optional"></textarea></div>' +
        '</div>' +
        '<p class="eco-lead-tinynote">Add an email or a phone number so we can reach you.</p>' +
        '<p class="eco-lead-error" id="ecoLeadError"></p>' +
        '<button type="submit" class="eco-lead-primary">Join waitlist</button>' +
      '</form>';
    document.getElementById('ecoLeadForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitWaitlist(slug, form);
    });
  }

  // Raw label: answer lines for DB storage. NOT esc'd: these are stored as plain
  // text and the portal esc's them at render time (pre-escaping would double-encode).
  function collectAnswers() {
    const rows = [];
    document.querySelectorAll('#ecoLeadForm [data-q]').forEach((el) => {
      const v = (el.value || '').trim();
      if (v) rows.push(el.getAttribute('data-label') + ': ' + v);
    });
    return rows;
  }

  async function submitInquiry(slug, form) {
    const errEl = document.getElementById('ecoLeadError');
    errEl.textContent = '';
    const name = (document.getElementById('eco-lead-c-name').value || '').trim();
    const phone = (document.getElementById('eco-lead-c-phone').value || '').trim();
    const email = (document.getElementById('eco-lead-c-email').value || '').trim();
    const address = (document.getElementById('eco-lead-c-address').value || '').trim();
    const pref = document.getElementById('eco-lead-c-pref').value;
    if (!name || !phone) {
      errEl.textContent = 'Please add your name and a phone number so we can reach you.';
      return;
    }
    const qa = collectAnswers();
    // Plain-text (raw) blocks for DB storage; the portal esc's them on render.
    const answersText = qa.length ? qa.join('\n') : 'No additional details provided.';
    const contactBlock = 'Contact: ' + phone + (email ? ' / ' + email : '') +
      (address ? '\nAddress: ' + address : '') + '\nPreferred contact: ' + pref + '.';
    const notes = 'Submitted via services page.\n\n' + answersText + '\n\n' + contactBlock;
    try {
      // Anon inserts, return=minimal (no .select()) so no read policy is needed.
      const ins1 = await sb().from('intake_submissions').insert({
        name: name, phone: phone, email: email, address: address,
        service_type: slug, description: answersText, contact_preference: pref,
        submitted_at: new Date().toISOString(),
      });
      if (ins1.error) throw new Error(ins1.error.message);
      const ins2 = await sb().from('jobs').insert({
        status: 'inquiry',
        title: form.name + ' Inquiry',
        client_name: name,
        address: address,
        type: slug,
        notes: notes,
        activity_log: [{ ts: new Date().toISOString(), note: 'Received via services page.' }],
      });
      if (ins2.error) throw new Error(ins2.error.message);
      showSuccess('Thanks, we got it.', 'We will reach out within a few days.');
    } catch (err) {
      errEl.textContent = 'Something went wrong sending your inquiry. Please try again, or call us directly.';
    }
  }

  async function submitWaitlist(slug, form) {
    const errEl = document.getElementById('ecoLeadError');
    errEl.textContent = '';
    const name = (document.getElementById('eco-lead-w-name').value || '').trim();
    const email = (document.getElementById('eco-lead-w-email').value || '').trim();
    const phone = (document.getElementById('eco-lead-w-phone').value || '').trim();
    const note = (document.getElementById('eco-lead-w-note').value || '').trim();
    if (!name) { errEl.textContent = 'Please add your name.'; return; }
    if (!email && !phone) { errEl.textContent = 'Please add an email or a phone number so we can reach you.'; return; }
    try {
      const ins = await sb().from('service_waitlist').insert({
        service_slug: slug, name: name, email: email, phone: phone, note: note,
      });
      if (ins.error) throw new Error(ins.error.message);
      showSuccess('You are on the list.', 'We will reach out when ' + form.name + ' season opens.');
    } catch (err) {
      errEl.textContent = 'Something went wrong. Please try again, or call us directly.';
    }
  }

  function showSuccess(title, sub) {
    const body = document.getElementById('ecoLeadBody');
    body.innerHTML =
      '<div class="eco-lead-success">' +
        '<div class="eco-lead-check" aria-hidden="true">✓</div>' +
        '<h2 id="ecoLeadTitle">' + esc(title) + '</h2>' +
        '<p>' + esc(sub) + '</p>' +
        '<button type="button" class="eco-lead-primary" id="ecoLeadDone">Close</button>' +
      '</div>';
    const done = document.getElementById('ecoLeadDone');
    done.addEventListener('click', closeModal);
    done.focus();
  }

  // Open the modal for a service. Slug is validated against the SERVICE_FORMS
  // allowlist; anything else is ignored. If settings never loaded, fall back to
  // the plain intake form instead of blocking.
  function openService(slug) {
    const form = SERVICE_FORMS[slug];
    if (!form) return;
    ensureModal();
    if (!SETTINGS_LOADED) { window.location.href = 'intake.html'; return; }
    const setting = SERVICE_SETTINGS[slug];
    const active = setting ? setting.active : true;
    if (active) renderInquiry(slug, form);
    else renderOff(slug, form, setting);
    showModal();
  }

  // Wire every [data-service-slug] card as a keyboard-operable button, then load
  // settings. Safe to call once per page after renderNav.
  async function initServiceLeads() {
    const cards = document.querySelectorAll('[data-service-slug]');
    if (!cards.length) return;
    ensureModal();
    cards.forEach((card) => {
      const slug = card.getAttribute('data-service-slug');
      if (!SERVICE_FORMS[slug]) return; // allowlist
      card.classList.add('svc-lead');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-haspopup', 'dialog');
      const cue = document.createElement('span');
      cue.className = 'svc-cue';
      cue.setAttribute('aria-hidden', 'true');
      cue.textContent = 'Start an inquiry →';
      (card.matches('.svc-row') ? (card.lastElementChild || card) : card).appendChild(cue);
      card.addEventListener('click', () => openService(slug));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openService(slug); }
      });
    });
    try {
      const rows = await getServiceSettings();
      const m = {};
      rows.forEach((r) => { m[r.slug] = r; });
      SERVICE_SETTINGS = m;
      SETTINGS_LOADED = true;
    } catch (e) {
      SETTINGS_LOADED = false; // cards fall back to intake.html
    }
  }

  root.EcoSite = {
    esc: esc,
    renderNav: renderNav,
    decorate: decorate,
    getEvents: getEvents,
    getGardens: getGardens,
    getStaffPhotos: getStaffPhotos,
    getServiceSettings: getServiceSettings,
    initServiceLeads: initServiceLeads,
    openService: openService,
    willowSvg: willowSvg,
    eventBadge: badge,
    todayISO: function () { return new Date().toISOString().slice(0, 10); },
  };
})(typeof window !== 'undefined' ? window : this);
