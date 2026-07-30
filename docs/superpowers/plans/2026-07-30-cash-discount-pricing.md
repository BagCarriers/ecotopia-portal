# Cash-Discount Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 4% card cost into every displayed price so paying by cash or check returns the customer to the base price.

**Architecture:** A single browser-side pricing module (`assets/pricing.js`, following the existing `assets/mapping.js` pattern) owns the uplift math and is consumed by every page that shows a price. The `square-pay` edge function carries the only other copy of the rate, because it is the server-side charging authority. Base amounts stay in the database; the uplift is applied at display time and at charge time.

**Tech Stack:** Static HTML, no build. Vanilla JS browser globals. Supabase Postgres + Deno edge functions. `node --test` for the test suite.

## Global Constraints

- **No em dashes anywhere**, in code, comments, copy, or commit messages.
- `esc()` every DB or anon-supplied string interpolated into `innerHTML`.
- Migrations are applied live via the Management API, so `schema_migrations` stays empty. Run `supabase migration repair --status applied 27` before any future `db push`.
- The card uplift rate is `0.04` and lives in exactly two places: `assets/pricing.js` and `supabase/functions/square-pay/index.ts`.
- The 5% administration fee computes on the **base** subtotal, never the grossed one.
- The fee line reads **"Administration"**, never "Processing and administration".
- Never print a discount percentage in customer-facing copy. Show two prices.
- Edge function deploys use `--no-verify-jwt --project-ref wibnryfinfwbwwgsyojr`.

## Refinement to the spec

The spec says "stored values stay base, nothing in the database is grossed." Implementing it revealed that `order.html` needs to display an amount due and the webhook needs an expected amount to compare against, so a grossed number has to be persisted somewhere.

Resolved by **keeping `orders.subtotal_cents` as base (meaning unchanged, no backfill)** and adding a separate `charge_cents` column for the amount actually charged. This drops the `base_subtotal_cents` column the spec proposed, which would have been redundant. Three new order columns instead of three, same count, cleaner semantics.

## File Structure

| File | Responsibility |
|---|---|
| `assets/pricing.js` (create) | The uplift and admin-fee math. Sole browser-side authority. |
| `tests/pricing.test.js` (create) | Unit tests for that math. |
| `supabase/migrations/0027_cash_discount.sql` (create) | `orders.charge_cents` / `tender` / `amount_collected_cents`, `quotes.deposit_tender`. |
| `supabase/functions/square-pay/index.ts` (modify) | Server-side charging authority: price by `pay_mode`, tender on mark-paid, amount capture in the webhook. |
| `quotes.html` (modify) | Portal quote builder: five totals, renamed fee line. |
| `quote-view.html`, `quote-print.html` (modify) | Client-facing quote: grossed line items, two totals. |
| `plants.html`, `shop.html` (modify) | Public shop: two prices per item. |
| `order.html` (modify) | Public order status: two prices for pickup. |
| `orders.html` (modify) | Portal orders: tender picker on Mark paid. |
| `docs/OPERATIONS.md` (modify) | Document the rate mirrors and the tender flow. |

## Where the spec's six tests actually live

The spec lists six tests under `npm test`. Four of them are pure math and run there (Task 1). The other two exercise the Deno edge function, which the node runner cannot load, so they are verified against the live sandbox instead:

| Spec test | Where |
|---|---|
| 1. Per-line gross-up | `npm test`, Task 1 |
| 2. `cardSubtotal` tie-out | `npm test`, Task 1 |
| 3. Admin fee on base | `npm test`, Task 1 |
| 4. Cash total regression on quote #1 | `npm test`, Task 1 |
| 5. `staff_mark_paid` amount per tender | Live sandbox, Task 4 Step 4 |
| 6. `create_order` price per `pay_mode` | Live sandbox, Task 3 Step 6 |

This is a real coverage difference, not an equivalent substitute: 5 and 6 only run when someone runs them, so they are repeated in the Task 9 end-to-end pass.

---

### Task 1: Pricing module

