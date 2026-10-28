'use strict';
/* Alert detail modal: read-only view, Stage 1 acknowledge (note required), Stage 2 resolution request. */
const ACK_SUGGESTIONS = ['Checked cooling fan', 'Reduced load', 'Inspected connections', 'Under investigation'];

function ensureModal() {
  let bg = $('#modalBg');
  if (!bg) {
    bg = document.createElement('div'); bg.id = 'modalBg'; bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><div id="modalBody"></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.remove('open'); });
  }
  return bg;
}

async function openAlert(id, onChange) {
  const bg = ensureModal(); const body = $('#modalBody');
  bg.classList.add('open');
  body.innerHTML = '<p class="muted">Loading…</p>';
  let a;
  try { a = await api('/alerts/' + id); } catch (e) { body.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; return; } // viewing never acknowledges
  const dec = (a.param === 'powerFactor' || a.param === 'vibration' || a.param === 'frequency') ? 2 : 1;
  const stage = a.resolution ? 'Verified resolved' : a.ack ? 'Acknowledged — awaiting resolution' : 'New — not acknowledged';
  let html = `
    <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start">
      <div><h2>${esc(a.name)}</h2><span class="pill s-${a.severity}">${a.severity}</span> <span class="pill s-${a.status}">${a.status}</span></div>
      <button class="btn-sm" id="mClose">Close</button>
    </div>
    <dl class="kv">
      <dt>Raised</dt><dd>${fmtTime(a.startedAt)}</dd>
      ${a.clearedAt ? `<dt>Condition cleared</dt><dd>${fmtTime(a.clearedAt)} (${esc(a.clearReason)})</dd>` : ''}
      <dt>Affected parameter</dt><dd>${esc(a.paramLabel)}</dd>
      <dt>Reading</dt><dd>${num(a.value, dec)} ${esc(a.unit)}</dd>
      <dt>Threshold</dt><dd>${a.threshold} ${esc(a.unit)} (${a.direction === 'high' ? 'above' : 'below'} = ${a.severity.toLowerCase()})</dd>
      <dt>Reason</dt><dd>${esc(a.reason)}</dd>
      <dt>Possible risk</dt><dd>${esc(a.risk)}</dd>
      <dt>Recommended action</dt><dd>${esc(a.action)}</dd>
      <dt>Handling stage</dt><dd><strong>${stage}</strong></dd>
      <dt>Knowledge base</dt><dd><a href="/knowledge?fault=${encodeURIComponent(a.faultKey)}">View ${esc(a.name)} entry</a></dd>
    </dl>`;
  if (a.ack) html += `<div class="notice info"><strong>Acknowledged</strong> by ${esc(a.ack.by)} at ${fmtTime(a.ack.at)}<br>Note: ${esc(a.ack.note)}</div>`;
  if (a.resolution) html += `<div class="notice ok"><strong>Verified resolved</strong> by ${esc(a.resolution.by)} at ${fmtTime(a.resolution.at)}<br>Note: ${esc(a.resolution.note)}<br>Checklist: ${esc((a.resolution.checklist || []).join('; '))}</div>`;
  (a.resolutionRequests || []).filter((r) => r.outcome === 'rejected').forEach((r) => {
    html += `<div class="notice err">Resolution request by ${esc(r.by)} at ${fmtTime(r.at)} was not verified: ${esc(r.reason)}</div>`;
  });

  if (!a.ack && a.status !== 'resolved') {
    html += `<h3>Stage 1 — Acknowledge</h3>
      <p class="small muted">Acknowledging records that you have seen the alert and silences the alarm sound. It does <strong>not</strong> clear the fault.</p>
      <div>${ACK_SUGGESTIONS.map((s) => `<span class="chip" data-s="${esc(s)}">${esc(s)}</span>`).join('')}</div>
      <div class="field"><label for="ackNote">Note (required)</label><textarea id="ackNote" rows="2" maxlength="300" placeholder="What did you check or do?"></textarea></div>
      <button class="btn-primary" id="ackBtn">Acknowledge alert</button> <span id="mErr"></span>`;
  } else if (a.ack && a.status !== 'resolved') {
    html += `<h3>Stage 2 — Resolution</h3>
      <p class="small muted">Tick the corrective actions you completed and add a note. The server only marks the alert "Verified resolved" if the simulated readings are back within the configured safe limits.</p>
      ${(a.checklist || []).map((c, i) => `<label class="check"><input type="checkbox" class="ck" value="${esc(c)}" id="ck${i}"> ${esc(c)}</label>`).join('')}
      <div class="field" style="margin-top:.8rem"><label for="resNote">Resolution note (required)</label><textarea id="resNote" rows="2" maxlength="500"></textarea></div>
      <button class="btn-primary" id="resBtn">Request verification</button> <span id="mErr"></span>`;
  }
  body.innerHTML = html;
  $('#mClose').onclick = () => bg.classList.remove('open');
  $$('.chip', body).forEach((c) => { c.onclick = () => { $('#ackNote').value = c.dataset.s; }; });
  const showErr = (m) => { $('#mErr').innerHTML = `<div class="notice err">${esc(m)}</div>`; };
  const ackBtn = $('#ackBtn');
  if (ackBtn) ackBtn.onclick = async () => {
    const note = $('#ackNote').value.trim();
    if (!note) return showErr('Please enter or choose a note.');
    try { await api(`/alerts/${id}/ack`, { method: 'POST', body: { note } }); toast('Alert acknowledged'); if (onChange) onChange(); openAlert(id, onChange); } catch (e) { showErr(e.message); }
  };
  const resBtn = $('#resBtn');
  if (resBtn) resBtn.onclick = async () => {
    const note = $('#resNote').value.trim();
    const checklist = $$('.ck:checked', body).map((c) => c.value);
    if (!checklist.length) return showErr('Tick at least one completed corrective action.');
    if (!note) return showErr('Please enter a resolution note.');
    try { await api(`/alerts/${id}/resolve`, { method: 'POST', body: { note, checklist } }); toast('Alert verified resolved'); if (onChange) onChange(); openAlert(id, onChange); } catch (e) {
      if (onChange) onChange();
      if (e.status === 422) { await openAlert(id, onChange); $('#modalBody').insertAdjacentHTML('afterbegin', `<div class="notice err"><strong>Not resolved.</strong> ${esc(e.message)}</div>`); } else showErr(e.message);
    }
  };
}
