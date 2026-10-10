/**
 * config.js — deployment settings.
 *
 * Cloud sync is OFF if SUPABASE_URL / SUPABASE_ANON_KEY are emptied. The app
 * then works purely locally, exactly as before. To enable accounts + sync,
 * paste your project's values from Supabase → Project Settings → API.
 * The anon key is designed to be public: Row Level Security (supabase/schema.sql)
 * keeps each user's rows private.
 */
export const SUPABASE_URL = 'https://wjuqqxstoxfgnmpardyp.supabase.co';        // e.g. 'https://abcdefghijkl.supabase.co'
export const SUPABASE_ANON_KEY = 'sb_publishable_aei8RZ9WifrcPhtiFIS2Qg_Kt1Y9Qii';   // the "anon" / publishable key

/** Show "Continue with Google" (enable the Google provider in Supabase first). */
export const ENABLE_GOOGLE_AUTH = false;
/** Offer passwordless "email me a sign-in link". */
export const ENABLE_MAGIC_LINK = true;

export const SYNC_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