**Files:**
- Create: `assets/pricing.js`
- Test: `tests/pricing.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `globalThis.EcoPricing` with `CARD_UPLIFT` (number `0.04`), `ADMIN_FEE_RATE` (number `0.05`), `cardCents(baseCents: number) -> number`, `cardDollars(baseDollars: number) -> number`, and `quoteTotals(lineItems: Array<{amount: number}>, deposit: number) -> {subtotal, adminFee, cardSubtotal, cashTotal, cardTotal, cashDeposit, cardDeposit, cashBalance, cardBalance}` (all numbers, dollars).

- [ ] **Step 1: Write the failing test**

Create `tests/pricing.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
require('../assets/pricing.js');
const { CARD_UPLIFT, cardCents, cardDollars, quoteTotals } = globalThis.EcoPricing;

test('CARD_UPLIFT is 4 percent', () => {
  assert.strictEqual(CARD_UPLIFT, 0.04);
});

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: FAIL, `Cannot find module '../assets/pricing.js'`

- [ ] **Step 3: Write the implementation**

Create `assets/pricing.js`:

```js
/**
 * Ecotopia Portal - cash-discount pricing.
 * Displayed prices carry the card cost; cash and check pay the base price.
 * Loadable in the browser (script tag) and in Node (require) for tests.
 *
 * CARD_UPLIFT is mirrored in supabase/functions/square-pay/index.ts, which is the
 * server-side charging authority. Those two are the only copies. See docs/OPERATIONS.md.
 */
(function (root) {
  const CARD_UPLIFT = 0.04;
  const ADMIN_FEE_RATE = 0.05;

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  // Integer cents to integer cents, half-up. No integer input can land on an exact
  // half-cent (that would need a fractional base), so the tie case cannot occur.
  function cardCents(baseCents) {
    return Math.round((Number(baseCents) || 0) * (1 + CARD_UPLIFT));
  }

  // Dollars to dollars, half-up to the cent.
  function cardDollars(baseDollars) {
    return round2((Number(baseDollars) || 0) * (1 + CARD_UPLIFT));
  }

  // lineItems carry BASE dollar amounts, exactly as staff enter them.
  function quoteTotals(lineItems, deposit) {
    const items = lineItems || [];
    const subtotal = round2(items.reduce((s, li) => s + (Number(li.amount) || 0), 0));
    const adminFee = round2(subtotal * ADMIN_FEE_RATE);
    // Sum of individually grossed lines, NOT cardDollars(subtotal): the client sees the
    // grossed line items, so the printed column has to add up to the total beneath it.
    const cardSubtotal = round2(items.reduce((s, li) => s + cardDollars(li.amount), 0));
    const cashTotal = round2(subtotal + adminFee);
    const cardTotal = round2(cardSubtotal + adminFee);
    const cashDeposit = round2(Number(deposit) || 0);
    const cardDeposit = cardDollars(cashDeposit);
    return {
      subtotal, adminFee, cardSubtotal, cashTotal, cardTotal,
      cashDeposit, cardDeposit,
      cashBalance: round2(cashTotal - cashDeposit),
      cardBalance: round2(cardTotal - cardDeposit),
    };
  }

  root.EcoPricing = { CARD_UPLIFT, ADMIN_FEE_RATE, cardCents, cardDollars, quoteTotals };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all pricing tests plus the 5 pre-existing mapping tests.

- [ ] **Step 5: Commit**

```bash
git add assets/pricing.js tests/pricing.test.js
git commit -m "feat: pricing module for cash-discount card uplift"
```

---

### Task 2: Migration 0027

**Files:**
- Create: `supabase/migrations/0027_cash_discount.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `orders.charge_cents` (integer), `orders.tender` (text, `cash`/`check`/`card`), `orders.amount_collected_cents` (integer), `quotes.deposit_tender` (text, same enum).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0027_cash_discount.sql`:

```sql
-- 0027: cash-discount pricing.
-- Displayed prices carry a 4 percent card uplift; cash and check pay base.
-- orders.subtotal_cents KEEPS its meaning (base, un-grossed) so no backfill is needed.
-- charge_cents is what we actually charge for the chosen pay_mode.

alter table public.orders
  add column if not exists charge_cents integer,
  add column if not exists tender text,
  add column if not exists amount_collected_cents integer;

alter table public.orders
  drop constraint if exists orders_tender_chk;
alter table public.orders
  add constraint orders_tender_chk
  check (tender is null or tender in ('cash', 'check', 'card'));

-- Any order created before this deploy was priced at base with no uplift.
-- (Verified zero rows on 2026-07-30; this is a safety net, not a real backfill.)
update public.orders set charge_cents = subtotal_cents where charge_cents is null;

