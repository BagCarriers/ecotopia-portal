const test = require('node:test');
const assert = require('node:assert');
require('../supabase/functions/_shared/inat-logic.js');
const E = globalThis.EcoInat;

test('the licence allowlist excludes every NonCommercial variant', () => {
  // Ecotopia sells plants. A NonCommercial photo on the storefront is a licence
  // breach, so this list is the single place that decision is expressed.
  assert.deepStrictEqual(E.PHOTO_LICENCES, ['cc0', 'cc-by', 'cc-by-sa', 'pd']);
  assert.strictEqual(E.isUsableLicence('cc-by-nc'), false);
  assert.strictEqual(E.isUsableLicence('cc-by-nc-sa'), false);
  assert.strictEqual(E.isUsableLicence('cc-by-nc-nd'), false);
  assert.strictEqual(E.isUsableLicence('cc-by-nd'), false);
  assert.strictEqual(E.isUsableLicence(null), false);
  assert.strictEqual(E.isUsableLicence('CC-BY'), true);
});

test('a photograph of Jordan is never eligible for auto fill', () => {
  // THE destructive-failure guard. photo_path set with no inat_photo_id means a
  // real nursery photograph. If this ever returns true, a nightly cron job
  // silently overwrites Jordan's photography and there is no undo.
  const jordan = { photoPath: 'plants/abc.jpg', inatPhotoId: null, inatPhotoStatus: null };
  assert.strictEqual(E.isOwnPhoto(jordan), true);
  assert.strictEqual(E.canAutoFill(jordan), false);

  const staticAsset = { photoPath: 'static:wild-columbine.jpg', inatPhotoId: null, inatPhotoStatus: null };
  assert.strictEqual(E.isOwnPhoto(staticAsset), true);
  assert.strictEqual(E.canAutoFill(staticAsset), false);
});

test('only a species with no photo at all is eligible', () => {
  assert.strictEqual(E.canAutoFill({ photoPath: null, inatPhotoId: null, inatPhotoStatus: null }), true);
  assert.strictEqual(E.canAutoFill({ photoPath: '', inatPhotoId: null, inatPhotoStatus: null }), true);
  // Already carries an approved iNaturalist photo: leave it alone.
  assert.strictEqual(E.canAutoFill({ photoPath: 'plants/x.jpg', inatPhotoId: 99, inatPhotoStatus: 'approved' }), false);
});

test('a rejected photo is never proposed again', () => {
  assert.strictEqual(
    E.canAutoFill({ photoPath: null, inatPhotoId: 12345, inatPhotoStatus: 'rejected' }),
    false
  );
});

test('typographic apostrophes are normalised before querying', () => {
  assert.strictEqual(E.normaliseBotanical('Culver’s Root'), "Culver's Root");
  assert.strictEqual(E.normaliseBotanical('  Aquilegia   canadensis '), 'Aquilegia canadensis');
});

test('a two species row is refused without ever calling the API', () => {
  // The real catalogue row 'Pycnanthemum virginicum & muticum' is two species
  // crammed into one. It cannot resolve to a single taxon and must not guess.
  assert.strictEqual(E.isResolvableName('Pycnanthemum virginicum & muticum'), false);
  assert.strictEqual(E.isResolvableName('Aquilegia canadensis'), true);
  assert.strictEqual(E.isResolvableName('Monarda bradburiana'), true);
  assert.strictEqual(E.isResolvableName(''), false);
  assert.strictEqual(E.isResolvableName('Pycnanthemum'), false);
});

test('an exact botanical match wins', () => {
  const results = [{ id: 47912, name: 'Asclepias tuberosa' }, { id: 1, name: 'Asclepias tuberosa interior' }];
  assert.deepStrictEqual(E.pickTaxon('Asclepias tuberosa', results), {
    taxonId: 47912, match: 'exact', matchedName: 'Asclepias tuberosa',
  });
});

