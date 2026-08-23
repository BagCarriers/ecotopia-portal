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

  // Google My Maps id guard. map_mid is staff-entered but renders into an iframe
  // src on the public site; only a bare id (letters, numbers, hyphen, underscore)
  // is ever embedded. Anything else returns false and the caller renders no map.
  function validMapMid(mid) {
    return typeof mid === 'string' && /^[A-Za-z0-9_-]+$/.test(mid);
  }

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
    // NEW 2026 service. Hand-woven by the client's team. Questions stay open so
    // the visit does the discovery rather than the form making claims.
    tree_nets: {
      name: 'Tree Nets',
      questions: [
        { id: 'use', label: 'What would you use the net for?', type: 'select',
          options: ['Climbing and play', 'Canopy shade', 'Harvest catching', 'Habitat feature', 'Not sure yet'] },
        { id: 'span', label: 'Approximate span between trees?', type: 'select',
          options: ['Under 10 ft', '10 to 20 ft', 'Over 20 ft', 'Not sure'] },
      ],
    },
  };

  // ── Service details (state 1 of the lead modal) ─────────────────────────
  // Keyed by the same slugs as SERVICE_FORMS. `about` is 2-3 short paragraphs
  // drawn from the client's real service copy (tightened, no em dashes). `expect`
  // is a process-descriptive "What to expect" list, kept non-promissory since we
  // write on the client's behalf. `review: true` flags copy the client should
  // still review before it is treated as final. Content edits here are code edits.
  const SERVICE_DETAILS = {
    pollinator_garden: {
      headline: 'Pollinator Garden / Mini Meadow',
      about: [
        'Host a small space on your land, from 100 to 1,000 square feet, with native perennial wildflowers that bloom across three seasons and give four-season habitat for birds, butterflies, bees, and beneficial insects.',
        'We grow all of our wildflower plugs from seed we collected the year before. With around 40 species to choose from, we group at least 12 that complement one another in habitat, growth habit, bloom time, and color.',
        'Native plants host the butterflies, moths, and beneficial insects our ecosystem depends on. For nearly every ornamental nursery plant there is a native alternative that actually feeds local wildlife.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'Measurements and your plant preferences gathered on site',
        'A printed design for the site caretaker; designs range from 5 to 10 cents per square foot',
        'Native plants supplied from our local nursery',
        'Optional planting and first-year care by our team',
      ],
    },
    food_forest: {
      headline: 'Food Forest Design',
      about: [
        'Permaculture design studies the patterns in nature\'s blueprint and scales them down to match your planting site.',
        'By arranging edible perennials through companion planting and multiple vertical layers, a food forest builds a self-nurturing ecosystem that produces more food per square foot.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'Measurements and your preferences gathered on site',
        'A printed design for the site caretaker; designs range from 5 to 10 cents per square foot',
        'Native and edible perennials supplied from our local nursery',
        'Optional planting and first-year care by our team',
      ],
    },
    rain_garden: {
      headline: 'Rain Garden',
      about: [
        'A rain garden is a planted depression that soaks up runoff from roofs, driveways, walkways, and compacted lawn, water that would otherwise carry pollutants straight to our streams.',
        'Planted with native perennial wildflowers, shrubs, and small trees, a rain garden can soak up 30 percent or more water than an equivalent patch of lawn.',
        'Have a flooded spot where water sits and the grass is hard to mow? A well-built rain garden takes up that standing water and redirects it away from your basement, and it doubles as a pollinator garden with three-season color and four-season habitat.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'A look at where water collects and any downspouts involved',
        'A printed design for the site caretaker; designs range from 5 to 10 cents per square foot',
        'Native plants supplied from our local nursery',
        'Optional planting and first-year care by our team',
      ],
    },
    annual_food_garden: {
      headline: 'Annual Food Garden',
      about: [
        'A productive vegetable garden planned around your space, your soil, and how you like to grow.',
        'We help with layout, soil analysis and improvement, plant selection, and sustainable practices for a healthy harvest, whether you prefer raised beds or in-ground rows.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'Measurements and your growing preferences gathered on site',
        'A printed design for the site caretaker; designs range from 5 to 10 cents per square foot',
        'Plants supplied from our local nursery',
        'Optional planting and first-year care by our team',
      ],
    },
    living_willow: {
      headline: 'Living Willow Fence',
      about: [
        'The longevity and beauty of a living willow fence surpasses one made from dead material.',
        'A willow cutting of almost any size will root when planted in or near soil. Once pruned, new growth returns tenfold and can grow 4 to 12 feet in a single year, a technique called coppicing. You can prune the top growth back each year, or harvest it in winter for basket weaving.',
        'Willow fences sequester carbon, and willow roots filter heavy metals and other toxins from soil and water while stabilizing stream banks against erosion.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'Your preferred structure gathered on site: fence, tunnel, dome, or archway',
        'Living willow supplied and woven by our team',
        'Planted and woven in late winter, the season for harvesting cuttings',
        'Optional pruning and structural care in the years that follow',
      ],
    },
    garden_maintenance: {
      headline: 'Routine Garden Maintenance',
      about: [
        'Ongoing care from ecological landscapers who can tell an invasive weed from the native you planted.',
        'We keep your beds, meadows, and plantings healthy through the season, at home, at your business, or in a community space.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'A walk-through of your plantings and priorities on site',
        'One-time cleanups, or recurring monthly and seasonal care',
        'Native-plant knowledge so the plants you want stay and the invasives go',
      ],
    },
    medicinal_herb: {
      headline: 'Medicinal Herb Garden and Consulting',
      about: [
        'Our herbalist JennaRose helps you create a medicine garden suited to your needs and your land.',
        'Choose annual medicinals like ashwagandha, tulsi, and calendula for an elegant, space-saving herb spiral, or native perennial medicine plants like echinacea, blue vervain, and wild rose planted into your site\'s own soil.',
        'At harvest, JennaRose can also process and prepare the herb, root, or fruit into medicine through WildRose Herbal Apothecary.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'Consulting only, or full design and install',
        'A printed design for the site caretaker; designs range from 5 to 10 cents per square foot',
        'Native and annual medicinal plants supplied from our nursery',
        'Optional planting, first-year care, and harvest-time herbal processing',
        'Please reach out before April 1st for the coming season',
      ],
    },
    forest_restoration: {
      headline: 'Forest Habitat Restoration',
      about: [
        'We restore wooded and streamside habitat by planting native vegetation and removing invasive plants that crowd out the natives wildlife depends on.',
        'Riparian buffers, 15 to 35 foot corridors of native plants along creeks and rivers, filter pollutants, cool the water, prevent erosion, and rebuild habitat.',
        'Invasive nursery plants escape into our woodlands and outcompete natives. Because most native butterflies, moths, and bees cannot use foreign plants, replacing invasives with natives feeds the whole food chain.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'A walk of the site to assess invasives, erosion, and habitat',
        'Native trees, shrubs, and plants supplied from our nursery',
        'Optional planting and first-year care by our team',
      ],
    },
    woodland_restoration: {
      headline: 'Woodland Habitat Restoration',
      about: [
        'We open a crowded canopy to bring sunlight back to the forest floor, then rebuild the understory.',
        'Thinning select canopy trees makes room to add understory trees, shrubs, vines, herbs, and woodland wildflowers for a layered, biodiverse habitat.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'A walk of the site to assess canopy, understory, and habitat',
        'Native trees, shrubs, and plants supplied from our nursery',
        'Optional planting and first-year care by our team',
      ],
    },
    lawn_to_meadow: {
      headline: 'Lawn to Meadow Conversion',
      about: [
        'We transform high-maintenance grass lawns into low-maintenance native perennial meadows, potentially at no cost to you.',
        'The Pennsylvania DCNR runs a program that can convert qualifying lawns of a half acre or more into native meadow or upland forest for free. Ecotopian EarthCare is an approved contractor with the state.',
        'Meadows need no watering and are mowed just once a year. Their deep roots soak up water and prevent erosion, and they provide real habitat for bees, butterflies, and birds where a turf lawn cannot.',
      ],
      expect: [
        'A free estimate at an in-person site visit',
        'We check whether your land meets the DCNR half-acre minimum and program qualifications',
        'If your land qualifies, the DCNR program can cover the conversion at no cost to you',
        'Native meadow seed and plants suited to your site',
        'Optional ongoing meadow care by our team',
      ],
    },
    // NEW 2026 service. Copy is intentionally modest and honest; the client
    // should review this wording before it is treated as final (review: true).
    tree_nets: {
      headline: 'Tree Nets',
      review: true,
      about: [
        'A tree net is a hand woven rope platform suspended between living trees: part hammock, part treehouse floor, part aerial gathering space. Lounge with a book, stargaze, nap in the canopy, or give the kids a place to climb and play above the forest floor.',
        'Each net is woven on site to fit your trees, with a strong rope perimeter, a tighter inner weave for comfort, and tree friendly rigging that protects bark and leaves room for the trees to grow.',
        'Our team weaves every net by hand, in the same craft family as our living willow fences, domes, and tunnels. No two nets are the same shape because no two groves are.',
      ],
      expect: [
        'An in-person site visit and a free estimate',
        'A custom shape and size woven to fit your trees and how you want to use the net',
        'Weather rated rope with tree friendly, bark protecting rigging',
        'Care guidance for sun, seasons, and keeping your net safe for years',
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
    // Parity guard: signed-in staff RLS also returns internal events; the
    // public site must only ever show published ones.
    return map().fromDbAll(data).filter((e) => e.isPublic !== false);
  }

  // Public URL for an event photo (same public gallery bucket, events/ prefix).
  function eventPhotoUrl(photoPath) {
    return sb().storage.from('gallery').getPublicUrl(photoPath).data.publicUrl;
  }

  // Public URL for a gallery-bucket garden photo. Only used by
  // community-gardens.html for photo_path values that are NOT the 'static:'
  // repo-asset form (those resolve to a local path without touching storage).
  function gardenPhotoUrl(photoPath) {
    return sb().storage.from('gallery').getPublicUrl(photoPath).data.publicUrl;
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

  // Approved first-party reviews (anon read; RLS returns approved rows only).
  // Newest first. The parity filter (status === 'approved') is a belt-and-suspenders
  // guard so a signed-in staff JWT rendering a public page never leaks a pending or
  // dismissed review onto the marketing site.
  async function getApprovedReviews(limit = 30) {
    const { data, error } = await sb().from('reviews').select('*')
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return map().fromDbAll(data).filter((r) => r.status === 'approved');
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

  // ── Wild Ones chapter identity ──────────────────────────────────────────
  // Jordan (2026-08-23): the chapter board want the community gardens and the
  // volunteer programme to read as Wild Ones work, not only as Ecotopian
  // EarthCare work. Everything about that relationship lives here so the wording
  // and the logo are changed in one place across the whole site.
  //
  // WILDONES.logo is the only path to the chapter mark. Drop the official file at
  // that path and every lockup on the site picks it up; until it exists the
  // lockups render as text, which is why every <img> below carries an onerror
  // that hides only the image.
  const WILDONES = {
    name: 'Wild Ones Pennsylvania Ridge and Valley',
    shortName: 'Wild Ones PA Ridge and Valley',
    chapter: '2751',
    join: 'https://join.wildones.org/?chapter=2751',
    site: 'https://parv.wildones.org/',
    logo: 'assets/img/wildones-chapter.png',
  };

  // Hides the image and nothing else if the mark is not on disk yet, so a missing
  // file costs the logo rather than leaving a broken-image icon in the header.
  const WO_FALLBACK = "this.style.display='none'";

  function wildOnesMark(cls) {
    return '<img class="' + cls + '" src="' + WILDONES.logo + '" alt="' + esc(WILDONES.shortName) +
           '" loading="lazy" decoding="async" onerror="' + WO_FALLBACK + '">';
  }

  // The line that states the relationship. Used in the header, in the footer and
  // on the pages that are chapter work.
  function wildOnesLine(text) {
    return '<a class="wo-line" href="' + WILDONES.join + '" target="_blank" rel="noopener">' +
             wildOnesMark('wo-line-mark') +
             '<span>' + esc(text) + '</span>' +
           '</a>';
  }

  // The banner for pages that ARE chapter work: community gardens, volunteering.
  function wildOnesBanner(text) {
    return '<div class="wo-banner">' +
             wildOnesMark('wo-banner-mark') +
             '<div class="wo-banner-text">' +
               '<p class="wo-banner-lead">' + esc(text) + '</p>' +
               '<p class="wo-banner-sub">' + esc(WILDONES.name) + ' chapter ' + esc(WILDONES.chapter) + '. ' +
                 'Membership dues fund this work.</p>' +
             '</div>' +
             '<a class="wo-banner-cta" href="' + WILDONES.join + '" target="_blank" rel="noopener">Join Wild Ones</a>' +
           '</div>';
  }

  // Fills every [data-wildones] placeholder on the page. The attribute value picks
  // the treatment, so a page opts in with markup and needs no script of its own.
  function decorateWildOnes() {
    document.querySelectorAll('[data-wildones]:not([data-wo-done])').forEach((el) => {
      const kind = el.getAttribute('data-wildones');
      const text = el.getAttribute('data-wildones-text') || '';
      el.innerHTML = kind === 'banner' ? wildOnesBanner(text) : wildOnesLine(text);
      el.setAttribute('data-wo-done', '1');
    });
  }

  // ── Nav / chrome rendering (browser only) ───────────────────────────────
  const NAV = [
    { href: 'index.html', label: 'Home', key: 'home' },
    { href: 'about.html', label: 'About', key: 'about' },
    { href: 'services.html', label: 'Services', key: 'services' },
    { href: 'plants.html', label: 'Native Plants', key: 'plants' },
    { href: 'shop.html', label: 'Shop', key: 'shop' },
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
        '<a class="announce-bar" href="https://join.wildones.org/?chapter=2751" target="_blank" rel="noopener">' +
          'Our gardens and volunteer days are Wild Ones PA Ridge and Valley work. Join the chapter <span class="announce-arrow" aria-hidden="true">&rarr;</span>' +
        '</a>' +
        '<div class="nav-inner">' +
          '<div class="brand-lockup">' +
            '<a class="brand" href="index.html"><span class="leaf" aria-hidden="true">❀</span>Ecotopian EarthCare</a>' +
            '<a class="brand-chapter" href="' + WILDONES.join + '" target="_blank" rel="noopener">' +
              wildOnesMark('brand-chapter-mark') +
              '<span>In partnership with ' + esc(WILDONES.shortName) + '</span>' +
            '</a>' +
          '</div>' +
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
    decorateWildOnes();
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

  // State 1: the details card. Answers common questions before any form, then a
  // single primary CTA transitions the SAME modal into the inquiry flow (state 2).
  // Always renderable from static SERVICE_DETAILS, so it shows even if the
  // service_settings fetch failed (the CTA is what falls back to intake.html).
  function renderDetails(slug, form) {
    const body = document.getElementById('ecoLeadBody');
    const d = SERVICE_DETAILS[slug];
    const about = (d.about || []).map((p) => '<p class="eco-lead-about">' + esc(p) + '</p>').join('');
    const bullets = (d.expect || []).map((b) => '<li>' + esc(b) + '</li>').join('');
    const review = d.review
      ? '<p class="eco-lead-reviewnote">This is a new offering and we are still shaping how we provide it. Reach out and we will talk through the details with you.</p>'
      : '';
    body.innerHTML =
      '<p class="eco-lead-eyebrow">Our services</p>' +
      '<h2 id="ecoLeadTitle">' + esc(d.headline || form.name) + '</h2>' +
      about +
      review +
      '<p class="eco-lead-sub">What to expect</p>' +
      '<ul class="eco-lead-expect">' + bullets + '</ul>' +
      '<button type="button" class="eco-lead-primary" id="ecoLeadProceed">I\'m interested in ' + esc(d.headline || form.name) + '</button>' +
      '<button type="button" class="eco-lead-quiet" id="ecoLeadDetailsClose">Close</button>';
    document.getElementById('ecoLeadProceed').addEventListener('click', () => enterInquiryFlow(slug, form));
    document.getElementById('ecoLeadDetailsClose').addEventListener('click', closeModal);
  }

  // Small "Back to details" affordance for state 2.
  function backHtml() {
    return '<button type="button" class="eco-lead-back" id="ecoLeadBack">← Back to details</button>';
  }
  function wireBack(slug, form) {
    const b = document.getElementById('ecoLeadBack');
    if (b) b.addEventListener('click', () => {
      renderDetails(slug, form);
      const p = document.getElementById('ecoLeadProceed');
      if (p) p.focus();
    });
  }
  // Move focus to the first form control when entering state 2.
  function focusFirstField() {
    const first = document.querySelector('#ecoLeadForm input, #ecoLeadForm select, #ecoLeadForm textarea');
    if (first) first.focus();
  }

  // Transition from details (state 1) into the inquiry flow (state 2). Uses the
  // same active/off decision the old flow used. Fail-soft: if settings never
  // loaded, fall back to the plain intake form instead of guessing.
  function enterInquiryFlow(slug, form) {
    if (!SETTINGS_LOADED) { window.location.href = 'intake.html'; return; }
    const setting = SERVICE_SETTINGS[slug];
    const active = setting ? setting.active : true;
    if (active) renderInquiry(slug, form);
    else renderOff(slug, form, setting);
    focusFirstField();
  }

  // Active service: the inquiry form (state 2).
  function renderInquiry(slug, form) {
    const body = document.getElementById('ecoLeadBody');
    const qs = (form.questions || []).map(fieldHtml).join('');
    const hint = form.hint ? '<p class="eco-lead-hint">' + esc(form.hint) + '</p>' : '';
    body.innerHTML =
      backHtml() +
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
    wireBack(slug, form);
  }

  // Inactive service: out-of-season message + waitlist mini form (state 2).
  function renderOff(slug, form, setting) {
    const body = document.getElementById('ecoLeadBody');
    let msg = setting && setting.offMessage ? esc(setting.offMessage) : 'This service is out of season.';
    const reopen = setting && setting.reopenDate ? formatLongDate(setting.reopenDate) : '';
    if (reopen) msg += ' We will be starting these again around ' + esc(reopen) + '.';
    body.innerHTML =
      backHtml() +
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
    wireBack(slug, form);
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
      errEl.textContent = 'Something went wrong sending your inquiry. Please try again, or call us at 814-631-5338.';
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
      errEl.textContent = 'Something went wrong. Please try again, or call us at 814-631-5338.';
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
  // allowlist; anything else is ignored. Opens on the details card (state 1) when
  // details exist; the "I'm interested" CTA there transitions to the inquiry flow.
  // Services without details (defensive) go straight to the inquiry flow.
  function openService(slug) {
    const form = SERVICE_FORMS[slug];
    if (!form) return;
    ensureModal();
    if (SERVICE_DETAILS[slug]) renderDetails(slug, form);
    else enterInquiryFlow(slug, form);
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
      cue.textContent = 'See details →';
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
    validMapMid: validMapMid,
    renderNav: renderNav,
    decorate: decorate,
    getEvents: getEvents,
    eventPhotoUrl: eventPhotoUrl,
    gardenPhotoUrl: gardenPhotoUrl,
    getGardens: getGardens,
    getStaffPhotos: getStaffPhotos,
    getServiceSettings: getServiceSettings,
    getApprovedReviews: getApprovedReviews,
    initServiceLeads: initServiceLeads,
    openService: openService,
    willowSvg: willowSvg,
    eventBadge: badge,
    todayISO: function () { return new Date().toISOString().slice(0, 10); },
  };
})(typeof window !== 'undefined' ? window : this);
