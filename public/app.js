// §8 — client renders only; no agent logic here. Polls every 8s (§11).
const $ = (sel) => document.querySelector(sel);
const api = (path, opts) => fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts }).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { status: r.status, body });
  return body;
});
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { screen: 'dashboard' };

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

async function renderDashboard() {
  const [d, zones, proposals, flags] = await Promise.all([
    api('/api/dashboard'), api('/api/zones'), api('/api/reallocations'), api('/api/duplicate-flags'),
  ]);

  $('#status-strip').innerHTML = [
    ['Active zones', d.active_zones], ['Critical zones', d.critical_zones],
    ['Units allocated', d.resources_allocated], ['Pending flags', d.pending_reports],
  ].map(([label, v]) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`).join('');

  // Duplicate-report banner (§8) — human review, never auto-merged.
  $('#dup-banner').innerHTML = flags.map((f) => `
    <div class="banner">
      <b>Possible duplicate report</b> — "${esc(f.incoming.name)}" vs ${esc(f.matched_zone_name)}
      <span class="dim">(match score ${f.score} ≥ 3: ${Object.entries(f.components).filter(([, v]) => v > 0).map(([k]) => k).join(', ') || '—'})</span>
      <div class="row">
        <button onclick="resolveFlag('${f.flag_id}','merge')">Merge into ${esc(f.matched_zone_name)}</button>
        <button class="secondary" onclick="resolveFlag('${f.flag_id}','dismiss')">Dismiss (new zone)</button>
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

const feedRow = (r) => `<li><b>${esc(r.action_type)}</b> — ${esc(r.description)}<span class="dim">${esc(r.actor)} · ${new Date(r.timestamp).toLocaleTimeString()}${r.zone_id ? ` · ${esc(r.zone_id)}` : ''}</span></li>`;

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
  const agencies = await api('/api/resource-items').then((rs) => [...new Set(rs.map((r) => r.agency_id))]);
  const allGapped = Object.keys(z.gaps).filter((c) => z.gaps[c] > 0);
  $('#zone-detail').innerHTML = `
    <h3>${esc(z.name)} ${tierBadge(z.tier)} <span class="dim">score ${z.severity_score}</span></h3>
    <div class="dim">${esc(z.location)} · population ${z.population_affected}${z.override_applied ? ' · ⛑ rescue override applied' : ''}</div>
    <h4>Score breakdown</h4>
    <table><tr><th>category</th><th>need</th><th>gap</th><th>ratio</th><th>weight</th></tr>
    ${(breakdown.breakdown?.per_category || []).map((p) => `<tr><td>${p.category}</td><td>${p.need}</td><td>${p.gap}</td><td>${p.gap_ratio}</td><td>${p.weight}</td></tr>`).join('')}
    </table>
    <div class="dim">pressure ×${breakdown.breakdown?.population_pressure} · urgency ×${breakdown.breakdown?.urgency_multiplier}${breakdown.override_applied ? ' · hard override applied' : ''}</div>
    <h4>Claim grid</h4>
    ${allGapped.length ? allGapped.map((c) => `<div class="row"><span>${c}</span>${z.unclaimed_categories.includes(c)
      ? agencies.map((a) => `<button onclick="claim('${z.zone_id}','${c}','${a}')">Claim (${a})</button>`).join('')
      : '<span class="dim">already claimed/allocated</span>'}</div>`).join('')
      : '<p class="dim">No unmet needs.</p>'}
    <h4>Allocation history</h4>
    ${z.allocations.map((a) => `<div class="row dim">[${a.status}] ${a.quantity} ${a.category} — ${esc(a.reason_text)}${a.status === 'confirmed' ? ` <button onclick="deliverAlloc('${a.allocation_id}', '${z.zone_id}')">Confirm delivery (${a.quantity})</button>` : ''}</div>`).join('') || '<p class="dim">None yet.</p>'}
    <h4>Audit trail (this zone)</h4>
    <ul class="feed">${(await api(`/api/audit-log?zone=${zoneId}`)).slice(0, 10).map(feedRow).join('')}</ul>`;
  $('#zone-modal').classList.remove('hidden');
};

window.claim = async (zoneId, category, agencyId) => {
  try {
    await api(`/zones/${zoneId}/claim`, { method: 'POST', body: JSON.stringify({ category, agency_id: agencyId }) });
    await api(`/zones/${zoneId}/deliver`, { method: 'POST', body: JSON.stringify({ category, agency_id: agencyId }) });
  } catch (e) { alert(e.message); }
  openZone(zoneId);
};

$('#zone-modal-close').onclick = () => $('#zone-modal').classList.add('hidden');

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

$('#report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/api/reports', { method: 'POST', body: JSON.stringify({
      name: f.get('name'), location: f.get('location'), population_affected: +f.get('population_affected'),
      needs: [...chosen], rescue_needed: f.get('rescue_needed') === 'on', urgency_high: f.get('urgency_high') === 'on',
    }) });
    $('#report-result').innerHTML = `<div class="banner ${r.status === 'duplicate' ? '' : 'proposal'}">${esc(r.message)}</div>`;
    if (r.status === 'new') show('dashboard');
  } catch (err) {
    $('#report-result').innerHTML = `<div class="banner">${esc(err.message)}</div>`;
  }
});

// ---------- inventory screen ----------
async function renderInventory() {
  const items = await api('/api/resource-items');
  $('#inventory-list').innerHTML = items.map((r) => `
    <div class="card"><h3>${esc(r.category)} <span class="dim">${r.quantity_available} ${esc(r.unit)} · ${esc(r.agency_name)} · ${r.status}</span></h3>
    <div class="row"><button class="secondary" onclick="restock('${r.resource_id}')">Restock +10</button></div></div>`).join('');
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
  const rows = await api(`/api/audit-log?${new URLSearchParams({ ...(zone && { zone }), ...(actor && { actor }) })}`);
  $('#audit-list').innerHTML = rows.map(feedRow).join('') || '<li class="dim">No matching entries.</li>';
}
$('#audit-refresh').onclick = renderAudit;

show('dashboard');
setInterval(() => { if (state.screen === 'dashboard') renderDashboard(); }, 8000); // §11: 5–10s poll


