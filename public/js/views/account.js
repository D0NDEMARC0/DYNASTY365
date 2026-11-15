// The account dialog: sign in, create an account, reset a password, or see what's saved and sign out.
import { esc } from '../ui.js';
import { enabled, user, signIn, signUp, signOut, sendReset, setPassword, push, getStatus } from '../cloud.js';

let dlg = null;
const when = t => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** Open the dialog. mode: 'signin' | 'signup' | 'reset' | 'newpass'; done(changed) runs after a sign-in or sign-out. */
export function openAccount({ mode = 'signin', message = '', done } = {}) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'dlg small';
    dlg.setAttribute('aria-labelledby', 'acct-title');
    document.body.append(dlg);
    dlg.addEventListener('click', e => { // a click outside the box closes it
      const r = dlg.getBoundingClientRect();
      if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dlg.close();
    });
  }
  let m = user() && mode !== 'newpass' ? 'account' : mode;
  const draw = (msg = message, err = false) => {
    message = '';
    const head = t => `<div class="dlg-head"><h2 id="acct-title">${t}</h2><button class="icon-btn" data-a="close" aria-label="Close">✕</button></div>`;
    const note = msg ? `<p class="acct-msg ${err ? 'down' : ''}" role="status">${esc(msg)}</p>` : '<p class="acct-msg" role="status"></p>';
    if (!enabled()) { dlg.innerHTML = `${head('Accounts')}<p class="small">Accounts aren’t switched on for this copy of the app yet.</p>`; return; }
    if (m === 'account') {
      const u = user(), s = getStatus();
      dlg.innerHTML = `${head('Your account')}
        <p class="small" style="margin:0 0 8px">Signed in as <b>${esc(u?.email || '')}</b>.</p>
        <p class="small muted" style="margin:0 0 10px">Your settings (format, scoring, TE premium), your linked Sleeper league, your own rankings and the boards you pasted save to your account automatically and load on any device where you sign in.</p>
        <p class="small">${s.state === 'saving' ? 'Saving…' : s.state === 'error' ? `<span class="down">Couldn’t save: ${esc(s.error)}</span>` : s.at ? `Saved ${esc(when(s.at))}` : ''}</p>
        ${note}
        <div class="dlg-foot"><button class="btn" data-a="save">Save now</button><button class="btn" data-a="signout">Sign out</button></div>`;
      return;
    }
    const tabs = `<div class="seg" style="margin-bottom:6px"><button data-a="tab" data-m="signin" class="${m === 'signin' ? 'on' : ''}">Sign in</button><button data-a="tab" data-m="signup" class="${m === 'signup' ? 'on' : ''}">Create account</button></div>`;
    if (m === 'newpass') {
      dlg.innerHTML = `${head('Set a new password')}<form class="acct-form" data-f="newpass">
        <label>New password<input type="password" name="pw" autocomplete="new-password" minlength="6" required></label>
        ${note}<div class="dlg-foot"><button class="btn primary" type="submit">Save password</button></div></form>`;
      return;
    }
    if (m === 'reset') {
      dlg.innerHTML = `${head('Reset your password')}<form class="acct-form" data-f="reset">
        <p class="small muted" style="margin:0">We’ll email you a link to set a new password.</p>
        <label>Email<input type="email" name="email" autocomplete="email" required></label>
        ${note}<div class="dlg-foot"><button class="btn" type="button" data-a="tab" data-m="signin">Back</button><button class="btn primary" type="submit">Send link</button></div></form>`;
      return;
    }
    const up = m === 'signup';
    dlg.innerHTML = `${head(up ? 'Create an account' : 'Sign in')}${tabs}
      <p class="small muted" style="margin:0">Save your rankings, pasted boards, linked league and settings, and get them on any device.</p>
      <form class="acct-form" data-f="${m}">
        <label>Email<input type="email" name="email" autocomplete="email" required></label>
        <label>Password${up ? ' <span class="muted">(at least 6 characters)</span>' : ''}<input type="password" name="pw" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="6" required></label>
        ${up ? '<label>Password again<input type="password" name="pw2" autocomplete="new-password" minlength="6" required></label>' : ''}
        ${note}
        <div class="dlg-foot">${up ? '' : '<button class="linkbtn" type="button" data-a="tab" data-m="reset" style="margin-right:auto">Forgot password?</button>'}<button class="btn primary" type="submit">${up ? 'Create account' : 'Sign in'}</button></div>
      </form>`;
    dlg.querySelector('input')?.focus();
  };

  dlg.onclick = async e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') { dlg.close(); return; }
    if (a === 'tab') { m = b.dataset.m; draw(); return; }
    if (a === 'save') { b.disabled = true; await push(); draw(); return; }
    if (a === 'signout') { await signOut(); dlg.close(); done?.(true); }
  };
  dlg.onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type="submit"]');
    const email = f.email?.value.trim(), pw = f.pw?.value || '';
    const say = (msg, err = true) => { const p = f.querySelector('.acct-msg'); p.textContent = msg; p.classList.toggle('down', err); };
    if (f.dataset.f === 'signup' && pw !== f.pw2.value) { say('The two passwords don’t match.'); return; }
    btn.disabled = true;
    try {
      if (f.dataset.f === 'signin') { await signIn(email, pw); dlg.close(); done?.(true); return; }
      if (f.dataset.f === 'signup') {
        const r = await signUp(email, pw);
        if (r.signedIn) { dlg.close(); done?.(true); return; }
        m = 'signin'; draw(`Check ${email} for a link to confirm your account, then sign in here.`, false); return;
      }
      if (f.dataset.f === 'reset') { await sendReset(email); m = 'signin'; draw(`If there’s an account for ${email}, a reset link is on its way.`, false); return; }
      if (f.dataset.f === 'newpass') { await setPassword(pw); m = 'account'; draw('Password changed.', false); done?.(false); return; }
    } catch (err) { say(err.message); }
    btn.disabled = false;
  };
  draw();
  if (!dlg.open) dlg.showModal();
}
