'use strict';
/* Shared helpers: API wrapper, navigation, toast, voice + alarm sound. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (d) => (d ? new Date(d).toLocaleString() : '—');
const num = (v, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));

async function api(path, opts = {}) {
  const o = { method: 'GET', headers: {}, credentials: 'same-origin', ...opts };
  if (o.body !== undefined && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch('/api' + path, o);
  if (r.status === 401 && !location.pathname.startsWith('/login')) { location.href = '/login'; throw new Error('Signed out'); }
  let data = null;
  try { data = await r.json(); } catch (e) { /* non-JSON */ }
  if (!r.ok) { const err = new Error((data && data.error) || `Request failed (${r.status})`); err.data = data; err.status = r.status; throw err; }
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

/** Renders the simulation banner + navigation and returns the signed-in user. */
async function initPage(active) {
  const me = await api('/auth/me');
  const links = [['/', 'Dashboard'], ['/alerts', 'Alerts'], ['/history', 'History'], ['/report', 'Report'], ['/knowledge', 'Knowledge base']];
  if (me.role === 'admin') links.push(['/thresholds', 'Thresholds'], ['/users', 'Users'], ['/audit', 'Audit log']);
  const nav = document.createElement('div');
  nav.innerHTML = `
    <div class="sim-banner">⚠ SOFTWARE SIMULATION — readings, checks and verifications are demonstrations, not real industrial safety controls.</div>
    <header class="topbar"><div class="topbar-in">
      <a class="brand" href="/"><span class="dot"></span>Generator Monitor</a>
      <nav class="nav">${links.map(([h, t]) => `<a href="${h}" class="${h === active ? 'active' : ''}">${t}</a>`).join('')}</nav>
      <div class="userbox"><span>${esc(me.username)}</span><span class="badge ${me.role}">${me.role}</span><button class="btn-sm" id="logoutBtn">Log out</button></div>
    </div></header>`;
  document.body.prepend(...nav.children);
  $('#logoutBtn').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/login'; };
  return me;
}

const UNIT_WORDS = { V: 'volts', A: 'amperes', Hz: 'hertz', kW: 'kilowatts', '%': 'percent', RPM: 'revolutions per minute', 'mm/s': 'millimetres per second', '°C': 'degrees Celsius', '': '' };

/** Voice announcements using the browser's built-in speechSynthesis only. */
const Voice = {
  supported: typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  muted: store.get('gm_voice_muted', false),
  setMuted(m) { this.muted = m; store.set('gm_voice_muted', m); if (m) this.stop(); },
  stop() { if (this.supported) try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } },
  speak(text) {
    if (!this.supported || this.muted) return;
    try { const u = new SpeechSynthesisUtterance(text); u.rate = 0.95; window.speechSynthesis.speak(u); } catch (e) { /* ignore */ }
  },
};

/** Alarm beep via WebAudio (needs one user click before browsers allow sound). */
const Alarm = {
  ctx: null, timer: null, muted: store.get('gm_alarm_muted', false),
  unlock() { try { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); } catch (e) { /* unsupported */ } },
  beep() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square'; o.frequency.value = 880; g.gain.value = 0.06;
    o.connect(g); g.connect(this.ctx.destination); o.start(); o.stop(this.ctx.currentTime + 0.25);
  },
  /** on = there is an active critical alert that has not been acknowledged. */
  set(on) {
    const should = on && !this.muted;
    if (should && !this.timer) { this.beep(); this.timer = setInterval(() => this.beep(), 1500); }
    if (!should && this.timer) { clearInterval(this.timer); this.timer = null; }
  },
  setMuted(m) { this.muted = m; store.set('gm_alarm_muted', m); if (m) this.set(false); },
};
document.addEventListener('click', () => Alarm.unlock(), { once: true });
