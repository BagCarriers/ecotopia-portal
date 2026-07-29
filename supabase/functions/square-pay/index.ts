import { createClient } from 'npm:@supabase/supabase-js@2';

// square-pay: several jobs behind one endpoint. Supabase is the single source of truth
// for catalog, prices, inventory, and orders; Square is a pure payment vessel that only
// ever sees a computed total (nothing is mirrored into Square).
//
//   1. create_link (PUBLIC, anon) - the quote-view page calls this on behalf of the
//      accepting client to mint a Square Payment Link for the deposit. Runs DARK
//      (returns {configured:false}) until SQUARE_ACCESS_TOKEN + SQUARE_LOCATION_ID
//      are set, so the page falls back to manual check instructions with zero code
//      changes. Idempotent: a re-click returns the already-minted url.
//   2. create_order (PUBLIC, anon) - the plants/shop pages post a cart. The server
//      re-validates every line against the live catalog, RECOMPUTES prices server-side
//      (client-sent prices are ignored), checks tracked stock, and inserts an order.
//      pay_mode 'online' + Square configured mints a Payment Link for the total.
//   3. order_status (PUBLIC, anon) - a token-gated read for the public order.html page.
//   4. staff_mark_paid (STAFF JWT) - the portal Orders page marks a pickup order paid
//      and decrements tracked stock (service-role decrement_stock, staff can't call it).
//   5. Square webhook (payment.updated) - Square POSTs the event JSON signed with an
//      HMAC-SHA256 over (SQUARE_WEBHOOK_URL + raw body). We verify the signature, and on
//      a COMPLETED payment flip the matching quote's deposit_status OR the matching
//      order's status to 'paid' (decrementing tracked stock once, idempotently).
//
// The webhook is told apart by the presence of the x-square-hmacsha256-signature header
// (Square sends it; the anon/staff pages do not); the rest dispatch on body.action.
// Tokens and keys are never logged or returned. Deployed with --no-verify-jwt (the
// public paths are anon; staff_mark_paid validates its own JWT; the webhook path is
// authed by its own signature), pinned in supabase/config.toml.
//
// Pricing authority (single source): PLANT_PRICE_CENTS and KIT_TIERS live HERE. The
// plants page shows matching display prices, but only these server constants are charged.
const PLANT_PRICE_CENTS = 500;
const KIT_TIERS: Record<string, number> = {
  '50': 7200,
  '100': 14400,
  '150': 20000,
  '200': 25000,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-square-hmacsha256-signature',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}

// Square Connect base for the configured environment.
function squareBase(): string {
  return (Deno.env.get('SQUARE_ENV') || 'production').toLowerCase() === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
}

// Deposit dollars -> integer cents, half-up. round(deposit * 100).
function toCents(deposit: number): number {
  return Math.round((Number(deposit) || 0) * 100);
}

// Constant-time string compare (avoids leaking the signature via timing).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Square webhook signature: base64( HMAC-SHA256( notificationUrl + rawBody, key ) ),
// compared constant-time against the x-square-hmacsha256-signature header.
async function squareSignatureMatches(
  url: string,
  rawBody: string,
  header: string,
  key: string
): Promise<boolean> {
  if (!key || !header) return false;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(url + rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return safeEqual(expected, header);
}

// ── Webhook: verify signature, flip a COMPLETED payment's quote to paid ──────
async function handleWebhook(req: Request, rawBody: string, signature: string): Promise<Response> {
  const key = Deno.env.get('SQUARE_WEBHOOK_SIGNATURE_KEY') || '';
  const notifyUrl = Deno.env.get('SQUARE_WEBHOOK_URL') || '';
  // No key/url configured, or a bad/missing signature -> reject. We never trust an
  // unverifiable webhook to move money state.
  if (!key || !notifyUrl) return json({ error: 'Unauthorized' }, 401);
  if (!(await squareSignatureMatches(notifyUrl, rawBody, signature, key))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let event: any;
  try { event = JSON.parse(rawBody); } catch (_e) { return json({ ok: true }, 200); }

  const payment = event?.data?.object?.payment;
  const type = event?.type;
  const status = payment?.status;
  const orderId = payment?.order_id;
  // Only a completed payment on a known order matters; everything else is a fast no-op.
  if (type !== 'payment.updated' || status !== 'COMPLETED' || !orderId) {
    return json({ ok: true }, 200);
  }

  const sb = admin();
  const { data: quote } = await sb.from('quotes').select('id, deposit_status')
    .eq('square_order_id', orderId).maybeSingle();
  if (quote) {
    if (quote.deposit_status !== 'paid') {
      await sb.from('quotes').update({ deposit_status: 'paid' }).eq('id', quote.id);
    }
    return json({ ok: true }, 200);
  }

  // No quote matched: this may be one of our shop/plant orders instead.
  const { data: order } = await sb.from('orders')
    .select('id, status, items').eq('square_order_id', orderId).maybeSingle();
  if (!order) return json({ ok: true }, 200); // unknown order -> no-op
  // Idempotent: only 'new'/'link_created' transitions to 'paid' + decrements stock.
  // 'paid' or any later status is a no-op, so stock is never decremented twice.
  if (order.status === 'new' || order.status === 'link_created') {
    await sb.from('orders').update({ status: 'paid' }).eq('id', order.id);
    await decrementOrderStock(sb, order.items);
  }
  return json({ ok: true }, 200);
}

// Decrement tracked stock for each line of an order (untracked rows are left alone by
// decrement_stock itself). Best-effort per line; a single failure does not abort the rest.
async function decrementOrderStock(sb: ReturnType<typeof admin>, items: any): Promise<void> {
  if (!Array.isArray(items)) return;
  for (const it of items) {
    const kind = it?.kind;
    const id = it?.id;
    const qty = Number(it?.qty) || 0;
    if (!kind || !id || qty <= 0) continue;
    try {
      await sb.rpc('decrement_stock', { p_kind: kind, p_id: id, p_qty: qty });
    } catch (_e) { /* one line failing must not sink the rest */ }
  }
}

// ── create_link: mint (or return) a Square Payment Link for a quote deposit ──
async function handleCreateLink(body: any): Promise<Response> {
  const token = typeof body?.token === 'string' ? body.token : '';
  // Same minimum the token-gated RPCs enforce; a short/guessed token never resolves.
  if (token.length < 32) return json({ error: 'Not found' }, 404);

  const sb = admin();
  const { data: quote } = await sb.from('quotes')
    .select('id, quote_year, quote_number, deposit, status, deposit_status, square_order_id, square_pay_url')
    .eq('share_token', token).maybeSingle();

  // Must be an accepted quote with a real deposit still owing.
  if (!quote || !['accepted', 'invoiced'].includes(quote.status) || !(Number(quote.deposit) > 0)) {
    return json({ error: 'Not found' }, 404);
  }
  if (quote.deposit_status === 'paid') {
    return json({ error: 'Already paid' }, 409);
  }

  // Idempotent re-click: a link already exists (deposit_status is 'pending') -> return it.
  if (quote.square_pay_url) {
    return json({ configured: true, url: quote.square_pay_url }, 200);
  }

  // Runs dark until both Square secrets are present -> page falls back to manual.
  const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
  const locationId = Deno.env.get('SQUARE_LOCATION_ID');
  if (!accessToken || !locationId) return json({ configured: false }, 200);

  const name = `Deposit - Quote ${quote.quote_number} of ${quote.quote_year} - Ecotopian EarthCare`;
  let res: Response;
  try {
    res = await fetch(squareBase() + '/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Square-Version': '2025-01-23',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        idempotency_key: quote.id + ':deposit',
        quick_pay: {
          name,
          price_money: { amount: toCents(quote.deposit), currency: 'USD' },
          location_id: locationId,
        },
      }),
    });
  } catch (_e) {
    return json({ error: 'Could not reach the payment processor.' }, 502);
  }
  if (!res.ok) {
    // Do NOT surface Square's body (it can echo request detail); page falls back to manual.
    return json({ error: 'Could not create the payment link.' }, 502);
  }
  const payload = await res.json().catch(() => null);
  const url = payload?.payment_link?.url;
  const orderId = payload?.payment_link?.order_id;
  if (!url || !orderId) return json({ error: 'Could not create the payment link.' }, 502);

  await sb.from('quotes').update({
    square_order_id: orderId,
    square_pay_url: url,
    deposit_status: 'pending',
  }).eq('id', quote.id);

  return json({ configured: true, url }, 200);
}

