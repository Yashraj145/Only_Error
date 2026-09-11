// §8 — client renders only; no agent logic here. Polls every 8s (§11).
const $ = (sel) => document.querySelector(sel);
const api = (path, opts) => fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts }).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || (body.existing_claim_agency ? 'Already claimed by ' + body.existing_claim_agency : r.statusText)), { status: r.status, body });
  return body;
});
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { screen: 'dashboard' };
import { readQueue, enqueueReport, flushQueue } from './reportQueue.js';

function show(screen) {
  state.screen = screen;
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`#screen-${screen}`).classList.add('active');
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.screen === screen));
  if (screen === 'dashboard') renderDashboard();
  if (screen === 'inventory') renderInventory();
  if (screen === 'audit') renderAudit();
}

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-screen]');
  if (btn) show(btn.dataset.screen);
});

const tierBadge = (tier) => `<span class="badge ${tier}">${tier}</span>`;
document.querySelector('button.link[data-screen="audit"]').onclick = () => show('audit');

async function renderDashboard() {
  const [d, zones, proposals, flags] = await Promise.all([
    api('/api/dashboard'), api('/api/zones'), api('/api/reallocations'), api('/api/duplicate-flags'),
  ]);

  $('#status-strip').innerHTML = [
    ['Active zones', d.active_zones], ['Critical zones', d.critical_zones],
    ['Units allocated', d.resources_allocated], ['Pending flags', d.pending_reports],
    ['Pending claims', zones.reduce((n,z) => n + z.claims.filter(c => c.status === 'pending').length, 0)],
  ].map(([label, v]) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`).join('');
  const urgent = zones.filter(z => z.tier === 'critical' && z.unclaimed_categories.length);
  $('#critical-needs').innerHTML = urgent.length ? `<div class="banner"><b>Critical needs awaiting an agency</b>${urgent.map(z => `<div>${esc(z.name)}: ${z.unclaimed_categories.join(', ')}</div>`).join('')}</div>` : '';

  // Duplicate-report banner (§8) — human review, never auto-merged.
  $('#dup-banner').innerHTML = flags.map((f) => `
    <div class="banner">
      <b>Possible duplicate report</b> — "${esc(f.incoming.name)}" vs ${esc(f.matched_zone_name)}
      <span class="dim">(match score ${f.score} ≥ 3: ${Object.entries(f.components).filter(([, v]) => v > 0).map(([k]) => k).join(', ') || '—'})</span>
      <div class="row">
        <button onclick="resolveFlag('${f.flag_id}','merge')">Merge into ${esc(f.matched_zone_name)}</button>
        <button class="secondary" onclick="resolveFlag('${f.flag_id}','dismiss')">Keep as new report</button>
      </div>
    </div>`).join('');

  // v2 re-allocation proposal card (§8) — Accept / Dismiss, same pattern.
  $('#proposal-card').innerHTML = proposals.map((p) => `
    <div class="banner proposal">
      <b>Re-allocation proposal</b> — Divert ${p.quantity} ${esc(p.category)} units ${esc(p.from_zone_name)} → ${esc(p.to_zone_name)}?
      <div class="dim">${esc(p.reason_text)}</div>
      <div class="row">
        <button onclick="decideProposal('${p.allocation_id}','accept')">Accept</button>
        <button class="secondary" onclick="decideProposal('${p.allocation_id}','dismiss')">Dismiss</button>
      </div>
    </div>`).join('');

  $('#zone-list').innerHTML = zones.map((z) => `
    <div class="card t-${z.tier}">
      <h3>${esc(z.name)} ${tierBadge(z.tier)}</h3>
      <div class="dim">Score ${z.severity_score} · pop ${z.population_affected} · needs: ${z.needs.join(', ') || '—'}${z.override_applied ? ' · ⛑ rescue override' : ''}</div>
      <div class="dim">Gaps: ${Object.entries(z.gaps).filter(([, g]) => g > 0).map(([c, g]) => `${c}: ${g}`).join(' · ') || 'none'}</div>
      ${z.tier === 'critical' && z.unclaimed_categories.length ? `<div class="row">⚠ unclaimed: ${z.unclaimed_categories.join(', ')}</div>` : ''}
      <div class="row"><button onclick="openZone('${z.zone_id}')">Detail · claims · history</button></div>
    </div>`).join('') || '<p class="dim">No zones.</p>';

  $('#inventory-summary').innerHTML = Object.entries(d.inventory_totals)
    .map(([c, q]) => `<div class="stat" style="border-left:4px solid var(--accent)"><b>${q}</b><span>${c} available</span></div>`).join('');

  $('#activity-feed').innerHTML = d.audit_excerpt.map(feedRow).join('') || '<li class="dim">No activity yet.</li>';
}

const feedRow = (r) => `<li><details><summary><b>${esc(r.action_type)}</b> — ${esc(r.description)}</summary><span class="dim">${esc(r.actor)} · ${new Date(r.timestamp).toLocaleString()} · Zone ${esc(r.zone_id)} · Resource ${esc(r.resource_id)} · Allocation ${esc(r.allocation_id)} · ${esc(r.log_id)}</span></details></li>`;

window.resolveFlag = async (id, action) => {
  await api(`/api/duplicate-flags/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action }) });
  renderDashboard();
};

