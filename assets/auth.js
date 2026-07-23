/**
 * Ecotopia Portal - Auth Manager (Supabase Auth).
 * All methods async except hasCachedSession(), a cheap sync pre-render guard.
 * requireAuth() is authoritative: valid session AND active portal_users row.
 */
const AuthManager = (() => {
  const sb = window.ecoSupabase;

  function hasCachedSession() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) return true;
      }
    } catch (e) { /* storage blocked: fall through to async check */ }
    return false;
  }

  async function isAuthenticated() {
    const { data } = await sb.auth.getSession();
    return !!(data && data.session);
  }

  let cachedRole; // undefined = not fetched yet; null = no portal access
  async function getRole() {
    if (cachedRole !== undefined) return cachedRole;
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) { cachedRole = null; return null; }
    const res = await sb.from('portal_users').select('role, active')
      .eq('user_id', data.session.user.id).maybeSingle();
    if (res.error) {
      // Transient failure: do NOT cache, so the next call retries. Distinguish
      // this from a genuinely absent/inactive row (which caches null below).
      throw new Error('Could not verify portal access. Please try again.');
    }
    cachedRole = (res.data && res.data.active) ? res.data.role : null;
    return cachedRole;
  }

  async function signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: 'Invalid email or password.' };
    cachedRole = undefined;
    let role;
    try {
      role = await getRole();
    } catch (err) {
      // Transient role-fetch failure: the session may be fine, so do NOT sign
      // out. Surface the error and let the user retry.
      return { success: false, error: err.message };
    }
    if (!role) {
      await sb.auth.signOut();
      return { success: false, error: 'This account does not have portal access.' };
    }
    return { success: true };
  }

  async function signOut() {
    cachedRole = undefined; // defense in depth: never leak a stale role
    await sb.auth.signOut();
    window.location.href = 'login.html';
  }

  async function requireAuth() {
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) {
      window.location.replace('login.html');
      throw new Error('Not authenticated');
    }
    // A transient role-fetch failure throws; do NOT sign out or redirect for it.
    // Rethrow so the page's bootstrap catch shows its error banner (fail-safe).
    const role = await getRole();
    if (!role) {
      await sb.auth.signOut();
      window.location.replace('login.html');
      throw new Error('No portal access');
    }
    return data.session;
  }

  async function getUser() {
    const { data } = await sb.auth.getSession();
    return (data && data.session) ? data.session.user.email : null;
  }

  return { hasCachedSession, isAuthenticated, signIn, signOut, requireAuth, getUser, getRole };
})();