alter table public.quotes
  add column if not exists deposit_tender text;

alter table public.quotes
  drop constraint if exists quotes_deposit_tender_chk;
alter table public.quotes
  add constraint quotes_deposit_tender_chk
  check (deposit_tender is null or deposit_tender in ('cash', 'check', 'card'));

-- No new RLS policies. orders has no anon policies; only the square-pay edge function
-- (service role) and staff writes reach these columns. quotes is staff-only plus the
-- existing token-gated security-definer RPCs.
```

- [ ] **Step 2: Apply it live via the Management API**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
python3 - <<'PY'
import json, subprocess, urllib.request
tok = subprocess.check_output(['security','find-generic-password','-s','Supabase CLI','-w']).decode().strip()
sql = open('supabase/migrations/0027_cash_discount.sql').read()
req = urllib.request.Request(
  'https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query',
  data=json.dumps({'query': sql}).encode(),
  headers={'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'})
print(urllib.request.urlopen(req).read().decode())
PY
```

Expected: `[]` (DDL returns no rows).

- [ ] **Step 3: Verify the columns landed**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"select column_name from information_schema.columns where table_name='"'"'orders'"'"' and column_name in ('"'"'charge_cents'"'"','"'"'tender'"'"','"'"'amount_collected_cents'"'"') order by column_name;"}'
```

Expected: three rows, `amount_collected_cents`, `charge_cents`, `tender`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0027_cash_discount.sql
git commit -m "feat: migration 0027, tender and charge columns for cash discount"
```

---

### Task 3: Edge function order pricing

**Files:**
- Modify: `supabase/functions/square-pay/index.ts` (constants block near line 32, `handleCreateOrder` around lines 241-374)

**Interfaces:**
- Consumes: `orders.charge_cents` from Task 2.
- Produces: `create_order` responses unchanged in shape (`{token}`, `{token, pay_url}`, `{token, configured:false}`) but priced by `pay_mode`. New module-level `CARD_UPLIFT` and `cardCents(baseCents: number) -> number` in the edge function.

- [ ] **Step 1: Add the rate mirror and helper**

In `supabase/functions/square-pay/index.ts`, directly below the `KIT_TIERS` block (currently ending line 38):

```ts
// Card uplift: displayed prices carry the card cost, cash and check pay base.
// MIRRORED in assets/pricing.js. These two are the only authorities. Keep in sync.
const CARD_UPLIFT = 0.04;

// Integer cents to integer cents, half-up.
function cardCents(baseCents: number): number {
  return Math.round((Number(baseCents) || 0) * (1 + CARD_UPLIFT));
}
```

- [ ] **Step 2: Price the order by pay_mode**

In `handleCreateOrder`, replace the insert block (currently lines 317-332) with:

```ts
  const token = newOrderToken();
  // subtotal_cents stays BASE. charge_cents is what we actually take.
  const chargeCents = payMode === 'online' ? cardCents(subtotal) : subtotal;
  const { data: inserted, error: insErr } = await sb.from('orders').insert({
    order_token: token,
    customer_name: name,
    phone: phone || null,
    email: email || null,
    items: lines,
    subtotal_cents: subtotal,
    charge_cents: chargeCents,
    status: 'new',
    pay_mode: payMode,
    note: note || null,
  }).select('id').single();
  if (insErr || !inserted) return json({ error: 'Could not save the order.' }, 500);

  // Pickup, or a zero-total order: nothing to charge, done.
  if (payMode !== 'online' || chargeCents <= 0) return json({ token }, 200);
```

- [ ] **Step 3: Mint the Square link for the charge amount**

In the same function, in the `quick_pay` body (currently line 353), change the amount from the base subtotal to the charge amount:

```ts
        quick_pay: {
          name: linkName,
          price_money: { amount: chargeCents, currency: 'USD' },
          location_id: locationId,
        },
```

- [ ] **Step 4: Return the charge amount from order_status**

In `handleOrderStatus` (currently lines 377-393), add `charge_cents` to the select and the response so `order.html` can show both prices:

```ts
  const { data: order } = await sb.from('orders')
    .select('status, items, subtotal_cents, charge_cents, pay_mode, square_pay_url, created_at')
    .eq('order_token', token).maybeSingle();
  if (!order) return json({ error: 'Not found' }, 404);
  return json({
    status: order.status,
    items: order.items,
    subtotal_cents: order.subtotal_cents,
    charge_cents: order.charge_cents,
    pay_mode: order.pay_mode,
    pay_url: order.square_pay_url || null,
    created_at: order.created_at,
  }, 200);
```

