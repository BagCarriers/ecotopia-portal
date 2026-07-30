# Cash-discount pricing (4% card uplift)

Design approved 2026-07-30. Replaces the idea of a card surcharge with cash-discount
pricing: every displayed price carries the card cost already, and paying by cash or check
brings it back to base.

## Why

Ecotopian EarthCare takes card payments through Square Payment Links. Square's online rate
is 2.9% + 30 cents. Adding a fee at checkout is a surcharge, which carries card-brand
notice requirements and is restricted in several states. Building the cost into the listed
price and discounting for cash is the legal, conventional alternative and needs no
acquirer notice.

A flat 4% is not a precise match to cost at every order size. It over-recovers above about
$30 and under-recovers below it:

| Order | Square's cut | Effective |
|---|---|---|
| One $5 plant | 44.5 cents | 8.9% |
| $50 plant tray | $1.75 | 3.5% |
| $72 kit | $2.39 | 3.3% |
| $250 kit | $7.55 | 3.0% |
| $5,000 deposit | $145.30 | 2.9% |

Accepted as a deliberate simplification: one rate everywhere is easier to explain to a
customer than a sliding one, and the small orders that lose money are mostly cash-at-the-
table plant sales anyway.

## Decisions

1. **Scope: everything.** Quotes, plants, kits, and merch all carry the uplift.
2. **Presentation: two prices, no percentage stated.** "$5.20 card / $5.00 cash or check".
   Never print a discount percentage. Adding 4% then removing 4% does not return to base
   (`$5 -> $5.20 -> $4.99`); the true round-trip discount is 3.846%. Showing both prices
   sidesteps the mismatch entirely and is the clearest form of cash discounting.
3. **Pickup orders quote both prices and settle at the table**, recording the tender and
   the amount actually collected.
4. **The 5% BagCarriers administration fee computes on the BASE subtotal**, never on the
   grossed one. The uplift is pass-through card cost, not revenue, so BC does not earn a
   commission on Square's fee, and BC's cut is identical regardless of tender.
5. **The fee line is renamed from "Processing and administration" to "Administration"**,
   since the uplift now covers processing.

## The pricing rule

One constant, `CARD_UPLIFT = 0.04`, mirrored in exactly two authorities:

- `supabase/functions/square-pay/index.ts` for orders
- `quotes.html` for quotes

Same discipline as the existing `ADMIN_FEE_RATE`. Both mirrors are named in
`docs/OPERATIONS.md` so they do not drift.

Two derived prices:

- **cash price** = base
- **card price** = `round(base x 1.04)`, rounded half-up to the nearest cent

Every current price point grosses exactly, with no rounding to resolve. Half-up is
specified because merch prices are staff-entered and arbitrary.

**Stored values stay base.** Nothing in the database is grossed. The uplift is applied at
display time and at charge time. This keeps the 5% accrual, stock, and reporting reading
the same numbers they read today, and means a future rate change rewrites no history.

## Orders

### Pricing

`create_order` prices by `pay_mode`, server-side as always, client-sent prices still
ignored:

- `online` charges the card price and mints the Square link for that amount
- `pickup` records the cash price

Both paths remain available to the customer by design: pay online at the card price, or
reserve for pickup and pay cash at the base price.

### Migration 0027

Three columns on `public.orders`:

- `base_subtotal_cents integer` - the un-grossed number, the truth for the accrual
- `tender text` - `cash` / `check` / `card`, null until settled
- `amount_collected_cents integer` - what actually came in

No new RLS policies. `orders` has no anon policies; only the `square-pay` edge function
(service role) and staff writes touch these columns.

Applied live via the Management API, so register it with
`supabase migration repair --status applied 27` before any future `db push`.

### staff_mark_paid

Grows a required `tender` argument. Card at the table records the card price, cash or check
records base. This is a breaking change to the action's contract, which is safe here
because the portal Orders page is its only caller and ships in the same change. The existing idempotency holds: only `new` / `link_created` transition to
`paid` and decrement stock, everything else 409s.

An online order settles through the webhook and records `tender = 'card'`.

