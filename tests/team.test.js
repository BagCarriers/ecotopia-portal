const test = require('node:test');
const assert = require('node:assert');
require('../assets/team.js');
const { teamInitials, teamPhotoSrc } = globalThis.EcoTeam;

test('teamInitials takes the first and last word', () => {
  assert.strictEqual(teamInitials('Jordan Sesame Wild'), 'JW');
  assert.strictEqual(teamInitials('Jenna Rose Wild'), 'JW');
  assert.strictEqual(teamInitials('Kat Weakland'), 'KW');
});

test('teamInitials gives one letter for a single-word name', () => {
  assert.strictEqual(teamInitials('Brendan'), 'B');
});

test('teamInitials handles hyphens, extra spaces and case', () => {
  assert.strictEqual(teamInitials('mary-jane  o\'neill'), 'MO');
  assert.strictEqual(teamInitials('  Russ   Replogle  '), 'RR');
});

test('teamInitials is empty for empty or missing input', () => {
  assert.strictEqual(teamInitials(''), '');
  assert.strictEqual(teamInitials(null), '');
  assert.strictEqual(teamInitials(undefined), '');
});

test('teamPhotoSrc resolves a static: path to the repo folder', () => {
  const url = (p) => 'BUCKET/' + p;
  assert.strictEqual(teamPhotoSrc('static:team-jordan.jpg', url), 'assets/img/team/team-jordan.jpg');
});

test('teamPhotoSrc refuses a static: path that tries to escape the folder', () => {
  const url = (p) => 'BUCKET/' + p;
  assert.strictEqual(teamPhotoSrc('static:../../etc/passwd', url), null);
  assert.strictEqual(teamPhotoSrc('static:a/b.jpg', url), null);
  // A browser treats a backslash as a path separator in an http(s) URL, so a charset
  // that allowed it would escape the folder just as a forward slash would.
  assert.strictEqual(teamPhotoSrc('static:x\\y.jpg', url), null);
  // The guard must anchor to end of input, not end of line: with the regex 'm' flag a
  // trailing newline would let anything after it through.
  assert.strictEqual(teamPhotoSrc('static:x.jpg\n', url), null);
});

test('teamPhotoSrc sends any other value to the bucket', () => {
  const url = (p) => 'BUCKET/' + p;
  assert.strictEqual(teamPhotoSrc('team/abc-123.jpg', url), 'BUCKET/team/abc-123.jpg');
});

test('teamPhotoSrc returns null when there is no photo', () => {
  const url = (p) => 'BUCKET/' + p;
  assert.strictEqual(teamPhotoSrc(null, url), null);
  assert.strictEqual(teamPhotoSrc('', url), null);
});
