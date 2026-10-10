/**
 * sync.js — Supabase auth + cloud sync (browser side).
 *
 * Does nothing unless js/config.js has SUPABASE_URL + SUPABASE_ANON_KEY.
 * supabase-js v2 (UMD, vendored in /vendor/supabase.js) is loaded lazily.
 *
 * Sync runs: on app open / sign-in, ~2 s after local changes, when the app
 * comes back online or to the foreground, and every 5 minutes.
 * Merge rules live in synccore.js (pure + unit-tested).
 */
import * as cfg from './config.js';
import * as store from './store.js';
import * as core from './synccore.js';

const PAGE = 1000;
const PUSH_CHUNK = 500;
const CURSOR_MARGIN_MS = 10_000; // re-read a little overlap to tolerate late commits

let sb = null;              // supabase client
let user = null;
let running = null, queued = null, timer = null;
const status = { state: cfg.SYNC_ENABLED ? 'signed-out' : 'disabled', at: null, error: null };
const listeners = new Set();

export const enabled = cfg.SYNC_ENABLED;
export const getUser = () => user;
export const getStatus = () => ({ ...status, user });
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setStatus(patch) { Object.assign(status, patch); listeners.forEach((f) => { try { f(getStatus()); } catch (e) { console.error(e); } }); }

/**
 * Where email links / OAuth send the user back: the current page URL
 * (without query or hash), e.g. https://user.github.io/spellbook/.
 * It must be allowed under Supabase → Authentication → URL Configuration.
 */
export const appUrl = () => location.origin + location.pathname;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.supabase?.createClient) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load supabase-js'));
    document.head.appendChild(s);
  });
}

/** Initialise auth + sync. Safe to call when sync is disabled (no-op). */
export async function init({ onPasswordRecovery, onAuthNotice } = {}) {
  if (!enabled) return;
  try {
    await loadScript(new URL('vendor/supabase.js', document.baseURI).href);
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  } catch (e) {
    setStatus({ state: 'error', error: e.message });
    return;
  }
  sb.auth.onAuthStateChange((event, session) => {
    const prev = user?.id;
    user = session?.user ?? null;
    if (event === 'PASSWORD_RECOVERY') onPasswordRecovery?.();
    if (!user) { setStatus({ state: 'signed-out' }); return; }
    if (user.id !== prev) { setStatus({ state: 'idle' }); setTimeout(syncNow, 0); }
  });
  // Finish any auth redirect (?code=… from confirm / magic-link / reset / OAuth).
  const hadCode = new URLSearchParams(location.search).has('code');
  const init = await sb.auth.initialize().catch((e) => ({ error: e }));
  if (hadCode) {
    // Clean the URL either way so a reload doesn't retry a used code.
    history.replaceState(null, '', location.pathname + location.hash);
    if (init?.error) {
      // Typical case: the confirmation link was opened in a different browser/app
      // than the one used to sign up. The email IS confirmed; they just sign in.
      onAuthNotice?.('Email confirmed (or link already used). Please sign in with your email and password.');
    }
  }
  const { data } = await sb.auth.getSession();
  user = data.session?.user ?? null;
  if (hadCode && user) onAuthNotice?.(`Signed in as ${user.email}`);
  setStatus({ state: user ? 'idle' : 'signed-out' });
  if (user) syncNow();

  // Debounced sync after local edits.
  store.subscribe(() => {
    if (!user) return;
    const d = store.state.sync.dirty;
    if (Object.keys(d.collection).length || Object.keys(d.decks).length) schedule(2000);
  });
  addEventListener('online', () => user && syncNow());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && user && schedule(500));
  setInterval(() => user && navigator.onLine && syncNow(), 5 * 60 * 1000);
}

function schedule(ms) { clearTimeout(timer); timer = setTimeout(syncNow, ms); }

/**
 * Run one full pull + push cycle. If a sync is already running, one follow-up
 * run is queued (callers get a promise for that run, so they see fresh data).
 */