- [ ] **Step 5: Deploy**

```bash
supabase functions deploy square-pay --no-verify-jwt --project-ref wibnryfinfwbwwgsyojr
```

Expected: `"message":"Deployed Functions."`

- [ ] **Step 6: Verify both pay modes against the live sandbox**

```bash
SPECIES=98976158-6ad9-424e-a5a3-a58179c76c98  # Woodland Phlox, $5
FN=https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/square-pay
echo "--- online (expect charge 1040 for 2 plants) ---"
curl -s -X POST $FN -H 'Content-Type: application/json' \
 -d "{\"action\":\"create_order\",\"customer\":{\"name\":\"ZZ UPLIFT ONLINE\"},\"pay_mode\":\"online\",\"items\":[{\"kind\":\"species\",\"id\":\"$SPECIES\",\"qty\":2}]}"
echo; echo "--- pickup (expect charge 1000) ---"
curl -s -X POST $FN -H 'Content-Type: application/json' \
 -d "{\"action\":\"create_order\",\"customer\":{\"name\":\"ZZ UPLIFT PICKUP\"},\"pay_mode\":\"pickup\",\"items\":[{\"kind\":\"species\",\"id\":\"$SPECIES\",\"qty\":2}]}"
```

Then confirm the stored numbers:

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"select customer_name, pay_mode, subtotal_cents, charge_cents from orders where customer_name like '"'"'ZZ UPLIFT%'"'"' order by customer_name;"}'
```

Expected: online row `subtotal_cents 1000, charge_cents 1040`; pickup row `1000, 1000`.

- [ ] **Step 7: Delete the test rows**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"delete from orders where customer_name like '"'"'ZZ %'"'"' returning customer_name;"}'
```

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/square-pay/index.ts
git commit -m "feat: charge the card price for online orders, base for pickup"
```

---

### Task 4: Tender on mark-paid, amount capture in the webhook

**Files:**
- Modify: `supabase/functions/square-pay/index.ts` (`handleWebhook` around lines 101-144, `handleStaffMarkPaid` around lines 399-439)

**Interfaces:**
- Consumes: `cardCents` from Task 3; `orders.tender` / `amount_collected_cents` from Task 2.
- Produces: `staff_mark_paid` now requires `tender` in the body (`'cash' | 'check' | 'card'`) and returns `{ok: true, status: 'paid', collected_cents: number}` or `400 {error:'bad_tender'}`. The webhook records `amount_collected_cents` and sets `tender: 'card'`.

- [ ] **Step 1: Require and honour tender in staff_mark_paid**

In `handleStaffMarkPaid`, replace the order lookup and transition block (currently lines 426-438) with:

```ts
  const orderId = typeof body?.order_id === 'string' ? body.order_id : '';
  if (!orderId) return json({ error: 'missing_order_id' }, 400);
  const tender = body?.tender;
  if (tender !== 'cash' && tender !== 'check' && tender !== 'card') {
    return json({ error: 'bad_tender' }, 400);
  }
  const { data: order } = await sb.from('orders')
    .select('id, status, items, subtotal_cents').eq('id', orderId).maybeSingle();
  if (!order) return json({ error: 'Not found' }, 404);
  // Idempotent: only decrement stock on the first transition into 'paid'.
  if (order.status === 'new' || order.status === 'link_created') {
    // Card at the table costs us the fee, so it pays the card price. Cash and check
    // pay base. subtotal_cents is always base, so this is the whole rule.
    const collected = tender === 'card' ? cardCents(order.subtotal_cents) : order.subtotal_cents;
    await sb.from('orders').update({
      status: 'paid',
      tender,
      amount_collected_cents: collected,
    }).eq('id', order.id);
    await decrementOrderStock(sb, order.items);
    return json({ ok: true, status: 'paid', collected_cents: collected }, 200);
  }
  // No transition (already paid, cancelled, completed...): report the truth.
  return json({ ok: false, status: order.status }, 409);
