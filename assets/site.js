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

  root.EcoSite = {
    esc: esc,
    renderNav: renderNav,
    decorate: decorate,
    getEvents: getEvents,
    getGardens: getGardens,
    getStaffPhotos: getStaffPhotos,
    willowSvg: willowSvg,
    eventBadge: badge,
    todayISO: function () { return new Date().toISOString().slice(0, 10); },
  };
})(typeof window !== 'undefined' ? window : this);
