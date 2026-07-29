import { createClient } from 'npm:@supabase/supabase-js@2';

// square-pay: two jobs behind one endpoint.
//
//   1. create_link (PUBLIC, anon) - the quote-view page calls this on behalf of the
//      accepting client to mint a Square Payment Link for the deposit. Runs DARK
//      (returns {configured:false}) until SQUARE_ACCESS_TOKEN + SQUARE_LOCATION_ID
//      are set, so the page falls back to manual check instructions with zero code
//      changes. Idempotent: a re-click returns the already-minted url.
//   2. Square webhook (payment.updated) - Square POSTs the event JSON signed with an
//      HMAC-SHA256 over (SQUARE_WEBHOOK_URL + raw body). We verify the signature,
//      and on a COMPLETED payment flip the matching quote's deposit_status to 'paid'.
//
// The two paths are told apart by the presence of the x-square-hmacsha256-signature
// header (Square sends it; the anon page does not). Tokens and keys are never logged
// or returned. Deployed with --no-verify-jwt (the create_link path is anon; the
// webhook path is authed by its own signature), pinned in supabase/config.toml.

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
  if (!quote) return json({ ok: true }, 200); // unknown order -> no-op
  if (quote.deposit_status !== 'paid') {
    await sb.from('quotes').update({ deposit_status: 'paid' }).eq('id', quote.id);
  }
  return json({ ok: true }, 200);
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true }, 200);
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const signature = req.headers.get('x-square-hmacsha256-signature') || '';
  let raw: string;
  try { raw = await req.text(); } catch (_e) { raw = ''; }

  try {
    // A signed request is a Square webhook (verified inside handleWebhook).
    if (signature) return await handleWebhook(req, raw, signature);

    // Otherwise it must be the anon create_link call. Anything else that is NOT a
    // create_link is treated as an unsigned webhook attempt and rejected 401 - an
    // unsigned/badly-shaped request can never move payment state.
    let body: any;
    try { body = JSON.parse(raw || '{}'); } catch (_e) { body = null; }
    if (body?.action === 'create_link') return await handleCreateLink(body);
    return json({ error: 'Unauthorized' }, 401);
  } catch (_e) {
    // Never leak internals (which could include a token/key in a stack). Generic 500.
    return json({ error: 'Unexpected error.' }, 500);
  }
});