```

- [ ] **Step 2: Record the paid amount in the webhook**

In `handleWebhook`, capture the amount alongside the order id (replacing the extraction at lines 114-121):

```ts
  const payment = event?.data?.object?.payment;
  const type = event?.type;
  const status = payment?.status;
  const orderId = payment?.order_id;
  const paidCents = Number(payment?.amount_money?.amount);
  // Only a completed payment on a known order matters; everything else is a fast no-op.
  if (type !== 'payment.updated' || status !== 'COMPLETED' || !orderId) {
    return json({ ok: true }, 200);
  }
```

Then replace the quote branch (lines 124-131) with:

```ts
  const sb = admin();
  const { data: quote } = await sb.from('quotes').select('id, deposit_status')
    .eq('square_order_id', orderId).maybeSingle();
  if (quote) {
    if (quote.deposit_status !== 'paid') {
      await sb.from('quotes').update({
        deposit_status: 'paid',
        deposit_tender: 'card',
      }).eq('id', quote.id);
    }
    return json({ ok: true }, 200);
  }
```

And the order branch (lines 134-143) with:

```ts
  // No quote matched: this may be one of our shop/plant orders instead.
  const { data: order } = await sb.from('orders')
    .select('id, status, items, charge_cents').eq('square_order_id', orderId).maybeSingle();
  if (!order) return json({ ok: true }, 200); // unknown order -> no-op
  // Idempotent: only 'new'/'link_created' transitions to 'paid' + decrements stock.
  // 'paid' or any later status is a no-op, so stock is never decremented twice.
  if (order.status === 'new' || order.status === 'link_created') {
    // Record what Square actually took. A mismatch against charge_cents still marks the
    // order paid (refusing would strand real money) but is noted for staff review, so a
    // divergence between charged and recorded can never pass silently.
    const collected = Number.isFinite(paidCents) ? paidCents : null;
    const mismatch = collected != null && order.charge_cents != null
      && collected !== order.charge_cents;
    const patch: Record<string, unknown> = {
      status: 'paid',
      tender: 'card',
      amount_collected_cents: collected,
    };
    if (mismatch) {
      patch.note = `AMOUNT MISMATCH: expected ${order.charge_cents}, Square collected ${collected}. Review before fulfilling.`;
    }
    await sb.from('orders').update(patch).eq('id', order.id);
    await decrementOrderStock(sb, order.items);
  }
  return json({ ok: true }, 200);
```

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy square-pay --no-verify-jwt --project-ref wibnryfinfwbwwgsyojr
```

- [ ] **Step 4: Verify the webhook records the amount and flags a mismatch**

Reuse the signing helper. Create `/tmp/wh.py`:

```python
import hmac, hashlib, base64, json, sys, urllib.request
URL = 'https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/square-pay'
KEY = b'nygJAid4BVS895i6uPzjNg'
order_id, amount = sys.argv[1], int(sys.argv[2])
body = {"type": "payment.updated", "data": {"object": {"payment": {
    "status": "COMPLETED", "order_id": order_id,
    "amount_money": {"amount": amount, "currency": "USD"}}}}}
raw = json.dumps(body, separators=(',', ':'))
sig = base64.b64encode(hmac.new(KEY, (URL + raw).encode(), hashlib.sha256).digest()).decode()
req = urllib.request.Request(URL, data=raw.encode(), headers={
    'Content-Type': 'application/json', 'x-square-hmacsha256-signature': sig})
print(urllib.request.urlopen(req).status, urllib.request.urlopen(req).read().decode())
```

Create an online order, fire a **correct** amount (1040), confirm `amount_collected_cents = 1040`, `tender = 'card'`, and `note` still null. Then create a second order and fire a **wrong** amount (999), confirm it is still `paid` but `note` starts with `AMOUNT MISMATCH`. Delete both rows with the `ZZ %` cleanup from Task 3 Step 7.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/square-pay/index.ts
git commit -m "feat: record tender and collected amount, flag webhook amount mismatch"
```

---

### Task 5: Quote builder totals

**Files:**
- Modify: `quotes.html` (script tag list, `ADMIN_FEE_RATE` at line 257, `computeTotals` around lines 283-289, summary markup at line 222)

**Interfaces:**
- Consumes: `EcoPricing.quoteTotals` from Task 1.
- Produces: `computeTotals(lineItems, deposit)` returning the nine-field object from `quoteTotals`. Callers previously destructured `{subtotal, adminFee, total, balance}`; `total` and `balance` are gone, replaced by `cashTotal`/`cardTotal` and `cashBalance`/`cardBalance`.

- [ ] **Step 1: Load the pricing module**

Next to the existing `assets/mapping.js` script tag in `quotes.html`, add:

```html
<script src="assets/pricing.js"></script>
```

- [ ] **Step 2: Delete the local rate and delegate the math**

Replace the `ADMIN_FEE_RATE` declaration (line 257) and the `computeTotals` function (lines 283-289) with:

```js
// The admin fee rate and the card uplift both live in assets/pricing.js now.
const ADMIN_FEE_RATE = EcoPricing.ADMIN_FEE_RATE;

