/**
 * Ecotopia Portal - planting record arithmetic.
 *
 * Pure functions only: no network, no DOM, no Supabase client. The portal and the
 * public garden cards both summarise the same rows, so the arithmetic lives here
 * once and is tested by node --test.
 *
 * Written in the same universal style as assets/mapping.js, so the one file loads
 * in the browser via a script tag and in Node via require, both reading
 * globalThis.EcoPlantings.
 *
 * Rows are the camelCase shape EcoMapping.fromDbAll produces: gardenId,
 * speciesLabel, quantity, plantedOn.
 */
(function (root) {
  // Staff type labels by hand, so 'Wild Columbine' and 'wild columbine ' are the
  // same plant. Counting keys off a normalised form stops a stray capital from
  // inventing a second species in a grant figure.
  const key = (label) => String(label || '').trim().toLowerCase();

  const qty = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const plantingLabel = (row) => {
    const label = String((row && row.speciesLabel) || '').trim();
    return label || 'Unnamed planting';
  };

  // Skips a blank-labelled row entirely, exactly as speciesBreakdown does below.
  // Counting its quantity here while the breakdown drops it would print a headline
  // total larger than the list of species under it, which reads as a rendering bug
  // on a public page. The database rejects a blank label, so this should be
  // unreachable, but the two functions now agree by construction rather than by
  // trusting a constraint in another system.
  function summarise(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const species = new Set();
    let plants = 0;
    for (const r of list) {
      const k = key(r && r.speciesLabel);
      if (!k) continue;
      plants += qty(r && r.quantity);
      species.add(k);
    }
    return { plants, species: species.size };
  }

  // Filters on plantedOn, the date the work happened, NOT created_at, which is when
  // somebody got around to typing it in. A planting entered late still belongs to
  // the year it went in the ground.
  function summariseForYear(rows, year) {
    const list = Array.isArray(rows) ? rows : [];
    const want = String(year);
    return summarise(list.filter((r) => String((r && r.plantedOn) || '').slice(0, 4) === want));
  }

  function speciesBreakdown(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const byKey = new Map();
    for (const r of list) {
      const k = key(r && r.speciesLabel);
      if (!k) continue;
      // Keep the first spelling seen, so the display shows a human's capitalisation
      // rather than the normalised lookup key.
      const seen = byKey.get(k) || { label: plantingLabel(r), plants: 0 };
      seen.plants += qty(r && r.quantity);
      byKey.set(k, seen);
    }
    return [...byKey.values()].sort((a, b) => b.plants - a.plants || a.label.localeCompare(b.label));
  }

  root.EcoPlantings = {
    plantingLabel, summarise, summariseForYear, speciesBreakdown,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