// 64 hex chars of CSPRNG randomness - the public order.html status/payment key.
function newOrderToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── create_order: validate a cart server-side, price it, check stock, insert ─
// PUBLIC (anon). The whole point is server-side validation: client-sent prices are
// ignored and every line is re-priced from the live catalog against the pricing
// constants above. Returns {token} (pickup), {token, pay_url} (online + Square live),
// or {token, configured:false} (online but Square dark -> treated as pickup).
async function handleCreateOrder(body: any): Promise<Response> {
  const customer = body?.customer || {};
  const name = typeof customer?.name === 'string' ? customer.name.trim() : '';
  const phone = typeof customer?.phone === 'string' ? customer.phone.trim() : '';
  const email = typeof customer?.email === 'string' ? customer.email.trim() : '';
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : '';
  const payMode = body?.pay_mode === 'online' ? 'online' : 'pickup';
  const rawItems = Array.isArray(body?.items) ? body.items : [];

  if (!name) return json({ error: 'missing_name' }, 400);
  if (rawItems.length < 1) return json({ error: 'empty_cart' }, 400);
  if (rawItems.length > 40) return json({ error: 'too_many_lines' }, 400);

  const sb = admin();
  const lines: Array<{ kind: string; id: string; name: string; qty: number; unit_cents: number; tier?: string }> = [];
  let subtotal = 0;

  for (const raw of rawItems) {
    const kind = raw?.kind;
    const id = typeof raw?.id === 'string' ? raw.id : '';
    let qty = Math.floor(Number(raw?.qty));
    if (!id) return json({ error: 'item_unavailable' }, 400);
    if (!(qty >= 1 && qty <= 20)) return json({ error: 'bad_quantity' }, 400);

    if (kind === 'species') {
      const { data: row } = await sb.from('plant_species')
        .select('id, common, active, stock_qty').eq('id', id).maybeSingle();
      if (!row || row.active === false) return json({ error: 'item_unavailable' }, 400);
      if (row.stock_qty != null && row.stock_qty < qty) {
        return json({ error: 'insufficient_stock', item: row.common }, 409);
      }
      const unit = PLANT_PRICE_CENTS;
      subtotal += unit * qty;
      lines.push({ kind, id, name: row.common, qty, unit_cents: unit });
    } else if (kind === 'kit') {
      const tier = typeof raw?.tier === 'string' ? raw.tier : '';
      if (!(tier in KIT_TIERS)) return json({ error: 'bad_tier' }, 400);
      if (qty > 5) qty = 5; // kits are forced 1..5
      const { data: row } = await sb.from('plant_kits')
        .select('id, name, active, stock_qty').eq('id', id).maybeSingle();
      if (!row || row.active === false) return json({ error: 'item_unavailable' }, 400);
      if (row.stock_qty != null && row.stock_qty < qty) {
        return json({ error: 'insufficient_stock', item: row.name }, 409);
      }
      const unit = KIT_TIERS[tier];
      subtotal += unit * qty;
      lines.push({ kind, id, name: row.name, qty, unit_cents: unit, tier });
    } else if (kind === 'merch') {
      const { data: row } = await sb.from('merch_items')
        .select('id, name, active, stock_qty, price_cents').eq('id', id).maybeSingle();
      if (!row || row.active === false) return json({ error: 'item_unavailable' }, 400);
      // Merch without a price is request-only and cannot be ordered (strict).
      if (row.price_cents == null) {
        return json({ error: 'not_payable', item: row.name }, 400);
      }
      if (row.stock_qty != null && row.stock_qty < qty) {
        return json({ error: 'insufficient_stock', item: row.name }, 409);
      }
      const unit = Number(row.price_cents) || 0;
      subtotal += unit * qty;
      lines.push({ kind, id, name: row.name, qty, unit_cents: unit });
    } else {
      return json({ error: 'item_unavailable' }, 400);
    }
  }

  const token = newOrderToken();
  const { data: inserted, error: insErr } = await sb.from('orders').insert({
    order_token: token,
    customer_name: name,
    phone: phone || null,
    email: email || null,
    items: lines,
    subtotal_cents: subtotal,
    status: 'new',
    pay_mode: payMode,
    note: note || null,
  }).select('id').single();
  if (insErr || !inserted) return json({ error: 'Could not save the order.' }, 500);

  // Pickup, or a zero-total order: nothing to charge, done.
  if (payMode !== 'online' || subtotal <= 0) return json({ token }, 200);

  // Online: mint a Square Payment Link for the total, or fall back to pickup if dark.
  const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
  const locationId = Deno.env.get('SQUARE_LOCATION_ID');
  if (!accessToken || !locationId) return json({ token, configured: false }, 200);

  const linkName = `Order ${inserted.id.slice(0, 8)} - Ecotopian EarthCare`;
  let res: Response;
  try {
    res = await fetch(squareBase() + '/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Square-Version': '2025-01-23',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        idempotency_key: inserted.id + ':order',
        quick_pay: {
          name: linkName,
          price_money: { amount: subtotal, currency: 'USD' },
          location_id: locationId,
        },
      }),
    });
  } catch (_e) {
    return json({ token, configured: false }, 200); // unreachable Square -> pickup fallback
  }
  if (!res.ok) return json({ token, configured: false }, 200);
  const payload = await res.json().catch(() => null);
  const url = payload?.payment_link?.url;
  const sqOrderId = payload?.payment_link?.order_id;
  if (!url || !sqOrderId) return json({ token, configured: false }, 200);

  await sb.from('orders').update({
    square_order_id: sqOrderId,
    square_pay_url: url,
    status: 'link_created',
  }).eq('id', inserted.id);

  return json({ token, pay_url: url }, 200);
}