// Compute base subtotal / admin fee / cash and card totals from raw line items.
function computeTotals(lineItems, deposit) {
  return EcoPricing.quoteTotals(lineItems, deposit);
}
```

- [ ] **Step 3: Update the summary rows**

Replace the summary block at line 222 with:

```html
        <div class="srow muted"><span>Administration (5%)</span><span id="s_admin">$0.00</span></div>
        <div class="srow"><span>Total (card)</span><span id="s_card">$0.00</span></div>
        <div class="srow"><span>Pay by check or cash</span><span id="s_cash">$0.00</span></div>
```

- [ ] **Step 4: Find and fix every reader of the old fields**

`computeTotals` no longer returns `total` or `balance`, so every existing caller breaks loudly. Find them:

```bash
grep -n "computeTotals\|\.total\b\|\.balance\b\|s_total\|s_admin" quotes.html
```

Apply this rule to each hit:

- **Persisting to the DB** (the `quotes` insert/update payload): write `subtotal` (base), `admin_fee`, and `total = cashTotal`. These three columns keep their exact current meaning, which is what makes the whole feature backfill-free. Do not persist any card figure.
- **Displaying a headline price to staff**: use `cardTotal`, with `cashTotal` beside it.
- **The YTD fee chip** (`adminFeesTotal`): untouched, it already sums `admin_fee`, which is still computed on base.

- [ ] **Step 4b: Confirm the stored total did not move**

After the edit, save a quote with a single $675 line item and no deposit, then check the row:

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"select subtotal, admin_fee, total from quotes order by created_at desc limit 1;"}'
```

Expected: `675`, `33.75`, `708.75`, identical to what quote #1 already holds. If `total` came back `735.75` you persisted the card figure.

- [ ] **Step 5: Verify the inline script still parses**

Run: `node --check <(python3 -c "
import re,sys
h=open('quotes.html').read()
print('\n'.join(re.findall(r'<script(?![^>]*src=)[^>]*>(.*?)</script>', h, re.S)))
")`
Expected: no output (clean parse).

- [ ] **Step 6: Commit**

```bash
git add quotes.html
git commit -m "feat: quote builder shows card and cash totals, fee line renamed"
```

---

### Task 6: Client-facing quote surfaces

**Files:**
- Modify: `quote-view.html` (totals block around lines 248-253, `depositPanelHtml` around line 268, line-item rows)
- Modify: `quote-print.html` (totals block around line 201, line-item rows)

**Interfaces:**
- Consumes: `EcoPricing.cardDollars` and `EcoPricing.quoteTotals` from Task 1.
- Produces: no new exports. `create_link` (unchanged in Task 3) continues to charge `quotes.deposit`, so Step 4 below is what makes it charge the card deposit.

- [ ] **Step 1: Load the pricing module in both pages**

Add `<script src="assets/pricing.js"></script>` beside the existing `assets/mapping.js` tag in each.

- [ ] **Step 2: Gross the displayed line items**

Read each page's row builder first (the `rows` variable feeding the `<tbody>` in the items table) so you match its existing shape. Then wrap the per-line total in `cardDollars`, leaving hours and material columns alone:

```js
// Was: money(li.amount)
money(EcoPricing.cardDollars(li.amount))
```

The line-item column must sum to `cardSubtotal`, which is exactly why `quoteTotals` sums grossed lines rather than grossing the sum. If you change the rounding here, Task 1's tie-out test fails, and that failure is correct.

- [ ] **Step 3: Replace the totals block**

In `quote-view.html` (lines 248-253) and the matching block in `quote-print.html` (line 201):

