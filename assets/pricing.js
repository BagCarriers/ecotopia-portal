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

  // lineItems carry BASE dollar amounts, exactly as staff enter them. line_items is raw
  // jsonb, so a null or otherwise empty entry can reach us; drop those here rather than at
  // each call site, because one bad entry throwing would blank a whole staff table or a
  // client's whole quote.
  function quoteTotals(lineItems, deposit) {
    const items = (Array.isArray(lineItems) ? lineItems : []).filter(Boolean);
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
