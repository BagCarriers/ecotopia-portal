import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
    },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true }, 200);
  try {
    const { token, password } = await req.json();
    if (!token || !password || String(password).length < 8) {
      return json({ error: 'Invalid token, or password shorter than 8 characters.' }, 400);
    }
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: invite } = await admin.from('portal_invites').select('*')
      .eq('token', token).is('used_at', null)
      .gt('expires_at', new Date().toISOString()).maybeSingle();
    if (!invite) return json({ error: 'Invite not found, expired, or already used.' }, 400);

    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: invite.email, password, email_confirm: true,
    });
    if (cErr) return json({ error: cErr.message }, 400);

    const { error: puErr } = await admin.from('portal_users').insert({
      user_id: created.user.id, email: invite.email, role: invite.role, active: true,
    });
    if (puErr) return json({ error: puErr.message }, 500);

    await admin.from('portal_invites').update({ used_at: new Date().toISOString() }).eq('id', invite.id);
    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: 'Unexpected error: ' + String(e) }, 500);
  }
});
