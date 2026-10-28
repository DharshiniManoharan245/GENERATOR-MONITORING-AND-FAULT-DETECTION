'use strict';
const POLL_MS = 1500;
const SIM_LABELS = { overvoltage: 'Overvoltage', undervoltage: 'Undervoltage', overcurrent: 'Overcurrent', overheating: 'Overheating', highVibration: 'High vibration', overspeed: 'Overspeed', underspeed: 'Underspeed' };
const RANK = { INACTIVE: -1, SAFE: 0, WARNING: 1, CRITICAL: 2 };
const announced = new Set();
let settingsCache = { voiceEnabled: true, announceWarnings: false };
let me, charts = {}, busy = false;

/* ---------- charts ---------- */
function mkChart(id, datasets, opts = {}) {
  return new Chart($('#' + id), {
    type: 'line',
    data: { labels: [], datasets: datasets.map(([label, color]) => ({ label, data: [], borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: .3 })) },
    options: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { display: datasets.length > 1, position: 'bottom' } },
      scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { suggestedMin: opts.min, suggestedMax: opts.max } } },
  });
}
function pushPoint(chart, label, vals) {
  chart.data.labels.push(label);
  vals.forEach((v, i) => chart.data.datasets[i].data.push(v));
  if (chart.data.labels.length > 80) { chart.data.labels.shift(); chart.data.datasets.forEach((d) => d.data.shift()); }
  chart.update('none');
}

/* ---------- diagram (driven only by backend statuses) ---------- */
function worst(statuses, keys) {
  let best = 'INACTIVE';
  for (const k of keys) if ((RANK[statuses[k]] ?? -1) > RANK[best]) best = statuses[k];
  return best;
}
function paintComp(id, status, statId) {
  const g = $('#' + id); g.setAttribute('class', 'comp st-' + status.toLowerCase());
  $('#' + statId).textContent = status === 'INACTIVE' ? 'INACTIVE' : status;
}
function renderDiagram(d) {
  const v = d.values, s = d.statuses;
  const running = d.state === 'RUNNING' || d.state === 'STARTING' || d.state === 'STOPPING';
  $('#genSvg').classList.toggle('running', d.state !== 'STOPPED');
  paintComp('g-engine', worst(s, ['rpm', 'bearingTemp', 'vibration']), 'd-estat');
  paintComp('g-alt', worst(s, ['voltage', 'current', 'frequency', 'windingTemp']), 'd-astat');
  paintComp('g-load', worst(s, ['load', 'power', 'powerFactor']), 'd-lstat');
  $('#d-rpm').textContent = `RPM ${num(v.rpm, 0)}`;
  $('#d-etemp').textContent = `Temp ${num(v.bearingTemp, 1)} °C`;
  $('#d-evib').textContent = `Vibration ${num(v.vibration, 2)} mm/s`;
  $('#d-volt').textContent = `${num(v.voltage, 0)} V`;
  $('#d-cur').textContent = `${num(v.current, 1)} A`;
  $('#d-wtemp').textContent = `Winding ${num(v.windingTemp, 1)} °C`;
  $('#d-load').textContent = `Load ${num(v.load, 0)} %`;
  $('#d-kw').textContent = `${num(v.power, 2)} kW`;
  $('#d-loadbar').setAttribute('width', Math.min(130, Math.max(0, v.load / 100 * 130)));
  $('#d-state').textContent = d.state;
  const overall = d.state !== 'RUNNING' ? 'INACTIVE' : d.health.label === 'Critical' ? 'CRITICAL' : d.health.label === 'Degraded' ? 'WARNING' : 'SAFE';
  const dp = $('#diagramState'); dp.className = 'pill s-' + overall;
  dp.textContent = d.state === 'RUNNING' ? `Running · ${d.health.label}` : d.state === 'STOPPED' ? 'Generator stopped' : `Generator ${d.state.toLowerCase()}`;
  return running;
}