export function syncNow() {
  if (!sb || !user) return Promise.resolve();
  if (!running) return start();
  if (!queued) queued = running.then(() => { queued = null; return start(); });
  return queued;
}

function start() {
  running = (async () => {
    setStatus({ state: 'syncing', error: null });
    try {
      const s = store.state;
      if (s.sync.userId !== user.id) {
        // First sync for this account on this device: merge everything.
        s.sync = { ...store.emptySync(), dirty: s.sync.dirty, userId: user.id };
        core.markAllDirty(s);
      }
      let changed = 0;
      for (const [kind, table] of Object.entries(core.TABLES)) {
        const rows = await pullAll(table, s.sync.cursor[table]);
        changed += core.applyRemote(s, kind, rows);
        s.sync.cursor[table] = core.advanceCursor(s.sync.cursor[table], rows);
      }
      const out = core.collectDirty(s, user.id);
      for (const table of Object.values(core.TABLES)) {
        for (let i = 0; i < out[table].length; i += PUSH_CHUNK) {
          const { error } = await sb.from(table).upsert(out[table].slice(i, i + PUSH_CHUNK), { onConflict: 'user_id,id' });
          if (error) throw error;
        }
      }
      core.clearPushed(s, out.marks);
      store.save();
      if (changed) console.info(`[sync] applied ${changed} remote change(s)`);
      setStatus({ state: 'synced', at: new Date().toISOString() });
    } catch (e) {
      console.warn('[sync] failed', e);
      setStatus({ state: navigator.onLine ? 'error' : 'offline', error: e.message || String(e) });
    } finally {
      running = null;
    }
  })();
  return running;
}

async function pullAll(table, cursor) {
  const rows = [];
  let since = cursor ? new Date(Date.parse(cursor) - CURSOR_MARGIN_MS).toISOString() : null;
  for (;;) {
    let q = sb.from(table).select('*').order('synced_at', { ascending: true }).limit(PAGE);
    if (since) q = q.gte('synced_at', since);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
    since = data[data.length - 1].synced_at;
  }
  return rows;
}

/* ---------------- auth actions (throw on error) ---------------- */
function check({ data, error }) { if (error) throw error; return data; }

/**
 * Create an account. Returns:
 *   { status: 'signed-in' }            confirmations off → session right away
 *   { status: 'confirm-email' }        check inbox; link returns to appUrl()
 *   { status: 'maybe-existing' }       Supabase hides whether the email is taken
 *                                      (user with no identities) → suggest sign-in/reset
 */
export async function signUp(email, password) {
  const data = check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } }));
  if (data.session) return { status: 'signed-in' };
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return { status: 'maybe-existing' };
  return { status: 'confirm-email' };
}
/** Sign in; errors carry code 'email_not_confirmed' when the inbox link wasn't clicked yet. */
export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)) {
      const e = new Error('Please confirm your email first — check your inbox (and spam) for the link.'); e.code = 'email_not_confirmed'; throw e;
    }
    if (error.code === 'invalid_credentials' || /invalid login/i.test(error.message)) throw new Error('Wrong email or password.');
    throw error;
  }
}
/** Re-send the sign-up confirmation email. */
export async function resendConfirmation(email) { check(await sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: appUrl() } })); }
export async function magicLink(email) { check(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: appUrl() } })); }
export async function google() { check(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl() } })); }
export async function resetPassword(email) { check(await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() })); }
export async function updatePassword(password) { check(await sb.auth.updateUser({ password })); }

/**
 * Sign out. Local data stays on the device (local-first) unless clearLocal;
 * sync bookkeeping is reset so the next sign-in merges again.
 */
export async function signOut({ clearLocal = false } = {}) {
  if (user && navigator.onLine) await syncNow().catch(() => {});
  await sb.auth.signOut().catch(() => {});
  user = null;
  const s = store.state;
  if (clearLocal) { s.cards = {}; s.collection = []; s.decks = []; s.tombstones = { collection: {}, decks: {} }; }
  s.sync = store.emptySync();
  store.save();
  setStatus({ state: 'signed-out', at: null });
}
