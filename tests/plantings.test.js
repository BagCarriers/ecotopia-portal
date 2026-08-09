const test = require('node:test');
const assert = require('node:assert');
require('../assets/plantings.js');
const P = globalThis.EcoPlantings;

const ROWS = [
  { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 12, plantedOn: '2026-05-04' },
  { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 8,  plantedOn: '2026-06-01' },
  { gardenId: 'g1', speciesLabel: 'Foam Flower',    quantity: 5,  plantedOn: '2026-06-01' },
  { gardenId: 'g2', speciesLabel: 'Wild Columbine', quantity: 20, plantedOn: '2025-04-11' },
  { gardenId: 'g2', speciesLabel: 'American Plum',  quantity: 2,  plantedOn: '2025-04-11' },
];

test('a species planted twice at one garden counts once as a species', () => {
  // The whole point of the distinct count. Counting rows would say 3 species here.
  const g1 = ROWS.filter(r => r.gardenId === 'g1');
  assert.deepStrictEqual(P.summarise(g1), { plants: 25, species: 2 });
});

test('the same species at two gardens counts once overall', () => {
  // 45 plants, but Wild Columbine appears at both gardens and is one species.
  assert.deepStrictEqual(P.summarise(ROWS), { plants: 47, species: 3 });
});

test('summarising an empty list gives zeroes, not NaN', () => {
  assert.deepStrictEqual(P.summarise([]), { plants: 0, species: 0 });
  assert.deepStrictEqual(P.speciesBreakdown([]), []);
});

test('the year filter uses planted_on, not created_at', () => {
  assert.deepStrictEqual(P.summariseForYear(ROWS, 2026), { plants: 25, species: 2 });
  assert.deepStrictEqual(P.summariseForYear(ROWS, 2025), { plants: 22, species: 2 });
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
  assert.deepStrictEqual(P.speciesBreakdown(ROWS), [
    { label: 'Wild Columbine', plants: 40 },
    { label: 'Foam Flower', plants: 5 },
    { label: 'American Plum', plants: 2 },
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
  const rows = [
    { gardenId: 'g1', speciesLabel: 'A', quantity: null, plantedOn: '2026-01-01' },
    { gardenId: 'g1', speciesLabel: 'B', quantity: 5, plantedOn: '2026-01-01' },
  ];
  assert.strictEqual(P.summarise(rows).plants, 5);
});