/* ---------- cards ---------- */
function renderCards(d) {
  const groups = { Electrical: $('#elec'), Mechanical: $('#mech') };
  if (!groups.Electrical.children.length) {
    for (const [key, p] of Object.entries(d.params)) {
      const el = document.createElement('div'); el.id = 'p-' + key; el.className = 'pcard';
      el.innerHTML = `<div class="lbl">${esc(p.label)}</div><div class="val"><span class="v">—</span><small>${esc(p.unit)}</small></div><span class="pill s-INACTIVE st">INACTIVE</span>`;
      groups[p.group].appendChild(el);
    }
  }
  for (const [key, p] of Object.entries(d.params)) {
    const el = $('#p-' + key), st = d.statuses[key];
    el.className = 'pcard st-' + st;
    $('.v', el).textContent = num(d.values[key], p.decimals);
    const pill = $('.st', el); pill.className = 'pill st s-' + st; pill.textContent = st === 'INACTIVE' ? 'INACTIVE' : st;
  }
  const f = d.values.fuelEfficiency;
  $('#fuelBox').innerHTML = f === null || f === undefined ? '' :
    `<div class="card"><strong>Fuel efficiency (modelled):</strong> ${num(f, 2)} kWh/L at ${num(d.values.fuelRate, 1)} L/h <span class="muted small">— simulated Willans-line model, shown only while running steadily at ≥ 1 kW.</span></div>`;
}

/* ---------- alerts: list, alarm sound, voice ---------- */
function renderAlerts(d) {
  const list = d.activeAlerts;
  $('#alertsBox').innerHTML = list.length ? list.map((a) => `
    <div class="alert-item ${a.severity}">
      <div>
        <span class="pill s-${a.severity}">${a.severity}</span> <strong>${esc(a.name)}</strong>
        <div class="small muted">${fmtTime(a.startedAt)} · ${esc(a.paramLabel)} ${num(a.value, 1)} ${esc(a.unit)} (threshold ${a.threshold} ${esc(a.unit)})</div>
        <div class="small">${esc(a.reason)}</div>
        ${a.ack ? `<div class="small muted">✔ Acknowledged by ${esc(a.ack.by)}: ${esc(a.ack.note)}</div>` : '<div class="small" style="color:#b86500">Not acknowledged</div>'}
      </div>
      <button class="btn-sm" data-id="${a._id}">${a.ack ? 'Resolve…' : 'Details / Acknowledge'}</button>
    </div>`).join('') : '<div class="empty">No active alerts.</div>';
  $$('#alertsBox button').forEach((b) => { b.onclick = () => openAlert(b.dataset.id, refresh); });

  // Alarm sounds for unacknowledged critical alerts only; acknowledging silences it but keeps the visual alert.
  const needSound = list.some((a) => a.severity === 'CRITICAL' && !a.ack);
  Alarm.set(needSound);
  $('#soundHint').style.display = needSound && !Alarm.muted && (!Alarm.ctx || Alarm.ctx.state !== 'running') ? 'block' : 'none';

  // Voice: announce each new alert once.
  for (const a of list) {
    const key = String(a._id);
    if (announced.has(key)) continue;
    announced.add(key);
    if (!settingsCache.voiceEnabled) continue;
    if (a.severity === 'CRITICAL' || (a.severity === 'WARNING' && settingsCache.announceWarnings)) {
      const unit = UNIT_WORDS[a.unit] !== undefined ? UNIT_WORDS[a.unit] : a.unit;
      Voice.speak(`${a.severity === 'CRITICAL' ? 'Critical alert' : 'Warning'}. ${a.name} detected. ${a.paramLabel} is ${num(a.value, 0)} ${unit}.`);
    }
  }
}