```js
      <div class="totals">
        ${depositRow}
        <div class="trow admin"><span class="lbl">Administration:</span><span class="val">${money(t.adminFee)}</span></div>
        <div class="trow total"><span class="lbl">TOTAL ESTIMATE:</span><span class="val">${money(t.cardTotal)}</span></div>
        <div class="trow cash"><span class="lbl">Pay by check or cash:</span><span class="val">${money(t.cashTotal)}</span></div>
        ${balanceRow}
      </div>
```

where `t = EcoPricing.quoteTotals(q.lineItems, q.deposit)`. No percentage appears anywhere in this copy.

- [ ] **Step 4: Charge the card deposit**

In `depositPanelHtml`, the Square button pays `t.cardDeposit` and the manual check instructions quote `t.cashDeposit`. Both numbers are shown side by side so the client can see the saving.

- [ ] **Step 5: Verify both inline scripts parse**

Run the `node --check` extraction from Task 5 Step 5 against `quote-view.html` and `quote-print.html`.

- [ ] **Step 6: Commit**

```bash
git add quote-view.html quote-print.html
git commit -m "feat: client quote shows grossed lines, card total and cash price"
```

---

### Task 7: Public shop surfaces

**Files:**
- Modify: `plants.html` (`PLANT_PRICE` line 451, kit tier table lines 443-446, `priceRows` line 508, plant card line 582, tray line 848, tray total line 857-862)
- Modify: `shop.html` (merch price display)

**Interfaces:**
- Consumes: `EcoPricing.cardCents` and `EcoPricing.cardDollars` from Task 1.
- Produces: no new exports.

- [ ] **Step 1: Load the pricing module in both pages**

Add `<script src="assets/pricing.js"></script>` beside the existing `assets/mapping.js` tag.

- [ ] **Step 2: Add a two-price formatter to plants.html**

Near the other helpers:

```js
  // Cash-discount display: the card price leads, the cash price follows. Never a
  // percentage. Both numbers come from the same constant the server charges from.
  function twoPrice(baseDollars) {
    var card = EcoPricing.cardDollars(baseDollars);
    return '$' + card.toFixed(2) + ' card &middot; $' + Number(baseDollars).toFixed(2) + ' cash or check';
  }
```

- [ ] **Step 3: Apply it to the plant card, kit table, and tray**

- Plant card (line 582): `'<p class="plant-price">' + twoPrice(PLANT_PRICE) + ' each</p>'`
- Kit price table (`priceRows`, line 512): the price cell renders `twoPrice(t.price)`
- Kit tier labels (lines 443-446): drop the bare `- $72` suffix from `label`, since the table beneath now carries both prices and the label would contradict it
- Tray total (lines 857-862): show both, `trayCount() + ' plants &middot; ' + twoPrice(total)`
- Lead paragraph (line 303): "each $5 at our plant sale" becomes "$5.20 card or $5.00 cash at our plant sale"

- [ ] **Step 4: Apply the same treatment to merch in shop.html**

Merch carries `price_cents` in the DB as base. Display `EcoPricing.cardCents(price_cents)` as the card price beside the base price, using the same "card / cash or check" phrasing.

- [ ] **Step 5: Verify inline scripts parse**

Run the `node --check` extraction from Task 5 Step 5 against `plants.html` and `shop.html`.

- [ ] **Step 6: Commit**

```bash
git add plants.html shop.html
git commit -m "feat: shop shows card and cash prices on plants, kits and merch"
```

---

### Task 8: Order status page and portal tender picker

**Files:**
- Modify: `order.html` (total row line 179, pickup status line 163)
- Modify: `orders.html` (Mark paid button line 164, `staff_mark_paid` call line 232)

**Interfaces:**
- Consumes: `charge_cents` from `order_status` (Task 3); the `tender` argument on `staff_mark_paid` (Task 4).
- Produces: no new exports.

- [ ] **Step 1: Show both prices for a pickup order**

In `order.html`, the total row (line 179) shows `charge_cents` for an online order. For a pickup order it shows both:

```js
  var totalRow = o.pay_mode === 'online'
    ? '<div class="totrow"><span class="l">Total</span><span class="v">' + money(o.charge_cents) + '</span></div>'
    : '<div class="totrow"><span class="l">Due at pickup</span><span class="v">' +
      money(o.subtotal_cents) + ' cash or check</span></div>' +
      '<div class="totrow"><span class="l">If paying by card</span><span class="v">' +
      money(EcoPricing.cardCents(o.subtotal_cents)) + '</span></div>';
```

