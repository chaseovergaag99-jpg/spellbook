/**
 * views/account.js — account panel (in Settings), sign-in prompt banner and
 * sync status chip (Collection header), password-recovery sheet.
 * Everything here is hidden when cloud sync isn't configured.
 */
import * as sync from '../sync.js';
import * as cfg from '../config.js';
import { $, esc, toast, timeAgo, openSheet, closeSheet } from '../ui.js';

/* ---------- status text ---------- */
export function statusText(s = sync.getStatus()) {
  switch (s.state) {
    case 'syncing': return '⟳ Syncing…';
    case 'synced': return `☁ Synced ${timeAgo(s.at)}`;
    case 'error': return '⚠ Sync error — will retry';
    case 'offline': return '☁ Offline — will sync later';
    case 'idle': return '☁ Signed in';
    default: return '';
  }
}

/* ---------- Collection header chip / banner ---------- */
const BANNER_KEY = 'spellbook:hideSyncBanner';
export function chipHtml() {
  if (!sync.enabled) return '';
  const s = sync.getStatus();
  if (s.state === 'signed-out') {
    if (localStorage.getItem(BANNER_KEY)) return '';
    return `<div class="card-panel row small" id="sync-banner" style="padding:10px 12px">
      <span class="grow">☁ <b>Sign in</b> to back up your collection and sync it across devices.</span>
      <a class="btn small primary" href="#settings" data-goto="settings">Sign in</a>
      <button class="btn small ghost icon-btn" id="sync-banner-x" aria-label="Dismiss">✕</button></div>`;
  }
  return `<button class="btn small ghost" id="sync-chip" data-goto="settings" style="padding:0 4px;min-height:32px;color:var(--muted)">${esc(statusText(s))}</button>`;
}
/** Wire chip/banner events inside root; returns nothing. */
export function wireChip(root) {
  root.querySelector('#sync-banner-x')?.addEventListener('click', () => { localStorage.setItem(BANNER_KEY, '1'); root.querySelector('#sync-banner')?.remove(); });
}

/* ---------- Settings panel ---------- */
let mode = 'signin'; // 'signin' | 'signup'

export function panelHtml() {
  if (!sync.enabled) {
    return `<div class="card-panel"><h3>Account & cloud sync</h3>
      <p class="small muted">Cloud sync isn't set up for this copy of the app, so data stays on this device only. (Developer: add Supabase keys in <code>js/config.js</code>; see the README.)</p></div>`;
  }
  const s = sync.getStatus();
  if (s.user) {
    return `<div class="card-panel" id="acct">
      <h3>Account</h3>
      <p class="small">Signed in as <b>${esc(s.user.email || 'user')}</b></p>
      <p class="small muted"><span id="acct-status">${esc(statusText(s))}</span>${s.error ? `<br><span style="color:var(--bad)">${esc(s.error)}</span>` : ''}</p>
      <div class="actions">
        <button class="btn primary" id="acct-sync">⟳ Sync now</button>
        <button class="btn" id="acct-out">Sign out</button>
      </div>
      <button class="btn block ghost small" id="acct-pw" style="margin-top:8px">Change password</button>
    </div>`;
  }
  return `<div class="card-panel" id="acct">
    <h3>${mode === 'signup' ? 'Create account' : 'Sign in'}</h3>
    <p class="small muted">Back up your collection & decks and sync them across your devices. Local data is kept and merged.</p>
    ${cfg.ENABLE_GOOGLE_AUTH ? `<button class="btn block" id="acct-google" style="margin:8px 0"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg> Continue with Google</button><div class="small muted" style="text-align:center">or</div>` : ''}
    <form id="acct-form" autocomplete="on">
      <label class="field"><span>Email</span><input type="email" id="acct-email" autocomplete="email" inputmode="email" required></label>
      <label class="field"><span>Password</span><input type="password" id="acct-pass" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" minlength="6"></label>
      <button class="btn primary block" type="submit" id="acct-submit">${mode === 'signup' ? 'Create account' : 'Sign in'}</button>
    </form>
    <div class="row wrap small" style="justify-content:space-between;margin-top:8px">
      <button class="btn small ghost" id="acct-mode">${mode === 'signup' ? 'Have an account? Sign in' : 'New here? Create account'}</button>
      <button class="btn small ghost" id="acct-forgot">Forgot password?</button>
      ${cfg.ENABLE_MAGIC_LINK ? '<button class="btn small ghost" id="acct-magic">Email me a sign-in link</button>' : ''}
    </div>
    <p class="small" id="acct-msg" role="status"></p>
  </div>`;
}

