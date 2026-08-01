const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../assets/pricing.js');
const { CARD_UPLIFT, cardCents, cardDollars, quoteTotals } = globalThis.EcoPricing;

test('CARD_UPLIFT is 4 percent', () => {
  assert.strictEqual(CARD_UPLIFT, 0.04);
});

test('the edge function mirrors CARD_UPLIFT exactly', () => {
  // The browser shows the uplifted price and the edge function charges it. If the two
  // copies ever drift, customers are quoted one number and charged another, which is the
  // exact failure this feature exists to prevent. Fail loudly instead.
  const edgePath = path.join(__dirname, '..', 'supabase', 'functions', 'square-pay', 'index.ts');
  const src = fs.readFileSync(edgePath, 'utf8');
  const m = src.match(/^const CARD_UPLIFT = ([0-9.]+);$/m);
  assert.ok(m, 'square-pay/index.ts must declare `const CARD_UPLIFT = <number>;`');
  assert.strictEqual(Number(m[1]), CARD_UPLIFT);
});

// The drift test that used to live here scraped the wildflower lead against
// `var PLANT_PRICE`. Both are gone: prices vary by size now, each size opens on its own
// season, so no static sentence can state a figure that stays true, and the card renders
// the pair from PLANT_SIZES instead. The drift guard is retargeted, not dropped: see
// 'plants.html states each size price and it matches the constant' below.

test('cardCents grosses every current shop price exactly', () => {
  assert.strictEqual(cardCents(500), 520);      // $5 plant
  assert.strictEqual(cardCents(7200), 7488);    // 50 sq ft kit
  assert.strictEqual(cardCents(14400), 14976);  // 100 sq ft kit
  assert.strictEqual(cardCents(20000), 20800);  // 150 sq ft kit
  assert.strictEqual(cardCents(25000), 26000);  // 200 sq ft kit
  assert.strictEqual(cardCents(4000), 4160);    // card game
});

test('cardCents rounds half-up to the nearest cent', () => {
  assert.strictEqual(cardCents(333), 346); // 346.32 rounds down
  assert.strictEqual(cardCents(338), 352); // 351.52 rounds up
  assert.strictEqual(cardCents(0), 0);
});

test('cardDollars grosses dollar amounts to the cent', () => {
  assert.strictEqual(cardDollars(10000), 10400);
  assert.strictEqual(cardDollars(675), 702);
  assert.strictEqual(cardDollars(0.13), 0.14);
});

test('quoteTotals computes the admin fee on the BASE subtotal', () => {
  const t = quoteTotals([{ amount: 10000 }], 0);
  assert.strictEqual(t.subtotal, 10000);
  assert.strictEqual(t.adminFee, 500);      // 5% of base, not of 10400
  assert.strictEqual(t.cardSubtotal, 10400);
  assert.strictEqual(t.cashTotal, 10500);
  assert.strictEqual(t.cardTotal, 10900);
});

test('cardSubtotal sums individually grossed lines so the column ties out', () => {
  // Per-line rounding deliberately differs from grossing the subtotal:
  // 0.13 -> 0.14 each, so 0.28, whereas round2(0.26 * 1.04) would be 0.27.
  const t = quoteTotals([{ amount: 0.13 }, { amount: 0.13 }], 0);
  assert.strictEqual(t.subtotal, 0.26);
  assert.strictEqual(t.cardSubtotal, 0.28);
});

test('the cash total for existing quote #1 is unchanged by this feature', () => {
  // Regression guard: draft quote #1 is $675 base with a $33.75 fee.
  const t = quoteTotals([{ amount: 675 }], 0);
  assert.strictEqual(t.cashTotal, 708.75); // exactly what quotes.total already holds
  assert.strictEqual(t.cardTotal, 735.75);
});

test('deposits carry the uplift and balances follow their own tender', () => {
  const t = quoteTotals([{ amount: 10000 }], 5000);
  assert.strictEqual(t.cashDeposit, 5000);
  assert.strictEqual(t.cardDeposit, 5200);
  assert.strictEqual(t.cashBalance, 5500);  // 10500 - 5000
  assert.strictEqual(t.cardBalance, 5700);  // 10900 - 5200
});

test('quoteTotals tolerates empty and null input', () => {
  const t = quoteTotals(null, 0);
  assert.strictEqual(t.subtotal, 0);
  assert.strictEqual(t.cardTotal, 0);
  const e = quoteTotals([], 0);
  assert.strictEqual(e.subtotal, 0);
  assert.strictEqual(e.cardSubtotal, 0);
  assert.strictEqual(e.cashTotal, 0);
  assert.strictEqual(e.cardTotal, 0);
});

test('quoteTotals prices around a null line item instead of throwing', () => {
  // line_items is raw jsonb and nothing constrains its entries. A single null used to
  // throw here, which blanked the staff quotes table and would blank a client's quote.
  const t = quoteTotals([{ amount: 100 }, null, { amount: 675 }], 0);
  assert.strictEqual(t.subtotal, 775);        // 100 + 675, the null contributes nothing
  assert.strictEqual(t.adminFee, 38.75);
  assert.strictEqual(t.cardSubtotal, 806);    // 104 + 702
  assert.strictEqual(t.cashTotal, 813.75);
  assert.strictEqual(t.cardTotal, 844.75);
});