// ── order_status: token-gated public read for order.html ─────────────────────
async function handleOrderStatus(body: any): Promise<Response> {
  const token = typeof body?.token === 'string' ? body.token : '';
  if (token.length < 32) return json({ error: 'Not found' }, 404);
  const sb = admin();
  const { data: order } = await sb.from('orders')
    .select('status, items, subtotal_cents, pay_mode, square_pay_url, created_at')
    .eq('order_token', token).maybeSingle();
  if (!order) return json({ error: 'Not found' }, 404);
  return json({
    status: order.status,
    items: order.items,
    subtotal_cents: order.subtotal_cents,
    pay_mode: order.pay_mode,
    pay_url: order.square_pay_url || null,
    created_at: order.created_at,
  }, 200);
}

// ── staff_mark_paid: staff marks a pickup order paid + decrements stock ──────
// STAFF ONLY. Staff RLS can update orders, but decrement_stock is service-role only,
// so this action exists to do both atomically for cash/check pickups. Requires a valid
// portal-user JWT (validated exactly like grant-scan).
async function handleStaffMarkPaid(req: Request, body: any): Promise<Response> {
  const sb = admin();
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ error: 'Unauthorized' }, 401);
  // Validate the staff JWT by resolving it against GoTrue /user directly (apikey =
  // service role, Authorization = the caller's JWT), then confirm an active portal_users
  // row. A direct fetch keeps this independent of supabase-js client-session quirks.
  let userId = '';
  try {
    const ures = await fetch(Deno.env.get('SUPABASE_URL')! + '/auth/v1/user', {
      headers: {
        apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        Authorization: `Bearer ${jwt}`,
      },
    });
    if (!ures.ok) return json({ error: 'Unauthorized' }, 401);
    const u = await ures.json().catch(() => null);
    userId = u?.id || '';
  } catch (_e) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!userId) return json({ error: 'Unauthorized' }, 401);
  const { data: pu } = await sb.from('portal_users').select('user_id')
    .eq('user_id', userId).eq('active', true).maybeSingle();
  if (!pu) return json({ error: 'Unauthorized' }, 401);

  const orderId = typeof body?.order_id === 'string' ? body.order_id : '';
  if (!orderId) return json({ error: 'missing_order_id' }, 400);
  const { data: order } = await sb.from('orders')
    .select('id, status, items').eq('id', orderId).maybeSingle();
  if (!order) return json({ error: 'Not found' }, 404);
  // Idempotent: only decrement stock on the first transition into 'paid'.
  if (order.status === 'new' || order.status === 'link_created') {
    await sb.from('orders').update({ status: 'paid' }).eq('id', order.id);
    await decrementOrderStock(sb, order.items);
  }
  return json({ ok: true, status: 'paid' }, 200);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true }, 200);
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const signature = req.headers.get('x-square-hmacsha256-signature') || '';
  let raw: string;
  try { raw = await req.text(); } catch (_e) { raw = ''; }

  try {
    // A signed request is a Square webhook (verified inside handleWebhook).
    if (signature) return await handleWebhook(req, raw, signature);

    // Otherwise dispatch on the action. Anything unrecognized is treated as an unsigned
    // webhook attempt and rejected 401 - an unsigned/badly-shaped request can never move
    // payment state.
    let body: any;
    try { body = JSON.parse(raw || '{}'); } catch (_e) { body = null; }
    if (body?.action === 'create_link') return await handleCreateLink(body);
    if (body?.action === 'create_order') return await handleCreateOrder(body);
    if (body?.action === 'order_status') return await handleOrderStatus(body);
    if (body?.action === 'staff_mark_paid') return await handleStaffMarkPaid(req, body);
    return json({ error: 'Unauthorized' }, 401);
  } catch (_e) {
    // Never leak internals (which could include a token/key in a stack). Generic 500.
    return json({ error: 'Unexpected error.' }, 500);
  }
});
