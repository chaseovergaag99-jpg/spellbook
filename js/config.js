/**
 * config.js — deployment settings.
 *
 * Cloud sync is OFF while SUPABASE_URL / SUPABASE_ANON_KEY are empty. The app
 * then works purely locally, exactly as before. To enable accounts + sync,
 * paste your project's values from Supabase → Project Settings → API.
 * The anon key is designed to be public: Row Level Security (supabase/schema.sql)
 * keeps each user's rows private.
 */
export const SUPABASE_URL = '';        // e.g. 'https://abcdefghijkl.supabase.co'
export const SUPABASE_ANON_KEY = '';   // the "anon" / publishable key

/** Show "Continue with Google" (enable the Google provider in Supabase first). */
export const ENABLE_GOOGLE_AUTH = false;
/** Offer passwordless "email me a sign-in link". */
export const ENABLE_MAGIC_LINK = true;

export const SYNC_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