### Public copy

Both numbers wherever a price appears:

- plant tray and kit modals: "$5.20 card / $5.00 cash or check"
- `order.html` pickup: "Due at pickup: $50.00 cash or check, $52.00 card"

Grossed values, all exact with no rounding trouble: $5 -> $5.20, kits $72 -> $74.88,
$144 -> $149.76, $200 -> $208.00, $250 -> $260.00, card game $40 -> $41.60.

## Quotes

Staff keep entering base amounts. `computeTotals` returns five numbers instead of three:

```
subtotal      = sum of base line items
adminFee      = round2(subtotal x 0.05)
cardSubtotal  = sum of round2(each line x 1.04)
cashTotal     = subtotal + adminFee
cardTotal     = cardSubtotal + adminFee
```

`cardSubtotal` is the **sum of individually grossed lines**, not `round2(subtotal x 1.04)`.
The two can differ by a cent, and because the client sees grossed line items, the column
must add up to the total printed beneath it.

Client-facing layout on `quote-view.html` and `quote-print.html`, each line item displayed
grossed:

```
Subtotal                    $10,400.00
Administration                 $500.00
TOTAL                       $10,900.00
Pay by check or cash        $10,500.00
```

The deposit follows the same rule: staff enter a base deposit, the Square Pay button
charges `round2(deposit x 1.04)`, and the manual check instructions quote the base figure.

### No quote migration for totals

`quotes.total` keeps its current meaning as the cash total, which is exactly what it
already equals: base subtotal plus 5%. **Existing rows need no migration and no backfill.**
Draft quote #1 ($675 base, $33.75 fee) keeps its $708.75 cash total and simply gains a
$735.75 card price alongside it.

Migration 0027 adds `deposit_tender text` to `public.quotes` for symmetry with orders, so
the Forrest accrual can see how deposits arrived.

## Webhook reconciliation

`handleWebhook` currently flips status on any `COMPLETED` payment without inspecting the
amount. With two legitimate prices in play that becomes a real risk, so it starts reading
`payment.amount_money.amount` into `amount_collected_cents`.

On a mismatch against the expected card amount it **still marks paid** (refusing would
strand real money) but flags the row for staff review. Silent divergence between what was
charged and what was recorded is the failure being designed out.

## Testing

Added to the existing `npm test` suite. Math, not UI:

1. Per-line gross-up produces the expected cents for each known price point.
2. `cardSubtotal` equals the sum of grossed lines and ties out against the printed total.
3. `adminFee` is computed on base, and is unchanged between card and cash payment.
4. Cash total for a known quote equals the pre-change total (regression guard on quote #1).
5. `staff_mark_paid` records the card price for `tender = 'card'` and base for cash/check.
6. `create_order` charges the card price for `pay_mode = 'online'` and base for `pickup`.

Plus the existing `node --check` pass over extracted inline scripts.

## Rollout

1. Ship behind sandbox Square credentials, already set and verified end to end 2026-07-30.
2. Verify both paths in sandbox: one online order and one quote deposit, confirming the
   charged amount matches the card price exactly.
3. Swap in production credentials, `SQUARE_ENV=production`, and a new production webhook
   signature key (sandbox and production subscriptions issue different keys).

### Blocker before production credentials

If Jordan's Square account is itself configured to add 4%, this design double-charges: we
gross to $5.20 and Square collects $5.41. It is not yet confirmed how that 4% is
configured. Square's documentation does not state whether Dashboard-configured automatic
service charges attach to `quick_pay` payment links, and the sandbox account is a fresh
auto-created one with no service charge, so it cannot answer the question.

**One real production payment must prove Square charges our amount and not more before
this goes live.** If Square does add its own 4%, `CARD_UPLIFT` drops to 0 and the uplift
is left entirely to Square, with the display layer reading the same constant so the two
cannot disagree.

## Out of scope

- Sliding the uplift by order size to match the 30-cent fixed fee. One flat rate, by choice.
- Any change to how the 5% BagCarriers fee is invoiced or reconciled through Forrest.
- Retroactive repricing of existing quotes.