window.decideProposal = async (id, action) => {
  await api(`/api/reallocations/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
  renderDashboard();
};

// ---------- zone detail: gap breakdown + claim grid + allocation history (§7) ----------
window.openZone = async (zoneId) => {
  const z = await api('/api/zones').then((zs) => zs.find((x) => x.zone_id === zoneId));
  const breakdown = await api(`/zones/${zoneId}/score-breakdown`);
  const agencies = await api('/api/agencies');
  const allGapped = [...new Set([...z.needs, ...(z.rescue_needed ? ['rescue'] : [])])];
  $('#zone-detail').innerHTML = `
    <h3>${esc(z.name)} ${tierBadge(z.tier)} <span class="dim">score ${z.severity_score}</span></h3>
    <div class="dim">${esc(z.location)} · population ${z.population_affected}${z.override_applied ? ' · ⛑ rescue override applied' : ''}</div>
    <h4>Score breakdown</h4>
    <table><tr><th>category</th><th>need</th><th>gap</th><th>ratio</th><th>weight</th></tr>
    ${(breakdown.breakdown?.per_category || []).map((p) => `<tr><td>${p.category}</td><td>${p.need}</td><td>${p.gap}</td><td>${p.gap_ratio}</td><td>${p.weight}</td></tr>`).join('')}
    </table>
    <div class="dim">pressure ×${breakdown.breakdown?.population_pressure} · urgency ×${breakdown.breakdown?.urgency_multiplier}${breakdown.override_applied ? ' · hard override applied' : ''}</div>
    <button onclick="editZone('${z.zone_id}')">Update Situation</button>
    <h4>Claim grid</h4>
    ${allGapped.length ? allGapped.map((c) => `<div class="card"><b>${c}</b> · outstanding ${z.outstanding_needs[c]}<div class="row"><label>Quantity<input id="qty-${c}" type="number" min="1" value="${Math.max(1,z.outstanding_needs[c])}" /></label>
      ${agencies.map((a) => `<button onclick="claim('${z.zone_id}','${c}','${a.agency_id}')">Claim · ${esc(a.name)}</button>`).join('')}</div></div>`).join('')
      : '<p class="dim">No unmet needs.</p>'}
    <h4>Agency commitments</h4>
    ${z.claims.map(c => `<div class="row">${esc(agencies.find(a => a.agency_id === c.agency_id)?.name)} · ${esc(c.category)} · ${c.quantity ?? 'outstanding need'} · ${esc(c.status)} · ${new Date(c.timestamp).toLocaleTimeString()} ${c.status === 'pending' ? `<button onclick="deliverClaim('${z.zone_id}','${c.category}','${c.agency_id}')">Confirm Delivery</button>` : ''}</div>`).join('') || '<p>No pending claims.</p>'}
    <h4>Allocation history</h4>
    ${z.allocations.map((a) => `<div class="row dim">[${a.status}] ${a.quantity} ${a.category} — ${esc(a.reason_text)}${a.status === 'confirmed' ? ` <button onclick="deliverAlloc('${a.allocation_id}', '${z.zone_id}')">Confirm delivery (${a.quantity})</button>` : ''}</div>`).join('') || '<p class="dim">None yet.</p>'}
    <h4>Audit trail (this zone)</h4>
    <ul class="feed">${(await api(`/api/audit-log?zone=${zoneId}`)).slice(0, 10).map(feedRow).join('')}</ul>`;
  $('#zone-modal').classList.remove('hidden');
};

window.claim = async (zoneId, category, agencyId) => {
  try {
    await api(`/zones/${zoneId}/claim`, { method: 'POST', body: JSON.stringify({ category, agency_id: agencyId, quantity: Number($('#qty-' + category).value) }) });
  } catch (e) { alert(e.message); }
  openZone(zoneId);
};

$('#zone-modal-close').onclick = () => $('#zone-modal').classList.add('hidden');
window.deliverClaim = async (zoneId, category, agencyId) => {
  await api(`/zones/${zoneId}/deliver`, { method: 'POST', body: JSON.stringify({ category, agency_id: agencyId }) });
  await openZone(zoneId);
  await renderDashboard();
};
window.editZone = async zoneId => {
  const z = (await api('/api/zones')).find(z => z.zone_id === zoneId);
  $('#zone-detail').innerHTML = `<h3>Update ${esc(z.name)}</h3><form id="update-form"><label>Population affected<input name="population_affected" type="number" min="0" required value="${z.population_affected}" /></label>
    <fieldset><legend>Resource needs</legend>${CATEGORIES.map(c => `<label class="check"><input type="checkbox" name="needs" value="${c}" ${z.needs.includes(c) ? 'checked' : ''} />${c}</label>`).join('')}</fieldset>
    <label class="check"><input type="checkbox" name="rescue_needed" ${z.rescue_needed ? 'checked' : ''} />Rescue needed</label><label class="check"><input type="checkbox" name="urgency_high" ${z.urgency_high ? 'checked' : ''} />Urgent</label><button>Save Situation</button></form>`;
  $('#update-form').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    await api(`/zones/${zoneId}/update`, { method: 'POST', body: JSON.stringify({ population_affected: Number(f.get('population_affected')), needs: f.getAll('needs'), rescue_needed: f.has('rescue_needed'), urgency_high: f.has('urgency_high') }) });
    await openZone(zoneId); await renderDashboard();
  };
};

window.deliverAlloc = async (allocationId, zoneId) => {
  try {
    await api(`/api/allocations/${allocationId}/deliver`, { method: 'POST', body: JSON.stringify({}) });
  } catch (e) { alert(e.message); }
  openZone(zoneId);
};


// ---------- report screen (§8: mode → details → resource needs → submit) ----------
const CATEGORIES = ['water', 'medical', 'food', 'shelter'];
const chosen = new Set(['water']);
$('#need-chips').innerHTML = CATEGORIES.map((c) => `<span class="chip${c === 'water' ? ' on' : ''}" data-c="${c}">${c}</span>`).join('');
$('#need-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  chip.classList.toggle('on');
  chip.classList.contains('on') ? chosen.add(chip.dataset.c) : chosen.delete(chip.dataset.c);
});

let reportStep = 0;
function reportData() {
  const f = new FormData($('#report-form'));
  return { name: f.get('name').trim(), location: f.get('location').trim(), population_affected: Number(f.get('population_affected')), needs: [...chosen], rescue_needed: f.has('rescue_needed'), urgency_high: f.has('urgency_high') };
}
function showReportStep(step) {
  reportStep = step;
  document.querySelectorAll('[data-report-step]').forEach(el => el.hidden = Number(el.dataset.reportStep) !== step);
  $('#report-step-label').textContent = `Step ${step + 1} of 4 · ${['Zone details', 'Resource needs', 'Urgency', 'Review'][step]}`;
  $('#report-back').hidden = step === 0; $('#report-next').hidden = step === 3; $('#report-submit').hidden = step !== 3;
  if (step === 3) { const r = reportData(); $('#report-review').innerHTML = `<h3>${esc(r.name)}</h3><p>${esc(r.location)} · ${r.population_affected} people</p><p>Needs: ${r.needs.join(', ')}</p><p>Rescue: ${r.rescue_needed ? 'Yes' : 'No'} · Urgent: ${r.urgency_high ? 'Yes' : 'No'}</p>`; }
}
$('#report-next').onclick = () => { if (reportStep === 0 && !$('#report-form').reportValidity()) return; showReportStep(Math.min(3, reportStep + 1)); };
$('#report-back').onclick = () => showReportStep(Math.max(0, reportStep - 1));
$('#use-location').onclick = () => {
  if (!navigator.geolocation) return reportError(new Error('Location unavailable; enter a landmark manually.'));
  navigator.geolocation.getCurrentPosition(p => { $('#report-form input[name=location]').value = `${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`; }, () => reportError(new Error('Location unavailable; enter a landmark manually.')));
};
let syncing = false;
function queuedReports() { return readQueue(localStorage); }
function connectionState() { $('#connection-status').textContent = `${navigator.onLine ? 'Connected' : 'Offline'} · ${queuedReports().length} queued reports. Offline reports await server scoring.`; }
async function syncReports() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    await flushQueue(localStorage, first => api('/api/reports', { method: 'POST', body: JSON.stringify(first) }));
    connectionState();
  } catch (error) { reportError(new Error(`Report saved locally; retry pending. ${error.message}`)); }
  finally { syncing = false; }
}
window.addEventListener('online', syncReports);
window.addEventListener('offline', connectionState);
$('#report-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (reportStep !== 3) return;
  $('#report-submit').disabled = true;
  const report = { ...reportData(), request_id: crypto.randomUUID() };
  try {
    if (!navigator.onLine) throw new TypeError('Offline');
    const r = await api('/api/reports', { method: 'POST', body: JSON.stringify(report) });
    $('#report-result').textContent = r.status === 'duplicate' ? r.message + '. Open Dashboard to review.' : r.message;
  } catch (error) {
    if (error.status) { $('#report-result').textContent = error.message; return; }
    enqueueReport(localStorage, report);
    $('#report-result').textContent = 'Report saved on this device. It will sync when connectivity returns.';
  } finally { $('#report-submit').disabled = false; connectionState(); }
  showReportStep(0);
});
connectionState();
syncReports();

// ---------- inventory screen ----------
async function renderInventory() {
  if ($('#screen-inventory').contains(document.activeElement) && document.activeElement.matches('input, select')) return;
  const items = await api('/api/resource-items');
  $('#inventory-list').innerHTML = items.map((r) => `
    <div class="card"><h3>${esc(r.category)} <span class="dim">${r.quantity_available} ${esc(r.unit)} · ${esc(r.agency_name)} · ${r.status}</span></h3>
    <div class="row"><label>Available quantity<input type="number" min="0" id="stock-${r.resource_id}" value="${r.quantity_available}" /></label><button onclick="saveStock('${r.resource_id}')">Save quantity</button><button class="secondary" onclick="restock('${r.resource_id}')">Restock +10</button></div></div>`).join('');
  const agencySel = $('#inventory-form select[name=agency_id]');
  if (!agencySel.options.length) {
    const agencies = await api('/api/resource-items').then((rs) => [...new Set(rs.map((r) => r.agency_id))]);
    agencySel.innerHTML = agencies.map((a) => `<option>${a}</option>`).join('');
    $('#inventory-form select[name=category]').innerHTML = [...CATEGORIES, 'rescue'].map((c) => `<option>${c}</option>`).join('');
  }
}
window.restock = async (resourceId) => {
  const items = await api('/api/resource-items');
  const item = items.find((r) => r.resource_id === resourceId);
  await api('/api/resource-items', { method: 'POST', body: JSON.stringify({ resource_id: resourceId, quantity_available: item.quantity_available + 10 }) });
  renderInventory();
};
$('#inventory-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('/api/resource-items', { method: 'POST', body: JSON.stringify(Object.fromEntries([...f.entries()].map(([k, v]) => [k, k === 'quantity_available' ? +v : v]))) });
  $('#inventory-result').innerHTML = '<div class="banner proposal">Resource added.</div>';
  renderInventory();
});

// ---------- audit screen (§8: full filterable feed) ----------
async function renderAudit() {
  const zone = $('#audit-zone').value.trim(), actor = $('#audit-actor').value.trim();
  const action = $('#audit-action').value.trim(), resource = $('#audit-resource').value.trim();
  const rows = await api(`/api/audit-log?${new URLSearchParams({ ...(zone && { zone }), ...(actor && { actor }), ...(action && { action }), ...(resource && { resource }) })}`);
  $('#audit-list').innerHTML = rows.map(feedRow).join('') || '<li class="dim">No matching entries.</li>';
}
$('#audit-refresh').onclick = renderAudit;

$('#reset-demo').onclick = async () => {
  if (!confirm('Reset all demo reports, claims and deliveries to the four-zone starting scenario?')) return;
  await api('/api/seed', { method: 'POST' });
  $('#zone-modal').classList.add('hidden');
  await renderDashboard();
};
window.saveStock = async resourceId => {
  await api('/api/resource-items', { method: 'POST', body: JSON.stringify({ resource_id: resourceId, quantity_available: Number($('#stock-' + resourceId).value) }) });
  await renderInventory();
};
show('dashboard');
setInterval(() => { if (state.screen === 'dashboard') renderDashboard().catch(reportError); if (state.screen === 'inventory') renderInventory().catch(reportError); if (state.screen === 'audit') renderAudit().catch(reportError); syncReports(); }, 8000);
function reportError(error) { $('#connection-status').textContent = error.message || 'Connection unavailable'; }
window.addEventListener('unhandledrejection', e => { reportError(e.reason); e.preventDefault(); });