test('a single close spelling variant in the same genus resolves as fuzzy', () => {
  // Real case: the catalogue says Monarda bradburiana, iNaturalist says bradburyana.
  const results = [{ id: 63314, name: 'Monarda bradburyana' }];
  assert.deepStrictEqual(E.pickTaxon('Monarda bradburiana', results), {
    taxonId: 63314, match: 'fuzzy', matchedName: 'Monarda bradburyana',
  });
});

test('two plausible fuzzy candidates is a no match, never a guess', () => {
  const results = [{ id: 1, name: 'Monarda bradburyana' }, { id: 2, name: 'Monarda bradburiona' }];
  assert.deepStrictEqual(E.pickTaxon('Monarda bradburiana', results), {
    taxonId: null, match: 'none', matchedName: null,
  });
});

test('a different genus never fuzzy matches however close the epithet', () => {
  const results = [{ id: 1, name: 'Pycnanthemum canadensis' }];
  assert.deepStrictEqual(E.pickTaxon('Aquilegia canadensis', results), {
    taxonId: null, match: 'none', matchedName: null,
  });
});

test('an empty result set is a no match', () => {
  assert.deepStrictEqual(E.pickTaxon('Aquilegia canadensis', []), {
    taxonId: null, match: 'none', matchedName: null,
  });
});

test('pickPhoto prefers the community default photo when it is usable', () => {
  const taxon = {
    default_photo: { id: 7, license_code: 'cc-by', attribution: '(c) A, CC BY', medium_url: 'https://x/7.jpg' },
    taxon_photos: [{ photo: { id: 9, license_code: 'cc0', attribution: '(c) B', medium_url: 'https://x/9.jpg' } }],
  };
  const got = E.pickPhoto(taxon);
  assert.strictEqual(got.photoId, 7);
  assert.strictEqual(got.licence, 'cc-by');
  assert.strictEqual(got.attribution, '(c) A, CC BY');
  assert.strictEqual(got.mediumUrl, 'https://x/7.jpg');
  assert.strictEqual(got.sourceUrl, 'https://www.inaturalist.org/photos/7');
});

test('pickPhoto falls back past a NonCommercial default photo', () => {
  const taxon = {
    default_photo: { id: 7, license_code: 'cc-by-nc', attribution: '(c) A', medium_url: 'https://x/7.jpg' },
    taxon_photos: [
      { photo: { id: 8, license_code: 'cc-by-nc-sa', attribution: '(c) B', medium_url: 'https://x/8.jpg' } },
      { photo: { id: 9, license_code: 'cc-by-sa', attribution: '(c) C', medium_url: 'https://x/9.jpg' } },
    ],
  };
  assert.strictEqual(E.pickPhoto(taxon).photoId, 9);
});

test('pickPhoto returns null when nothing is commercially usable', () => {
  // Seven real catalogue species are in exactly this position and still need
  // Jordan's own photography.
  const taxon = {
    default_photo: { id: 7, license_code: 'cc-by-nc', attribution: '(c) A', medium_url: 'https://x/7.jpg' },
    taxon_photos: [{ photo: { id: 8, license_code: 'cc-by-nc-nd', attribution: '(c) B', medium_url: 'https://x/8.jpg' } }],
  };
  assert.strictEqual(E.pickPhoto(taxon), null);
});

test('an absent establishment listing is unknown and never native', () => {
  // Measured on the live API: Monarda didyma returns native for PA, while
  // Asclepias syriaca, Quercus alba and Rudbeckia hirta return nothing at all
  // despite being unambiguously native. Rendering null as native would assert
  // something the data does not say.
  assert.strictEqual(E.establishmentLabel(null), 'unknown');
  assert.strictEqual(E.establishmentLabel(undefined), 'unknown');
  assert.strictEqual(E.establishmentLabel(''), 'unknown');
  assert.strictEqual(E.establishmentLabel('introduced'), 'introduced');
  assert.strictEqual(E.establishmentLabel('native'), 'native');
});