function renderControls(d) {
  const pill = $('#statePill'); pill.className = 'pill s-' + d.state; pill.textContent = d.state;
  $('#startBtn').disabled = d.running; $('#stopBtn').disabled = !d.running;
  $('#healthScore').textContent = d.state === 'RUNNING' ? d.health.score : '—';
  const hp = $('#healthPill'); hp.textContent = d.health.label;
  hp.className = 'pill s-' + (d.health.label === 'Healthy' ? 'SAFE' : d.health.label === 'Degraded' ? 'WARNING' : d.health.label === 'Critical' ? 'CRITICAL' : 'INACTIVE');
  const box = $('#faultToggles');
  if (!box.children.length) {
    for (const [k, label] of Object.entries(SIM_LABELS)) {
      const l = document.createElement('label'); l.className = 'toggle'; l.id = 'tg-' + k;
      l.innerHTML = `<span>${label}</span><input type="checkbox" data-k="${k}">`;
      box.appendChild(l);
      $('input', l).onchange = async (e) => {
        try { await api('/generator/fault', { method: 'POST', body: { fault: k, active: e.target.checked } }); } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
        refresh();
      };
    }
  }
  for (const [k] of Object.entries(SIM_LABELS)) { const l = $('#tg-' + k); $('input', l).checked = !!d.simFaults[k]; l.classList.toggle('on', !!d.simFaults[k]); $('input', l).disabled = !d.running; }
}

function renderMuteButtons() {
  $('#alarmBtn').textContent = Alarm.muted ? '🔕 Alarm: muted' : '🔔 Alarm: on';
  $('#voiceBtn').textContent = !Voice.supported ? '🗣 Voice: unsupported' : Voice.muted ? '🔇 Voice: muted' : '🗣 Voice: on';
  $('#voiceBtn').disabled = !Voice.supported; $('#voiceStop').disabled = !Voice.supported;
}

/* ---------- main loop (one poller; backend is the single source of truth) ---------- */
let lastTs = '';
async function refresh() {
  if (busy) return; busy = true;
  try {
    const d = await api('/generator/status');
    settingsCache = d.settings;
    renderControls(d); renderDiagram(d); renderCards(d); renderAlerts(d);
    if (d.ts !== lastTs) {
      lastTs = d.ts;
      const t = new Date(d.ts).toLocaleTimeString(), v = d.values;
      pushPoint(charts.V, t, [v.voltage]); pushPoint(charts.I, t, [v.current]);
      pushPoint(charts.T, t, [v.windingTemp, v.bearingTemp]); pushPoint(charts.R, t, [v.rpm]);
    }
  } catch (e) { if (e.message !== 'Signed out') console.warn(e.message); } finally { busy = false; }
}

(async function init() {
  me = await initPage('/');
  charts.V = mkChart('cV', [['Voltage', '#0f6f8f']], { min: 0, max: 450 });
  charts.I = mkChart('cI', [['Current', '#7c4dff']], { min: 0, max: 20 });
  charts.T = mkChart('cT', [['Winding', '#f08a00'], ['Bearing', '#1f9d55']], { min: 20, max: 120 });
  charts.R = mkChart('cR', [['RPM', '#d93025']], { min: 0, max: 1700 });
  $('#startBtn').onclick = async () => { try { await api('/generator/start', { method: 'POST' }); } catch (e) { toast(e.message); } refresh(); };
  $('#stopBtn').onclick = async () => { try { await api('/generator/stop', { method: 'POST' }); } catch (e) { toast(e.message); } refresh(); };
  $('#clearFaults').onclick = async () => { try { await api('/generator/clear-faults', { method: 'POST' }); } catch (e) { toast(e.message); } refresh(); };
  $('#alarmBtn').onclick = () => { Alarm.setMuted(!Alarm.muted); renderMuteButtons(); refresh(); };
  $('#voiceBtn').onclick = () => { Voice.setMuted(!Voice.muted); renderMuteButtons(); };
  $('#voiceStop').onclick = () => Voice.stop();
  renderMuteButtons();
  refresh(); setInterval(refresh, POLL_MS);
})();
