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
  // Already carries an approved iNaturalist photo: leave it alone. photoPath is null
  // here, so the prior decision and not the path is what refuses the row.
  assert.strictEqual(E.canAutoFill({ photoPath: null, inatPhotoId: 99, inatPhotoStatus: 'approved' }), false);
  // The same row once the photo pass has also written its path.
  assert.strictEqual(E.canAutoFill({ photoPath: 'plants/x.jpg', inatPhotoId: 99, inatPhotoStatus: 'approved' }), false);
});

test('any prior iNaturalist decision makes a row ineligible, not only a rejection', () => {
  // An inat_photo_id means this row has already been through the pipeline. Only a
  // row with no photo and no prior decision is eligible, so the guard cannot rely
  // on some later pass happening to write photo_path at the same time.
  assert.strictEqual(E.canAutoFill({ photoPath: null, inatPhotoId: 99, inatPhotoStatus: 'approved' }), false);
  assert.strictEqual(E.canAutoFill({ photoPath: null, inatPhotoId: 99, inatPhotoStatus: 'pending' }), false);
  assert.strictEqual(E.canAutoFill({ photoPath: null, inatPhotoId: 99, inatPhotoStatus: null }), false);
  // A rejection with no id is still refused, so neither field alone carries the guard.
  assert.strictEqual(E.canAutoFill({ photoPath: null, inatPhotoId: null, inatPhotoStatus: 'rejected' }), false);
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

test('pickPhoto can return a usable licence with no attribution at all', () => {
  // iNaturalist does return this shape. CC-BY and CC-BY-SA both require visible
  // credit, so the photo pass must refuse it rather than put an uncreditable
  // image on the storefront. pickPhoto reports the fact; the caller decides.
  const taxon = {
    default_photo: { id: 7, license_code: 'cc-by', attribution: '', medium_url: 'https://x/7.jpg' },
  };
  assert.strictEqual(E.pickPhoto(taxon).attribution, '');
  assert.strictEqual(E.pickPhoto({
    default_photo: { id: 8, license_code: 'cc0', medium_url: 'https://x/8.jpg' },
  }).attribution, '');
});

test('the photo pass gates on the shared guard and on attribution', () => {
  // Both of these have been got wrong once. An inline photo_path test is weaker
  // than canAutoFill, because it lets through a row carrying a bare
  // inat_photo_id left behind by a staff rejection; and a non-null pickPhoto
  // result is not on its own enough to store.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'inat-sync', 'index.ts'), 'utf8');
  // Matching the bare name would be satisfied by the destructure line alone, so
  // the gate could be deleted and the test would still pass. Match the call in
  // its refusing position instead.
  assert.match(src, /if \(!canAutoFill\(/,
    'the photo pass must refuse a row by calling the shared eligibility guard');
  // Any restatement of the rule, however it is spelled. A loose equals, a
  // double equals or extra spacing all evade a check for one exact string.
  assert.ok(!/inat_photo_status\s*={2,3}\s*'rejected'/.test(src),
    'index.ts must not restate the eligibility rule inline');
  assert.match(src, /noAttribution/, 'a photo with no attribution must be counted and refused');
  // A refused UPDATE reports error: null, so the rows must be asked for or a
  // write the database guard rejected is counted as a fill.
  assert.match(src, /\.is\('photo_path', null\)\.is\('inat_photo_id', null\)\.select\(/,
    'the UPDATE must mirror canAutoFill at the database and return the rows it wrote');
  assert.match(src, /skippedRaced/, 'a refused UPDATE must be counted apart from a fill');
});

test('the edge function does not reimplement the shared logic', () => {
  // There is exactly one implementation, in _shared/inat-logic.js. A second copy
  // inside index.ts would be dead code that the tests do not cover and that can
  // silently diverge from what actually runs.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'inat-sync', 'index.ts'), 'utf8');
  assert.match(src, /import '\.\.\/_shared\/inat-logic\.js'/,
    'index.ts must import the shared logic for its side effect');
  for (const name of ['function levenshtein', 'function pickTaxon', 'function pickPhoto',
                      'const PHOTO_LICENCES']) {
    assert.ok(!src.includes(name), `index.ts must not redeclare ${name}`);
  }
});

// ── Public photo credit (plants.html) ──────────────────────────────────────
// CC-BY and CC-BY-SA require the credit to be visible wherever the photograph is,
// so showsInatPhoto is a licence gate, not a cosmetic one. It lives inline in
// plants.html because that page loads no data.js, so the test reads it back out of
// the file the browser runs, the same way the PLANT_SIZES drift test does.
function plantsSource() {
  const fs = require('node:fs');
  const path = require('node:path');
  return fs.readFileSync(path.join(__dirname, '..', 'plants.html'), 'utf8');
}
function extractFn(name) {
  const m = plantsSource().match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}'));
  assert.ok(m, name + ' not found in plants.html');
  return m[0];
}
function loadShowsInatPhoto() {
  // eval, deliberately: the input is a function declaration read out of a file in
  // this repo, never user or network input, and the point is to exercise exactly
  // what the browser evaluates.
  return eval('(' + extractFn('showsInatPhoto').replace('function showsInatPhoto', 'function') + ')');
}
// new Function, deliberately, for the same reason as the eval above: the body is a
// function declaration read out of a file in this repo, never user or network input,
// and evaluating what the browser evaluates is the whole point of the test.
// The renderer, wired to the same two things the page wires it to: EcoSite.esc,
// which plants.html aliases as `esc` at line 444, and showsInatPhoto. Running the
// real escaper rather than a copy is the point, since the copy could be right while
// the one that ships is not.
function loadPhotoCreditHtml() {
  const path = require('node:path');
  const esc = require(path.join(__dirname, '..', 'assets', 'site.js')).EcoSite.esc;
  return new Function('esc',
    extractFn('showsInatPhoto') + '\n' + extractFn('photoCreditHtml') +
    '\nreturn photoCreditHtml;')(esc);
}

test('a rejected row shows no credit even though it keeps every credit field', () => {
  // THE case this gate exists for. rejectInatPhoto clears photo_path and keeps
  // inat_photo_id, inat_photo_attribution and inat_photo_source_url so the sync
  // never proposes that photo again. A credit keyed off the iNaturalist columns
  // alone would print a photographer's name under a card with no photograph, and,
  // once staff upload a replacement, under somebody else's work.
  const shows = loadShowsInatPhoto();
  const rejected = { photoPath: null, inatPhotoId: 99, inatPhotoStatus: 'rejected',
                     inatPhotoAttribution: '(c) A Stranger, some rights reserved (CC BY)' };
  assert.strictEqual(shows(rejected, null), false);
  // The same row after staff uploaded their own replacement photograph.
  assert.strictEqual(
    shows({ ...rejected, photoPath: 'plants/staff.jpg' }, 'https://x/plants/staff.jpg'), false);
});

test('a credit is shown only when an iNaturalist photograph is on screen', () => {
  const shows = loadShowsInatPhoto();
  const inat = { photoPath: 'plants/abc.jpg', inatPhotoId: 99, inatPhotoStatus: 'auto' };
  assert.strictEqual(shows(inat, 'https://x/plants/abc.jpg'), true);
  assert.strictEqual(shows({ ...inat, inatPhotoStatus: 'approved' }, 'https://x/plants/abc.jpg'), true);
  // No src: the card renders no image, so there is nothing to credit. This also
  // covers a photo_path that plantPhotoSrc refused.
  assert.strictEqual(shows(inat, null), false);
  // Jordan's own work, in both of its forms.
  assert.strictEqual(shows(
    { photoPath: 'static:wild-columbine.jpg', inatPhotoId: null, inatPhotoStatus: null },
    'assets/img/plants/wild-columbine.jpg'), false);
  assert.strictEqual(shows(
    { photoPath: 'plants/jordan.jpg', inatPhotoId: null, inatPhotoStatus: null },
    'https://x/plants/jordan.jpg'), false);
});

test('the rendered credit escapes the attribution, which is third-party text', () => {
  // Run the renderer, do not regex for esc(). A test that only greps the source
  // passes on a page that greps clean and still injects.
  const credit = loadPhotoCreditHtml();
  const html = credit({
    photoPath: 'plants/abc.jpg', inatPhotoId: 99, inatPhotoStatus: 'auto',
    inatPhotoAttribution: '<img src=x onerror=alert(1)> "q" & \'a\'',
  }, 'https://x/plants/abc.jpg');
  assert.ok(!/<img/.test(html), 'the attribution must not produce an element');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &quot;q&quot; &amp; &#39;a&#39;/);
});

test('the credit renders nothing at all when there is nothing to credit', () => {
  const credit = loadPhotoCreditHtml();
  // The rejected shape: every credit field present, no photograph.
  assert.strictEqual(credit({
    photoPath: null, inatPhotoId: 99, inatPhotoStatus: 'rejected',
    inatPhotoAttribution: '(c) Somebody, some rights reserved (CC BY)',
  }, null), '');
  // An iNaturalist photo with no attribution recorded. inat-sync refuses to store
  // one, so this should be unreachable, but an empty credit line is worse than none.
  assert.strictEqual(credit({
    photoPath: 'plants/abc.jpg', inatPhotoId: 99, inatPhotoStatus: 'auto',
    inatPhotoAttribution: null,
  }, 'https://x/plants/abc.jpg'), '');
});

test('the credit links the source photo, and only over https', () => {
  // CC BY 4.0 3(a)(1) asks for a link to the licensed material where practicable.
  const credit = loadPhotoCreditHtml();
  const row = (url) => ({
    photoPath: 'plants/abc.jpg', inatPhotoId: 99, inatPhotoStatus: 'auto',
    inatPhotoAttribution: '(c) A Photographer, some rights reserved (CC BY)',
    inatPhotoSourceUrl: url,
  });
  const src = 'https://x/plants/abc.jpg';
  assert.match(credit(row('https://www.inaturalist.org/photos/99'), src),
    /<a href="https:\/\/www\.inaturalist\.org\/photos\/99" target="_blank" rel="noopener noreferrer">/);
  // Anything that is not plainly https falls back to text, so a stored value can
  // never become an executable href.
  for (const bad of ['javascript:alert(1)', 'http://x/1', 'data:text/html,x', '', null]) {
    const html = credit(row(bad), src);
    assert.ok(!/<a /.test(html), 'must not link ' + String(bad));
    assert.match(html, /^<p class="photo-credit">\(c\) A Photographer/);
  }
});

test('renderPlants actually puts the credit on the card', () => {
  // THE wiring test. Every other test here exercises the credit in isolation, so
  // deleting the call from the card template used to leave the suite green while
  // shipping exactly the failure this feature exists to prevent: an iNaturalist
  // photograph on the storefront with no credit under it.
  const body = plantsSource().match(/function renderPlants\(\) \{[\s\S]*?\n  \}/);
  assert.ok(body, 'renderPlants not found in plants.html');
  assert.match(body[0], /photoCreditHtml\(p, src\)/,
    'the card template must call photoCreditHtml, or photos ship uncredited');
  // Under the photo, before the name, so the credit reads as belonging to the image.
  const img = body[0].indexOf('img class="plant-photo"');
  const cred = body[0].indexOf('photoCreditHtml(p, src)');
  assert.ok(img !== -1 && cred > img, 'the credit must follow the image it belongs to');
});

test('the credit is styled visibly, per the licence', () => {
  const css = plantsSource().match(/\.photo-credit \{[\s\S]*?\}/);
  assert.ok(css, '.photo-credit must be styled');
  // A credit nobody can read discharges nothing. This is a floor, not a substitute
  // for looking at the page: a later override elsewhere would still pass.
  const hidden = [
    /display:\s*none/, /visibility:\s*hidden/,
    /opacity:\s*0(?![.\d])/, /font-size:\s*0(?![.\d])/,
    /position:\s*(absolute|fixed)/,
  ];
  for (const rx of hidden) {
    assert.ok(!rx.test(css[0]), 'the credit must not be hidden: ' + rx);
  }
});