export function wirePanel(root, rerender) {
  const msg = (t, bad) => { const m = root.querySelector('#acct-msg'); if (m) { m.textContent = t; m.style.color = bad ? 'var(--bad)' : 'var(--good)'; } };
  const email = () => root.querySelector('#acct-email')?.value.trim();
  const busy = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) { msg(e.message || String(e), true); } finally { if (btn) btn.disabled = false; }
  };
  root.querySelector('#acct-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = root.querySelector('#acct-pass').value;
    if (!email() || pw.length < 6) return msg('Enter your email and a password (6+ characters).', true);
    busy(root.querySelector('#acct-submit'), async () => {
      if (mode === 'signup') {
        const r = await sync.signUp(email(), pw);
        if (r.status === 'signed-in') { toast('Account created — syncing…'); return; }
        if (r.status === 'maybe-existing') { msg('If you already have an account with this email, sign in instead (or use "Forgot password?"). Otherwise check your inbox for a confirmation link.'); showResend(); return; }
        confirmState(email());
      } else {
        try { await sync.signIn(email(), pw); toast('Signed in — syncing…'); }
        catch (err) { if (err.code === 'email_not_confirmed') { msg(err.message, true); showResend(); return; } throw err; }
      }
    });
  });
  // "Check your inbox" state after sign-up (email confirmation enabled).
  const confirmState = (addr) => {
    const box = root.querySelector('#acct');
    box.querySelector('#acct-form').hidden = true;
    box.querySelector('h3').textContent = 'Confirm your email';
    msg('');
    const info = document.createElement('div');
    info.id = 'acct-confirm';
    info.innerHTML = `<p class="small">📬 We sent a confirmation link to <b>${esc(addr)}</b>.</p>
      <p class="small muted">Open it on this phone to finish creating your account — you'll come right back here, signed in.
      If you open it somewhere else, just come back and sign in with your email and password.</p>`;
    box.insertBefore(info, box.querySelector('#acct-form'));
    const back = root.querySelector('#acct-mode'); back.textContent = 'Back to sign in';
    showResend(addr);
  };
  const showResend = (addr) => {
    if (root.querySelector('#acct-resend')) return;
    const b = document.createElement('button');
    b.className = 'btn small'; b.id = 'acct-resend'; b.textContent = 'Resend confirmation email';
    b.onclick = () => busy(b, async () => {
      const a = addr || email(); if (!a) throw new Error('Enter your email above first.');
      await sync.resendConfirmation(a); msg('Confirmation email sent again. It can take a minute — check spam too.');
    });
    root.querySelector('#acct-msg').before(b);
  };
  root.querySelector('#acct-mode')?.addEventListener('click', () => {
    mode = root.querySelector('#acct-confirm') ? 'signin' : mode === 'signup' ? 'signin' : 'signup';
    rerender(true);
  });
  root.querySelector('#acct-forgot')?.addEventListener('click', (e) => {
    if (!email()) return msg('Enter your email above first.', true);
    busy(e.currentTarget, async () => { await sync.resetPassword(email()); msg('Password reset email sent.'); });
  });
  root.querySelector('#acct-magic')?.addEventListener('click', (e) => {
    if (!email()) return msg('Enter your email above first.', true);
    busy(e.currentTarget, async () => { await sync.magicLink(email()); msg('Sign-in link sent — open it on this device.'); });
  });
  root.querySelector('#acct-google')?.addEventListener('click', (e) => busy(e.currentTarget, sync.google));
  root.querySelector('#acct-sync')?.addEventListener('click', () => sync.syncNow());
  root.querySelector('#acct-pw')?.addEventListener('click', () => passwordSheet());
  root.querySelector('#acct-out')?.addEventListener('click', () => {
    const r = openSheet(`<h2>Sign out</h2>
      <p class="small muted">Your data will finish syncing first. Keep a copy on this device?</p>
      <div class="list"><button class="btn block primary" id="so-keep">Sign out, keep data on this device</button>
      <button class="btn block danger" id="so-clear">Sign out and remove data from this device</button></div>`);
    r.querySelector('#so-keep').onclick = async () => { closeSheet(); await sync.signOut(); toast('Signed out'); };
    r.querySelector('#so-clear').onclick = async () => { closeSheet(); await sync.signOut({ clearLocal: true }); toast('Signed out — device data removed'); };
  });
}

/** Set a new password (after a reset link, or from Settings). */
export function passwordSheet() {
  const r = openSheet(`<h2>Set a new password</h2>
    <label class="field"><span>New password</span><input type="password" id="np-pass" autocomplete="new-password" minlength="6"></label>
    <button class="btn primary block" id="np-go">Save password</button><p class="small" id="np-msg"></p>`);
  r.querySelector('#np-go').onclick = async () => {
    const pw = r.querySelector('#np-pass').value;
    if (pw.length < 6) { r.querySelector('#np-msg').textContent = 'Use at least 6 characters.'; return; }
    try { await sync.updatePassword(pw); closeSheet(); toast('Password updated'); }
    catch (e) { r.querySelector('#np-msg').textContent = e.message; }
  };
}
