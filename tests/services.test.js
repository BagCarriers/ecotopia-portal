/**
 * Service card photo path resolution.
 *
 * Frank (2026-08-23): Jordan should be able to change the homepage service card
 * photos himself. That means the path stops being a literal in index.html and
 * starts being a value out of the database, which is exactly when the charset
 * guard starts mattering.
 *
 * Mirrors tests/team.test.js, because servicePhotoSrc mirrors teamPhotoSrc.
 */
const test = require('node:test');
const assert = require('node:assert');
require('../assets/services.js');
const S = globalThis.EcoServices;

const bucket = (p) => 'https://bucket.example/' + p;

test('a static: path resolves into the services folder', () => {
  assert.strictEqual(S.servicePhotoSrc('static:tree-nets.jpg', bucket),
    'assets/img/services/tree-nets.jpg');
});

test('a static: path cannot escape the services folder', () => {
  // The whole reason for the guard: this value now comes out of a table.
  for (const bad of ['static:../team/frank.jpg', 'static:/etc/passwd',
                     'static:sub/dir.jpg', 'static:a\\b.jpg']) {
    assert.strictEqual(S.servicePhotoSrc(bad, bucket), null, bad + ' was allowed');
  }
});

test('a static: value that is only dots is not a filename', () => {
  // '.' and '..' pass a naive [A-Za-z0-9._-] guard because it allows '.', and
  // neither escapes the folder, but both name a directory. Rendering them gives a
  // broken image instead of the bundled fallback.
  assert.strictEqual(S.servicePhotoSrc('static:.', bucket), null);
  assert.strictEqual(S.servicePhotoSrc('static:..', bucket), null);
});

test('anything that is not static: is a gallery-bucket object', () => {
  assert.strictEqual(S.servicePhotoSrc('services/abc-123.jpg', bucket),
    'https://bucket.example/services/abc-123.jpg');
});

test('no photo resolves to null rather than a broken src', () => {
  // The card keeps the hardcoded <img src> it shipped with, so null must mean
  // "leave the markup alone", never "blank the image".
  assert.strictEqual(S.servicePhotoSrc(null, bucket), null);
  assert.strictEqual(S.servicePhotoSrc('', bucket), null);
  assert.strictEqual(S.servicePhotoSrc(undefined, bucket), null);
});
