const test = require('node:test');
const assert = require('node:assert');
require('../assets/plantings.js');
const P = globalThis.EcoPlantings;

// Deliberately arranged so that first-appearance order (Foam Flower, Wild
// Columbine, Butterfly Weed, American Plum) is NOT descending quantity order
// (40, 5, 2, 2). An unsorted breakdown therefore cannot pass by luck.
// Butterfly Weed and American Plum tie at 2 and appear in reverse alphabetical
// order, so the label tiebreak has to run to put American Plum first.
// The g2 Wild Columbine row was planted in 2025 but not typed in until January
// 2026, which is what makes the planted_on / created_at distinction testable.
const ROWS = [
  { gardenId: 'g1', speciesLabel: 'Foam Flower',    quantity: 5,  plantedOn: '2026-06-01', createdAt: '2026-06-02' },
  { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 12, plantedOn: '2026-05-04' },
  { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 8,  plantedOn: '2026-06-01' },
  { gardenId: 'g2', speciesLabel: 'Butterfly Weed', quantity: 2,  plantedOn: '2025-04-11' },
  { gardenId: 'g2', speciesLabel: 'Wild Columbine', quantity: 20, plantedOn: '2025-04-11', createdAt: '2026-01-14' },
  { gardenId: 'g2', speciesLabel: 'American Plum',  quantity: 2,  plantedOn: '2025-04-11' },
];

test('a species planted twice at one garden counts once as a species', () => {
  // The whole point of the distinct count. Counting rows would say 3 species here.
  const g1 = ROWS.filter(r => r.gardenId === 'g1');
  assert.deepStrictEqual(P.summarise(g1), { plants: 25, species: 2 });
});

test('the same species at two gardens counts once overall', () => {
  // 49 plants over 6 rows, but Wild Columbine appears at both gardens and is one
  // species, so the honest species figure is 4 and a row count would say 6.
  assert.deepStrictEqual(P.summarise(ROWS), { plants: 49, species: 4 });
});

test('summarising an empty list gives zeroes, not NaN', () => {
  assert.deepStrictEqual(P.summarise([]), { plants: 0, species: 0 });
  assert.deepStrictEqual(P.speciesBreakdown([]), []);
});

test('the year filter uses planted_on, not created_at', () => {
  // The 20 Wild Columbine went in the ground in April 2025 but were not entered
  // until January 2026. They belong to 2025. Reading created_at would move them
  // into 2026 and quietly restate two years of grant figures at once.
  assert.deepStrictEqual(P.summariseForYear(ROWS, 2026), { plants: 25, species: 2 });
  assert.deepStrictEqual(P.summariseForYear(ROWS, 2025), { plants: 24, species: 3 });
  assert.deepStrictEqual(P.summariseForYear(ROWS, 2024), { plants: 0, species: 0 });
});

test('species matching is case and whitespace insensitive', () => {
  // Staff typing 'wild columbine' must not create a second species.
  const rows = [
    { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 1, plantedOn: '2026-05-04' },
    { gardenId: 'g1', speciesLabel: '  wild columbine ', quantity: 1, plantedOn: '2026-05-04' },
  ];
  assert.strictEqual(P.summarise(rows).species, 1);
});

test('the breakdown is ordered by quantity, highest first', () => {
  // Note the fixture's first-appearance order is Foam Flower, Wild Columbine,
  // Butterfly Weed, American Plum, so this expectation can only be met by
  // actually sorting. The last two tie at 2 and are separated by label, so
  // dropping the tiebreak leaves them in the reverse of what is asserted.
  assert.deepStrictEqual(P.speciesBreakdown(ROWS), [
    { label: 'Wild Columbine', plants: 40 },
    { label: 'Foam Flower', plants: 5 },
    { label: 'American Plum', plants: 2 },
    { label: 'Butterfly Weed', plants: 2 },
  ]);
});

test('the breakdown keeps the first spelling it saw, not the lowercased key', () => {
  const rows = [
    { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 3, plantedOn: '2026-05-04' },
    { gardenId: 'g1', speciesLabel: 'wild columbine', quantity: 1, plantedOn: '2026-05-04' },
  ];
  assert.deepStrictEqual(P.speciesBreakdown(rows), [{ label: 'Wild Columbine', plants: 4 }]);
});

test('plantingLabel returns the stored label and never invents one', () => {
  assert.strictEqual(P.plantingLabel({ speciesLabel: 'Foam Flower' }), 'Foam Flower');
  // A row can never legally have a blank label; if one appears, say so rather than
  // rendering an empty cell that looks like a rendering bug.
  assert.strictEqual(P.plantingLabel({ speciesLabel: '' }), 'Unnamed planting');
  assert.strictEqual(P.plantingLabel({}), 'Unnamed planting');
});

test('a non-numeric or negative quantity contributes nothing rather than NaN', () => {
  // The negative row is the one that matters. Task 2's check (quantity > 0) stops
  // a negative reaching the table, but a staff form summarises draft rows before
  // any insert, and a -3 that merely dropped out of the sum would silently
  // subtract from a published total instead of being rejected.
  const rows = [
    { gardenId: 'g1', speciesLabel: 'A', quantity: null, plantedOn: '2026-01-01' },
    { gardenId: 'g1', speciesLabel: 'B', quantity: 5, plantedOn: '2026-01-01' },
    { gardenId: 'g1', speciesLabel: 'C', quantity: -3, plantedOn: '2026-01-01' },
    { gardenId: 'g1', speciesLabel: 'D', quantity: 'not a number', plantedOn: '2026-01-01' },
  ];
  assert.strictEqual(P.summarise(rows).plants, 5);
});
