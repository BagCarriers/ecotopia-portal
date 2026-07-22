/** Shared Supabase client. Load AFTER supabase.js and config.js. */
window.ecoSupabase = window.supabase.createClient(
  window.ECO_CONFIG.SUPABASE_URL,
  window.ECO_CONFIG.SUPABASE_ANON_KEY
);