Add `<script src="assets/pricing.js"></script>` to the page. Update the pickup status line (163) to read "Pay at pickup by cash, check, or card."

- [ ] **Step 2: Replace Mark paid with a tender choice**

In `orders.html` (line 164), the single button becomes three:

```js
    btns.push(`<button class="btn-sm btn-primary" data-act="paid" data-tender="cash" data-id="${esc(o.id)}">Paid cash</button>`);
    btns.push(`<button class="btn-sm btn-primary" data-act="paid" data-tender="check" data-id="${esc(o.id)}">Paid check</button>`);
    btns.push(`<button class="btn-sm" data-act="paid" data-tender="card" data-id="${esc(o.id)}">Paid card</button>`);
```

`data-tender` is a fixed allowlist string written by us, never a DB value, so it is safe in the attribute.

- [ ] **Step 3: Send the tender**

At line 232, read the attribute and include it:

```js
        body: JSON.stringify({ action: 'staff_mark_paid', order_id: id, tender: tender })
```

The click handler reads `tender` from `el.getAttribute('data-tender')` and refuses to send if it is not one of `cash`, `check`, `card`.

- [ ] **Step 4: Show what was collected**

In the orders table row builder, a paid row shows the collected amount and how it arrived, so staff can reconcile the drawer against the list. `tender` comes from the DB, so it is escaped:

```js
    var collected = o.amount_collected_cents == null ? ''
      : money(o.amount_collected_cents) + ' ' + esc(o.tender || '');
```

Render `collected` in the amount cell for paid rows, falling back to the existing `subtotal_cents` display for unpaid ones. A row carrying a `note` beginning `AMOUNT MISMATCH` shows an amber warning chip, since that is the whole reason the webhook writes it.

- [ ] **Step 5: Verify inline scripts parse**

Run the `node --check` extraction from Task 5 Step 5 against `order.html` and `orders.html`.

- [ ] **Step 6: Commit**

```bash
git add order.html orders.html
git commit -m "feat: pickup shows both prices, staff record tender on mark paid"
```

---

### Task 9: Documentation and full sandbox verification

**Files:**
- Modify: `docs/OPERATIONS.md`

- [ ] **Step 1: Document the pricing model**

Add a "Cash-discount pricing" section to `docs/OPERATIONS.md` recording: the two rate mirrors (`assets/pricing.js` and `supabase/functions/square-pay/index.ts`) and that they must move together; that stored `subtotal_cents` and `quotes.total` are base and cash respectively; the tender flow on pickup; the webhook mismatch flag; and that customer-facing copy never states a percentage.

Update the existing quote section, which currently says the fee line reads "Processing and administration" at lines 184-187 and 257, to say "Administration" and to note the fee is computed on the base subtotal.

- [ ] **Step 2: Update the migration repair note**

The note currently covers 0001-0014. Change it to 0001-0027.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all pricing and mapping tests pass.

- [ ] **Step 4: End-to-end sandbox verification**

1. Create an online plant order through the live `plants.html`. Confirm the Square checkout page shows the **card** price.
2. Complete the sandbox payment. Confirm the order flips to `paid` with `tender = 'card'` and `amount_collected_cents` matching `charge_cents`, and that `note` is null.
3. Create a pickup order. Confirm `order.html` shows both prices.
4. Mark it Paid cash in the portal. Confirm `amount_collected_cents` equals the base subtotal.
5. Open a quote in `quote-view.html`. Confirm the line items are grossed, the column sums to the card total, the fee line reads "Administration", and the cash price is shown beneath the total.
6. Delete every test row created above.

- [ ] **Step 5: Commit**

```bash
git add docs/OPERATIONS.md
git commit -m "docs: cash-discount pricing model and tender flow"
```

---

## Before production credentials

**Blocker carried from the spec.** If Jordan's Square account adds its own 4%, this implementation double-charges: we gross to $5.20 and Square collects $5.41. Square's documentation does not state whether Dashboard-configured automatic service charges attach to `quick_pay` payment links, and the sandbox account is a fresh auto-created one with no service charge, so it cannot answer the question.

One real production payment must prove Square charges our amount and not more. **If it does add its own 4%, set `CARD_UPLIFT = 0` in both mirrors.** Every display then falls back to base automatically, because the display layer reads the same constant the server charges from, so the two cannot disagree.
