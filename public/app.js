// §8 — client renders only; no agent logic here.
const $ = (sel) => document.querySelector(sel);
const api = (path, opts) => fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts }).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || (body.existing_claim_agency ? 'Already claimed by ' + body.existing_claim_agency : r.statusText)), { status: r.status, body });
  return body;
});
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { screen: null };
// Keep live-event bursts to one request batch at a time, with one trailing refresh.
const refreshJobs = new Map();
function refreshOnce(key, load) {
  const running = refreshJobs.get(key);
  if (running) { running.again = true; return running.promise; }
  const job = { again: false };
  refreshJobs.set(key, job);
  job.promise = (async () => {
    do { job.again = false; await load(); } while (job.again && !document.hidden);
  })().finally(() => refreshJobs.delete(key));
  return job.promise;
}
const renderedHTML = new WeakMap();
function updateHTML(selector, html) {
  const element = $(selector);
  if (renderedHTML.get(element) === html) return;
  element.innerHTML = html;
  renderedHTML.set(element, html);
}
const agencyNames = { AG1: 'National Disaster Response Force (NDRF)', AG2: 'State Disaster Response Force (SDRF)', AG3: 'Indian Red Cross Society (IRCS)' };
const readableAgency = value => String(value ?? '').replace(/\bAG[123]\b/g, id => agencyNames[id]);
const screens = {
  dashboard: ['Response overview', 'Prioritise urgent needs and coordinate the next response.'],
  report: ['Report an incident', 'Share what is happening and which resources are needed.'],
  inventory: ['Relief resources', 'Review available supplies and update agency stock.'],
  sitrep: ['Situation report', 'Review the current response and share a briefing.'],
  simulation: ['Response simulation', 'Rehearse disaster scenarios in this demo workspace.'],
  audit: ['Activity log', 'Trace reports, agency commitments and resource deliveries.']
};
function updateThemeControl() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#theme-toggle').setAttribute('aria-checked', String(dark));
  $('#theme-label').textContent = dark ? 'Dark mode' : 'Light mode';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#101a1b' : '#087f70';
}
$('#theme-toggle').onclick = () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('sanjeevani-theme', document.documentElement.dataset.theme); } catch {}
  updateThemeControl();
};
updateThemeControl();
$('#new-report').onclick = () => show('report');
document.querySelector('.brand').onclick = e => { e.preventDefault(); show('dashboard'); };
import { readQueue, enqueueReport, flushQueue } from './reportQueue.js';
let map = null;
let zoneMarkers = {};
let generatedPositions = {}; // store fake coords so they don't jump

function initMap() {
  if (map || typeof L === 'undefined') return;
  try {
    map = L.map('map-container', {
      scrollWheelZoom: false,
      dragging: !window.matchMedia('(pointer: coarse)').matches,
      tap: false
    }).setView([20.5, 78.9], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: ' OpenStreetMap'
    }).addTo(map);
  } catch (e) {
    console.error("Leaflet init failed", e);
  }
}

function zoneLatLng(index, total) {
  const angle = (index / total) * 2 * Math.PI;
  const radius = 0.5 + Math.random() * 1.5;
  return [20.5 + Math.sin(angle) * radius, 78.9 + Math.cos(angle) * radius];
}

const AGENCY_BASES = {
  AG1: { name: 'NDRF demo base', latlng: [21.25, 78.35], color: '#087568', icon: '' },
  AG2: { name: 'SDRF demo base', latlng: [19.95, 79.15], color: '#b24c13', icon: '' },
  AG3: { name: 'IRCS demo base', latlng: [20.85, 79.55], color: '#447895', icon: '' }
};

let showCorridors = true;
let agencyMarkers = {};
let corridorLines = [];

function updateMap(zones, allocations = []) {
  if (!map) return;
  
  // Remove old zone markers that aren't in current zones
  const currentZoneIds = new Set(zones.map(z => z.zone_id));
  Object.keys(zoneMarkers).forEach(id => {
    if (!currentZoneIds.has(id)) {
      map.removeLayer(zoneMarkers[id]);
      delete zoneMarkers[id];
    }
  });

  // Plot Responding Agency Headquarters
  Object.entries(AGENCY_BASES).forEach(([agId, base]) => {
    if (!agencyMarkers[agId]) {
      const icon = L.divIcon({
        className: 'agency-icon',
        html: `<div style=" padding:3px 8px; display:inline-flex; align-items:center; gap:4px;">${base.icon} ${esc(base.name.split(' ')[0])}</div>`,
        iconSize: [85, 24],
        iconAnchor: [42, 12]
      });
      agencyMarkers[agId] = L.marker(base.latlng, { icon }).addTo(map);
      agencyMarkers[agId].bindPopup(`<b> ${esc(base.name)}</b><br><span class="dim">Strategic Dispatch Base · Ready</span>`);
    }
  });

  zones.forEach((z, i) => {
    if (!generatedPositions[z.zone_id]) {
      generatedPositions[z.zone_id] = zoneLatLng(i, zones.length || 1);
    }
    const latlng = generatedPositions[z.zone_id];
    const colors = { critical: 'var(--critical)', high: 'var(--high)', moderate: '#eab308', low: 'var(--low)' };
    const radius = Math.max(8, Math.min(25, z.population_affected / 100));
    
    if (!zoneMarkers[z.zone_id]) {
      zoneMarkers[z.zone_id] = L.circleMarker(latlng, {
        color: colors[z.tier],
        fillColor: colors[z.tier],
        fillOpacity: 0.7,
        radius: radius,
        className: z.tier === 'critical' ? 'pulse' : ''
      }).addTo(map);
      zoneMarkers[z.zone_id].on('click', () => openZone(z.zone_id));
    } else {
      zoneMarkers[z.zone_id].setRadius(radius);
      zoneMarkers[z.zone_id].setStyle({
        color: colors[z.tier], fillColor: colors[z.tier], className: z.tier === 'critical' ? 'pulse' : ''
      });
    }
    
    zoneMarkers[z.zone_id].bindPopup(`
      <b>${esc(z.name)}</b> <span class="badge ${z.tier}">${z.tier}</span><br>
      Score: ${z.severity_score}<br>
      Top gaps: ${Object.entries(z.gaps).filter(([,g])=>g>0).map(([c])=>c).join(', ') || 'none'}
    `);
  });

  // Redraw animated supply corridors
  corridorLines.forEach(line => map.removeLayer(line));
  corridorLines = [];

  if (showCorridors && allocations.length > 0) {
    allocations.forEach(a => {
      if (a.status === 'confirmed' || a.status === 'allocated' || a.status === 'pending') {
        const zonePos = generatedPositions[a.zone_id];
        if (!zonePos) return;
        const baseKey = a.agency_id;
        const base = AGENCY_BASES[baseKey];
        if (!base) return;

        const line = L.polyline([base.latlng, zonePos], {
          color: base.color,
          weight: 3,
          dashArray: '6, 8',
          opacity: 0.85
        }).addTo(map);

        line.bindPopup(`
          <b> Active Supply Corridor</b><br>
          From: ${esc(base.name)}<br>
          To: ${esc(a.zone_name || a.zone_id)}<br>
          Dispatched: <b>${a.quantity} ${esc(a.category)}</b> [${a.status}]
        `);
        corridorLines.push(line);
      }
    });
  }
}

function show(screen) {
  if (!screens[screen]) return;
  const alreadyVisible = state.screen === screen && $(`#screen-${screen}`).classList.contains('active');
  if (alreadyVisible) return;
  state.screen = screen;
  $('#app-status').textContent = screen === 'report' ? '' : 'Loading…';
  const loadScreen = async work => {
    try { await work(); if (state.screen === screen) $('#app-status').textContent = ''; }
    catch (error) { if (state.screen === screen) reportError(error); }
  };
  $('#page-title').textContent = screens[screen][0];
  $('#page-description').textContent = screens[screen][1];
  $('#new-report').hidden = screen === 'report';
  document.title = `${screens[screen][0]} | Sanjeevani`;
  window.scrollTo({ top: 0, behavior: 'instant' });
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(`screen-${screen}`);
  if (el) el.classList.add('active');
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.screen === screen));
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-current', b.dataset.screen === screen ? 'page' : 'false'));
  if (screen === 'dashboard') {
    initMap();
    loadScreen(renderDashboard);
    requestAnimationFrame(() => { if (map && state.screen === 'dashboard') map.invalidateSize({ pan: false }); });
  }
  if (screen === 'report') setupVoiceDispatcher();
  if (screen === 'inventory') loadScreen(renderInventory);
  if (screen === 'audit') loadScreen(renderAudit);
  if (screen === 'sitrep') {
    loadScreen(renderSitrep);
    setupVoiceBriefing();
  }
  if (screen === 'simulation') loadScreen(renderSimulation);
}

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-screen]');
  if (btn) show(btn.dataset.screen);
});

const tierBadge = (tier) => `<span class="badge ${tier}">${tier}</span>`;
document.querySelector('button.link[data-screen="audit"]').onclick = () => show('audit');

let eventSource = null;
let liveRefreshTimer = null;
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('update', (e) => {
    try {
      const event = JSON.parse(e.data);
      if (state.screen === 'simulation') appendSimLog(event);
      if (!liveRefreshTimer && !document.hidden) {
        liveRefreshTimer = setTimeout(() => {
          liveRefreshTimer = null;
          if (document.hidden) return;
          if (state.screen === 'dashboard') renderDashboard().catch(reportError);
          if (state.screen === 'sitrep') renderSitrep().catch(reportError);
          if (state.screen === 'audit') renderAudit().catch(reportError);
          if (state.screen === 'simulation') updateSimStatus().catch(reportError);
        }, 120);
      }
    } catch(err) {
      console.error(err);
    }
  });
  // EventSource reconnects automatically; extra timers create duplicate connections.
}
connectSSE();

let prevStats = {};

function renderDashboard() { return refreshOnce('dashboard', loadDashboard); }
let mapSnapshot = '';
async function loadDashboard() {
  const [d, zones, proposals, flags, forecasts, agencies, allocations] = await Promise.all([
    api('/api/dashboard'), api('/api/zones'), api('/api/reallocations'), api('/api/duplicate-flags'),
    api('/api/forecasts').catch(() => ({})), api('/api/agencies').catch(() => []),
    api('/api/allocations').catch(() => [])
  ]);

  const nextMapSnapshot = JSON.stringify([zones, allocations, showCorridors]);
  if (nextMapSnapshot !== mapSnapshot) {
    updateMap(zones, allocations);
    mapSnapshot = nextMapSnapshot;
  }

  const btnCorridors = $('#btn-toggle-corridors');
  if (btnCorridors && !btnCorridors.__bound) {
    btnCorridors.__bound = true;
    btnCorridors.onclick = () => {
      showCorridors = !showCorridors;
      btnCorridors.textContent = `Supply routes: ${showCorridors ? 'on' : 'off'}`;
      btnCorridors.setAttribute('aria-pressed', String(showCorridors));
      renderDashboard();
    };
  }

  const getArrow = (k, v) => {
    if (prevStats[k] === undefined) return '';
    if (v > prevStats[k]) return '<span >↑</span>';
    if (v < prevStats[k]) return '<span >↓</span>';
    return '';
  };

  const pendingClaims = zones.reduce((n, z) => n + (z.claims ? z.claims.filter(c => c.status === 'pending').length : 0), 0);
  updateHTML('#status-strip', [
    ['Active zones', d.active_zones, 'active_zones'],
    ['Critical zones', d.critical_zones, 'critical_zones'],
    ['Units allocated', d.resources_allocated, 'resources_allocated'],
    ['Reports to review', d.pending_reports, 'pending_reports'],
    ['Agency commitments', pendingClaims, 'pending_claims'],
  ].map(([label, v, k]) => `<div class="stat"><b>${Number(v).toLocaleString('en-IN')} ${getArrow(k, v)}</b><span>${label}</span></div>`).join(''));
  
  prevStats = { active_zones: d.active_zones, critical_zones: d.critical_zones, resources_allocated: d.resources_allocated, pending_reports: d.pending_reports, pending_claims: pendingClaims };

  const urgent = zones.filter(z => z.tier === 'critical' && z.unclaimed_categories && z.unclaimed_categories.length);
  if ($('#critical-needs')) {
    updateHTML('#critical-needs', urgent.length ? `<div class="banner"><b>Critical needs awaiting an agency</b>${urgent.map(z => `<div>${esc(z.name)}: ${z.unclaimed_categories.join(', ')} <button class="link" onclick="openZone('${z.zone_id}')">Coordinate response →</button></div>`).join('')}</div>` : '<p class="dim">No unclaimed critical needs. Continue monitoring incoming reports.</p>');
  }

  if (forecasts && forecasts.alerts && forecasts.alerts.length > 0) {
    updateHTML('#forecast-alerts', forecasts.alerts.map(a => `<div class="banner"> <b>ALERT</b> — ${esc(a)}</div>`).join(''));
  } else {
    updateHTML('#forecast-alerts', '');
  }

  updateHTML('#dup-banner', flags.map((f) => `
    <div class="banner">
      <b>Possible duplicate report</b> — "${esc(f.incoming.name)}" vs ${esc(f.matched_zone_name)}
      <span class="dim">(match score ${f.score} ≥ 3: ${Object.entries(f.components).filter(([, v]) => v > 0).map(([k]) => k).join(', ') || '—'})</span>
      <div class="row">
        <button onclick="resolveFlag('${f.flag_id}','merge')">Merge into ${esc(f.matched_zone_name)}</button>
        <button class="secondary" onclick="resolveFlag('${f.flag_id}','dismiss')">Keep as new report</button>
      </div>
    </div>`).join(''));

  updateHTML('#proposal-card', proposals.map((p) => `
    <div class="banner proposal">
      <b>Re-allocation proposal</b> — Divert ${p.quantity} ${esc(p.category)} units ${esc(p.from_zone_name)} → ${esc(p.to_zone_name)}?
      <div class="dim">${esc(p.reason_text)}</div>
      <div class="row">
        <button onclick="decideProposal('${p.allocation_id}','accept')">Accept</button>
        <button class="secondary" onclick="decideProposal('${p.allocation_id}','dismiss')">Dismiss</button>
      </div>
    </div>`).join(''));

  updateHTML('#zone-list', zones.map((z) => `
    <div class="card t-${z.tier}">
      <h3>${esc(z.name)} ${tierBadge(z.tier)}</h3>
      <div class="dim">Score ${z.severity_score} · pop ${z.population_affected} · needs: ${z.needs.join(', ') || '—'}${z.override_applied ? ' ·  rescue override' : ''}</div>
      <div class="dim">Gaps: ${Object.entries(z.gaps).filter(([, g]) => g > 0).map(([c, g]) => `${c}: ${g}`).join(' · ') || 'none'}</div>
      ${z.tier === 'critical' && z.unclaimed_categories.length ? `<div class="row critical">Awaiting agency: ${z.unclaimed_categories.join(', ')}</div>` : ''}
      <div class="row"><button onclick="openZone('${z.zone_id}')">View needs & coordinate</button></div>
    </div>`).join('') || '<p class="dim">No zones.</p>');

  if ($('#agency-coordination')) {
    updateHTML('#agency-coordination', (agencies || []).map(ag => `
      <div class="card" >
        <div class="agency-heading">
          <b>${esc(ag.name)}</b>
          <span class="badge" >${ag.type === 'government' ? 'Government response' : 'Humanitarian relief'}</span>
        </div>
        <div class="dim" style="margin-top:6px;">
          Stock available: <b>${ag.total_units_stocked}</b> units
        </div>
        <div class="dim" style="margin-top:4px;">
          Active commitments: <b>${ag.active_claims}</b> · Allocated: <b>${ag.converted_claims}</b>
        </div>
        ${ag.duplicate_attempts_blocked > 0 ? `<div style=" margin-top:6px;"> <b>${ag.duplicate_attempts_blocked}</b> conflict(s) blocked by ledger</div>` : `<div class="dim" style=" margin-top:6px;"> 0 conflicts (clean coordination)</div>`}
      </div>
    `).join('') || '<p class="dim">No active agencies.</p>');
  }

  updateHTML('#inventory-summary', Object.entries(d.inventory_totals)
    .map(([c, q]) => {
      let fData = forecasts?.resource_forecasts?.find(r => r.category === c);
      let etaStr = '';
      if (fData && fData.hours_to_depletion != null && fData.hours_to_depletion < Infinity) {
        etaStr = `<span class="dim" style=" margin-left: 8px;">Depletes in ${fData.hours_to_depletion.toFixed(1)}h</span>`;
      }
      return `<div class="stat" style="border-left:4px solid var(--accent); position:relative; overflow:hidden;">
        <div style="position:absolute; bottom:0; left:0; height:4px; width:${Math.min(100, q)}%; opacity: 0.5;"></div>
        <b>${q}</b><span>${c} available ${etaStr}</span>
      </div>`;
    }).join(''));

  updateHTML('#activity-feed', d.audit_excerpt.map(feedRow).join('') || '<li class="dim">No activity yet.</li>');
}

const feedRow = (r) => `<li><details><summary><b>${esc(String(r.action_type || 'INCOMPLETE_RECORD').replace(/_/g, ' ').toLowerCase())}</b> · ${esc(readableAgency(r.description || 'This older record did not capture its action details.'))}</summary><span class="dim">${esc(readableAgency(r.actor || 'Actor not recorded'))} · ${r.timestamp ? new Date(r.timestamp).toLocaleString('en-IN') : 'Time not recorded'} · Zone ${esc(r.zone_id || '—')} · Resource ${esc(r.resource_id || '—')} · Allocation ${esc(r.allocation_id || '—')} · ${esc(r.log_id)}</span></details></li>`;

window.resolveFlag = async (id, action) => {
  await api(`/api/duplicate-flags/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action }) });
  renderDashboard();
};

window.decideProposal = async (id, action) => {
  await api(`/api/reallocations/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
  renderDashboard();
};

window.openZone = async (zoneId) => {
  const z = await api('/api/zones').then((zs) => zs.find((x) => x.zone_id === zoneId));
  const breakdown = await api(`/zones/${zoneId}/score-breakdown`);
  const agencies = await api('/api/agencies');
  const allGapped = [...new Set([...z.needs, ...(z.rescue_needed ? ['rescue'] : [])])];
  $('#zone-detail').innerHTML = `
    <h3>${esc(z.name)} ${tierBadge(z.tier)} <span class="dim">score ${z.severity_score}</span></h3>
    <div class="dim">${esc(z.location)} · population ${z.population_affected}${z.override_applied ? ' ·  rescue override applied' : ''}</div>
    
    <h4>Why this priority?</h4>
    <p class="dim">${breakdown.override_applied ? 'Rescue is needed, so this zone receives critical priority.' : 'Priority reflects unmet resources, population pressure and reported urgency.'}</p>

    <h4>Score breakdown</h4>
    <table><tr><th>category</th><th>need</th><th>gap</th><th>ratio</th><th>weight</th></tr>
    ${(breakdown.breakdown?.per_category || []).map((p) => `<tr><td>${p.category}</td><td>${p.need}</td><td>${p.gap}</td><td>${p.gap_ratio}</td><td>${p.weight}</td></tr>`).join('')}
    </table>
    <div class="dim" style="margin-top:4px;">pressure ×${breakdown.breakdown?.population_pressure} · urgency ×${breakdown.breakdown?.urgency_multiplier}${breakdown.override_applied ? ' · hard override applied' : ''}</div>
    <button onclick="editZone('${z.zone_id}')" style="margin-top:6px;">Update Situation</button>
    <h4>Assign agency commitments</h4>
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

const CATEGORIES = ['water', 'medical', 'food', 'shelter'];
const chosen = new Set(['water']);
$('#need-chips').innerHTML = CATEGORIES.map((c) => `<button type="button" class="chip${c === 'water' ? ' on' : ''}" data-c="${c}" aria-pressed="${c === 'water'}">${c}</button>`).join('');
$('#need-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  chip.classList.toggle('on');
  chip.setAttribute('aria-pressed', String(chip.classList.contains('on')));
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

$('#chat-send').onclick = async () => {
  const text = $('#chat-input').value.trim();
  if (!text) return;
  appendChat('user', text);
  $('#chat-input').value = '';
  try {
    const result = await api('/api/reports/natural', { method: 'POST', body: JSON.stringify({ text }) });
    appendChat('system', ` Parsed report (confidence: ${(result.confidence * 100).toFixed(0)}%):\n• Location: ${result.parsed.location || 'unknown'}\n• Population: ${result.parsed.population_affected}\n• Needs: ${result.parsed.needs.join(', ') || 'none detected'}\n• Rescue: ${result.parsed.rescue_needed ? 'YES' : 'no'}\n• Urgency: ${result.parsed.urgency_high ? 'HIGH' : 'normal'}`);
    appendChat('action', result.parsed);
  } catch (e) {
    appendChat('system', ' ' + e.message);
  }
};

$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#chat-send').click();
});

function appendChat(type, content) {
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;
  if (type === 'action') {
    div.innerHTML = `<button onclick="submitParsedReport(this)" data-report='${JSON.stringify(content).replace(/'/g, '&#39;')}'> Submit this report</button> <button class="secondary" onclick="this.parentElement.remove()"> Edit manually</button>`;
  } else {
    div.textContent = content;
  }
  $('#chat-messages').appendChild(div);
  $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
}

window.submitParsedReport = async (btn) => {
  const report = JSON.parse(btn.dataset.report);
  try {
    const r = await api('/api/reports', { method: 'POST', body: JSON.stringify(report) });
    appendChat('system', ` Report submitted! Zone: ${r.zone_id} — ${r.message}`);
    btn.parentElement.remove();
  } catch (e) {
    appendChat('system', ' ' + e.message);
  }
};

// ---------- AI Voice / Acoustic Distress Dispatcher & TTS Briefing ----------
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordTimer = null;
let recordStartTime = 0;
let isSpeaking = false;

function fillVoiceReview(parsed) {
  const form = $('#report-form');
  form.elements.name.value = parsed.name === 'Unknown Location' ? '' : parsed.name || '';
  form.elements.location.value = parsed.location === 'Unknown Location' ? '' : parsed.location || '';
  form.elements.population_affected.value = parsed.population_affected || 0;
  form.elements.rescue_needed.checked = Boolean(parsed.rescue_needed);
  form.elements.urgency_high.checked = Boolean(parsed.urgency_high);
  chosen.clear();
  for (const need of parsed.needs || []) chosen.add(need);
  document.querySelectorAll('#need-chips .chip').forEach(chip => {
    const selected = chosen.has(chip.dataset.c);
    chip.classList.toggle('on', selected);
    chip.setAttribute('aria-pressed', String(selected));
  });
  showReportStep(0);
  $('#report-result').textContent = 'Voice draft ready. Check the incident details and proceed to Confirm Report. Nothing has been submitted.';
}
let voiceAnalysisVersion = 0;
let voiceReadyChecked = false;
async function processVoiceDispatch(payload) {
  const version = ++voiceAnalysisVersion;
  $('#voice-status').textContent = 'Analysing audio. This can take a few seconds…';
  const hud = $('#acoustic-hud');
  if (hud) hud.classList.remove('hidden');
  $('#hud-distress').textContent = 'Analyzing...';
  $('#hud-distress').style.color = 'var(--high)';
  $('#hud-pitch').textContent = 'Extracting...';
  $('#hud-energy').textContent = 'Computing...';
  $('#hud-rate').textContent = 'Processing...';
  $('#hud-triage-summary').textContent = 'Analysing voice report…';

  try {
    const res = await api('/api/voice-report', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (version !== voiceAnalysisVersion) return;

    const ac = res.acoustic;
    $('#hud-distress').textContent = `${ac.distress_score} / 100 (${ac.urgency_level})`;
    $('#hud-distress').style.color = ac.distress_score >= 70 ? 'var(--critical)' : (ac.distress_score >= 45 ? 'var(--high)' : 'var(--low)');
    $('#hud-pitch').textContent = `${ac.pitch_hz} Hz (var: ${ac.pitch_variance})`;
    $('#hud-energy').textContent = `${ac.energy_rms} RMS`;
    $('#hud-rate').textContent = `${ac.speech_rate} onsets/s`;
    $('#hud-confidence').textContent = `Confidence: ${(ac.confidence * 100).toFixed(0)}%`;

    if (ac.mfcc && Array.isArray(ac.mfcc)) {
      const minVal = Math.min(...ac.mfcc);
      const maxVal = Math.max(...ac.mfcc);
      const range = Math.max(1, maxVal - minVal);
      $('#hud-mfcc-bars').innerHTML = ac.mfcc.map((v, i) => {
        const heightPct = Math.max(15, Math.min(100, ((v - minVal) / range) * 100));
        return `<div title="MFCC ${i+1}: ${v}" style="flex:1; height:${heightPct}%;"></div>`;
      }).join('');
    }

    $('#hud-triage-summary').innerHTML = `
      <b>Review voice report</b>
      <p>${res.transcript_missing ? 'No transcript is available. Type what you heard or enter the incident details in the form.' : 'Check the transcript and incident details before confirming the report.'}</p>
      <label>Transcript<textarea id="voice-transcript" rows="4" style="width:100%;font:inherit;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:7px;padding:10px;">${esc(res.transcript)}</textarea></label>
      <button type="button" id="voice-apply-transcript" class="secondary">Use edited transcript</button>
      <p class="dim">Acoustic urgency is a suggestion. Verify rescue and urgency flags in the form.</p>
    `;
    fillVoiceReview(res.parsed);
    $('#voice-status').textContent = 'Analysis complete. Review the draft before confirming.';
    $('#voice-apply-transcript').onclick = async () => {
      const text = $('#voice-transcript').value.trim();
      if (!text) { $('#report-result').textContent = 'Enter a transcript or complete the incident form manually.'; return; }
      try {
        const draft = await api('/api/reports/natural', { method: 'POST', body: JSON.stringify({ text }) });
        fillVoiceReview(draft.parsed);
      } catch (error) { reportError(error); }
    };

    appendChat('user', ` [Radio Dispatch]: "${res.transcript}"`);
    appendChat('system', ` Voice distress estimate: ${ac.distress_score}/100 (${ac.urgency_level}) with ${(ac.confidence * 100).toFixed(0)}% confidence.\nExtracted: ${res.parsed.name} | Needs: ${res.parsed.needs.join(', ')} | Rescue Override: ${res.parsed.rescue_needed ? 'YES' : 'no'}`);
    
    return res;
  } catch (err) {
    if (version !== voiceAnalysisVersion) return;
    $('#voice-status').textContent = 'Audio analysis failed. Retry, or enter the incident details manually.';
    $('#hud-distress').textContent = 'Analysis unavailable';
    $('#hud-triage-summary').textContent = 'No incident was submitted. You can still use the incident form.';
  }
}

function setupVoiceDispatcher() {
  if (!voiceReadyChecked) {
    voiceReadyChecked = true;
    $('#voice-status').textContent = 'Checking audio service…';
    api('/api/voice-ready').then(result => {
      if (!voiceAnalysisVersion) $('#voice-status').textContent = result.ready
        ? 'Voice analysis ready. Microphone access requires browser permission.'
        : 'Voice analysis unavailable. Use the incident form or check the audio setup.';
    }).catch(() => { if (!voiceAnalysisVersion) $('#voice-status').textContent = 'Cannot reach audio service. Use the form or reload to retry.'; });
  }
  const btnRec = $('#btn-record-mic');
  const fileInput = $('#audio-file-input');
  const sampleBtns = document.querySelectorAll('.btn-sample');

  if (btnRec) {
    btnRec.onclick = async () => {
      if (isRecording) {
        stopRecording();
      } else {
        await startRecording();
      }
    };
  }

  if (fileInput) {
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result;
        await processVoiceDispatch({ audio_base64: base64, transcript: '' });
      };
      reader.readAsDataURL(file);
    };
  }

  sampleBtns.forEach(btn => {
    btn.onclick = async () => {
      const sample = btn.dataset.sample;
      await processVoiceDispatch({ sample_name: sample });
    };
  });
}

let audioCtx = null;
let mediaStream = null;
let scriptNode = null;
let pcmBuffers = [];

function encodePCMToWAV(buffers, sampleRate) {
  let totalLength = 0;
  for (let i = 0; i < buffers.length; i++) totalLength += buffers[i].length;
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (let i = 0; i < buffers.length; i++) {
    merged.set(buffers[i], offset);
    offset += buffers[i].length;
  }

  const buffer = new ArrayBuffer(44 + merged.length * 2);
  const view = new DataView(buffer);

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + merged.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, merged.length * 2, true);

  let p = 44;
  for (let i = 0; i < merged.length; i++) {
    let s = Math.max(-1, Math.min(1, merged[i]));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    p += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}

async function startRecording() {
  const btnRec = $('#btn-record-mic');
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone API not supported by browser. Please use the 1-Click Presets or upload an audio file.");
    }
    $('#rec-label').textContent = 'Requesting mic permission...';
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(mediaStream);

    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    pcmBuffers = [];

    scriptNode.onaudioprocess = (e) => {
      if (!isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      pcmBuffers.push(new Float32Array(input));
    };

    source.connect(scriptNode);
    scriptNode.connect(audioCtx.destination);

    window.__recognizedText = '';
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      try {
        const recognizer = new SpeechRecognition();
        recognizer.continuous = true;
        recognizer.interimResults = true;
        recognizer.onresult = (e) => {
          let text = '';
          for (let i = 0; i < e.results.length; i++) {
            text += e.results[i][0].transcript + ' ';
          }
          window.__recognizedText = text.trim();
          $('#rec-label').textContent = ` "${window.__recognizedText.slice(0, 24)}..."`;
        };
        recognizer.start();
        window.__speechRecognizer = recognizer;
      } catch (err) {
        console.warn('SpeechRecognition note:', err);
      }
    }

    isRecording = true;
    recordStartTime = Date.now();
    if (btnRec) {
      btnRec.style.background = '#dc2626';
      btnRec.classList.add('pulse');
    }
    recordTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - recordStartTime) / 1000);
      $('#rec-label').textContent = ` Recording (00:${sec < 10 ? '0' : ''}${sec})... Click to Stop`;
    }, 500);
  } catch (err) {
    console.error(err);
    alert("Microphone Error: " + err.message + "\n\nTip: You can use the '1-Click Radio Presets' right below or upload an audio file!");
    if (btnRec) {
      btnRec.style.background = 'var(--critical)';
      btnRec.classList.remove('pulse');
      $('#rec-label').textContent = 'Start recording';
    }
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearInterval(recordTimer);

  const btnRec = $('#btn-record-mic');
  if (btnRec) {
    btnRec.style.background = 'var(--critical)';
    btnRec.classList.remove('pulse');
    $('#rec-label').textContent = 'Encoding WAV audio...';
  }

  if (window.__speechRecognizer) {
    try { window.__speechRecognizer.stop(); } catch (e) {}
  }

  if (scriptNode) {
    scriptNode.disconnect();
    scriptNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  const sampleRate = audioCtx ? audioCtx.sampleRate : 44100;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  const wavBlob = encodePCMToWAV(pcmBuffers, sampleRate);
  const reader = new FileReader();
  reader.onloadend = async () => {
    const base64 = reader.result;
    if (btnRec) $('#rec-label').textContent = 'Start recording';
    await processVoiceDispatch({
      audio_base64: base64,
      transcript: window.__recognizedText || ''
    });
  };
  reader.readAsDataURL(wavBlob);
}

function triggerVoiceBriefing() {
  if (!window.speechSynthesis) {
    alert("SpeechSynthesis is not supported in this browser.");
    return;
  }
  const topBtn = $('#sitrep-voice-briefing');
  const innerBtn = $('#btn-sitrep-speak-inner');

  if (isSpeaking) {
    window.speechSynthesis.cancel();
    isSpeaking = false;
    if (topBtn) {
      topBtn.textContent = ' Play Voice Briefing';
      topBtn.style.color = 'var(--accent)';
    }
    if (innerBtn) {
      innerBtn.textContent = ' Play Voice Briefing';
      innerBtn.style.color = 'var(--accent)';
    }
    return;
  }

  if (!latestSitrepData) {
    alert("Please wait for SITREP data to load or click Refresh.");
    return;
  }

  const s = latestSitrepData;
  const recs = (s.recommendations || []).slice(0, 2).join('. ') || 'All logistics corridors functional.';
  const text = `Disaster Relief Operational Briefing. ${s.narrative}. There are currently ${s.summary.active_zones} active emergency zones, with ${s.summary.critical_zones} critical sectors requiring immediate intervention. Total resources allocated: ${s.summary.resources_allocated} units. Tactical priority: ${recs}. End of situational briefing.`;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  utterance.pitch = 0.95;

  utterance.onend = () => {
    isSpeaking = false;
    if (topBtn) {
      topBtn.textContent = ' Play Voice Briefing';
      topBtn.style.color = 'var(--accent)';
    }
    if (innerBtn) {
      innerBtn.textContent = ' Play Voice Briefing';
      innerBtn.style.color = 'var(--accent)';
    }
  };

  utterance.onerror = (err) => {
    console.warn("SpeechSynthesis error:", err);
    isSpeaking = false;
    if (topBtn) topBtn.textContent = ' Play Voice Briefing';
    if (innerBtn) innerBtn.textContent = ' Play Voice Briefing';
  };

  window.speechSynthesis.speak(utterance);
  isSpeaking = true;
  if (topBtn) {
    topBtn.textContent = ' Stop Voice Briefing';
    topBtn.style.color = 'var(--critical)';
  }
  if (innerBtn) {
    innerBtn.textContent = ' Stop Voice Briefing';
    innerBtn.style.color = 'var(--critical)';
  }
}

function setupVoiceBriefing() {
  const topBtn = $('#sitrep-voice-briefing');
  if (topBtn) {
    topBtn.onclick = () => triggerVoiceBriefing();
  }
  const innerBtn = $('#btn-sitrep-speak-inner');
  if (innerBtn) {
    innerBtn.onclick = () => triggerVoiceBriefing();
  }
}

window.runVoiceDemo = async () => {
  const modal = $('#demo-modal');
  if (modal) modal.classList.add('hidden');
  show('report');
  await processVoiceDispatch({ sample_name: 'critical_mayday.wav' });
};

async function renderInventory() {
  if ($('#screen-inventory').contains(document.activeElement) && document.activeElement.matches('input, select')) return;
  const items = await api('/api/resource-items');
  if ($('#screen-inventory').contains(document.activeElement) && document.activeElement.matches('input, select')) return;
  updateHTML('#inventory-list', items.map((r) => `
    <div class="card"><h3>${esc(r.category)} <span class="dim">${r.quantity_available} ${esc(r.unit)} · ${esc(r.agency_name)} · ${r.status}</span></h3>
    <div class="row"><label>Available quantity<input type="number" min="0" id="stock-${r.resource_id}" value="${r.quantity_available}" /></label><button onclick="saveStock('${r.resource_id}')">Save quantity</button><button class="secondary" onclick="restock('${r.resource_id}')">Restock +10</button></div></div>`).join(''));
  const agencySel = $('#inventory-form select[name=agency_id]');
  if (!agencySel.options.length) {
    const agencies = await api('/api/agencies');
    agencySel.innerHTML = agencies.map((a) => `<option value="${esc(a.agency_id)}">${esc(a.name)}</option>`).join('');
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

let latestSitrepData = null;

function renderSitrep() { return refreshOnce('sitrep', loadSitrep); }
async function loadSitrep() {
  try {
    const s = await api('/api/sitrep');
    latestSitrepData = s;
    updateHTML('#sitrep-content', `
      <div class="sitrep-card" style=" padding:20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
          <h3 style="margin:0;">${esc(s.title)}</h3>
          <button id="btn-sitrep-speak-inner" class="secondary" style=" padding:6px 14px; display:inline-flex; align-items:center; gap:6px;">
             Play Voice Briefing
          </button>
        </div>
        <div class="sitrep-narrative dim" style="margin-bottom:16px;">${esc(s.narrative)}</div>
        
        <h4> Summary</h4>
        <div class="strip">
          ${Object.entries(s.summary).map(([k,v]) => `<div class="stat"><b>${v}</b><span>${k.replace(/_/g,' ')}</span></div>`).join('')}
        </div>
        
        <h4> Zone Status</h4>
        <div class="cards">
          ${s.zone_status.map(z => `<div class="card t-${z.tier}"><h3>${esc(z.name)} <span class="badge ${z.tier}">${z.tier}</span></h3><div class="dim">Score: ${z.severity_score} · Trend: ${z.trend || '—'} · Top gaps: ${(z.top_gaps||[]).join(', ') || 'none'}</div></div>`).join('')}
        </div>
        
        <h4> Resource Status</h4>
        <table style="margin-bottom:16px;">
          <tr><th>Category</th><th>Available</th><th>Burn Rate</th><th>Depletion ETA</th><th>Status</th></tr>
          ${s.resource_status.map(r => `<tr><td>${r.category}</td><td>${r.available}</td><td>${r.burn_rate?.toFixed(1) || '0'}/hr</td><td>${r.hours_to_depletion != null ? (r.hours_to_depletion === Infinity ? '∞' : r.hours_to_depletion.toFixed(1) + 'h') : '—'}</td><td><span class="badge ${r.status}">${r.status}</span></td></tr>`).join('')}
        </table>
        
        <h4> Recommendations</h4>
        <ul class="feed">${(s.recommendations||[]).map(r => `<li> ${esc(r)}</li>`).join('') || '<li class="dim">No recommendations at this time.</li>'}</ul>
        
        <h4> Recent Actions</h4>
        <ul class="feed">${(s.recent_actions||[]).map(feedRow).join('')}</ul>
      </div>
    `);

    setupVoiceBriefing();
  } catch(e) {
    updateHTML('#sitrep-content', `<div class="banner">${esc(e.message)}</div>`);
  }
}
$('#sitrep-refresh').onclick = renderSitrep;

if ($('#sitrep-export-md')) {
  $('#sitrep-export-md').onclick = () => {
    if (!latestSitrepData) return alert('Please wait for SITREP to load or click Refresh.');
    const s = latestSitrepData;
    const md = `# Sanjeevani · ${s.title}
Generated: ${new Date(s.timestamp).toLocaleString()}

## Executive Summary
${s.narrative}

### Metrics
- Active Zones: ${s.summary.total_zones}
- Critical Zones: ${s.summary.critical_zones}
- High-Severity Zones: ${s.summary.high_zones}
- Population Affected: ${s.summary.total_population_affected}
- Resources Allocated: ${s.summary.resources_allocated} units
- Open Reallocation Proposals: ${s.summary.open_proposals}

## Actionable Recommendations
${(s.recommendations || []).map(r => `- ${r}`).join('\n')}

## Zone Priority Status
| Zone | Tier | Score | Trend | Unmet Gaps |
|---|---|---|---|---|
${(s.zone_status || []).map(z => `| ${z.name} | ${z.tier} | ${z.severity_score} | ${z.trend || 'stable'} | ${(z.top_gaps || []).join(', ') || 'none'} |`).join('\n')}

## Inventory & Depletion Forecasts
| Category | Available Stock | Burn Rate (/hr) | Est. Depletion | Status |
|---|---|---|---|---|
${(s.resource_status || []).map(r => `| ${r.category} | ${r.available} | ${r.burn_rate?.toFixed(1) || 0} | ${r.hours_to_depletion != null ? r.hours_to_depletion.toFixed(1) + 'h' : 'Stable'} | ${r.status} |`).join('\n')}

## Recent Incident Log
${(s.recent_actions || []).map(a => `- **${a.action_type}** (${readableAgency(a.actor)}): ${readableAgency(a.description)}`).join('\n')}
`;

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SITREP_${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
}

async function renderSimulation() {
  try {
    const scenarios = await api('/api/simulate/scenarios');
    $('#sim-scenario').innerHTML = scenarios.map(s => `<option value="${s.key}">${esc(s.name)} — ${esc(s.description)} (${s.event_count} events)</option>`).join('');
  } catch(e) { console.error(e); }
  await updateSimStatus();
}

async function updateSimStatus() {
  try {
    const status = await api('/api/simulate/status');
    if (status.running) {
      $('#sim-start').disabled = true;
      $('#sim-stop').disabled = false;
      $('#sim-status').innerHTML = `<div class="banner proposal"> LIVE — ${esc(status.scenario_name)} · ${status.events_completed}/${status.total_events} events · Speed ${status.speed}×</div>`;
    } else {
      $('#sim-start').disabled = false;
      $('#sim-stop').disabled = true;
      const label = status.status === 'stopped' ? 'Simulation stopped' : status.status === 'failed' ? 'Simulation finished with errors' : 'Simulation complete';
      $('#sim-status').innerHTML = status.scenario_name ? `<div class="banner">${label}: ${esc(status.scenario_name)} · ${status.events_completed}/${status.total_events} events</div>` : '<p class="dim">Ready. Choose a scenario and launch when you are ready.</p>';
    }
  } catch(e) { console.error(e); }
}

$('#sim-start').onclick = async () => {
  if (!confirm('Start a fresh simulation? This replaces the saved workspace with demo data.')) return;
  const scenario = $('#sim-scenario').value;
  const speed = parseInt(document.querySelector('.speed-btn.active')?.dataset.speed || '5');
  try {
    $('#sim-start').disabled = true;
    $('#sim-status').textContent = 'Starting simulation…';
    await api('/api/simulate/start', { method: 'POST', body: JSON.stringify({ scenario, speed }) });
    $('#sim-log').innerHTML = '';
    appendSimLog({ type: 'simulation_started', payload: { scenario } });
    await updateSimStatus();
  } catch(e) { $('#sim-start').disabled = false; $('#sim-status').textContent = 'Could not start simulation. Retry when the server is available.'; }
};

$('#sim-stop').onclick = async () => {
  await api('/api/simulate/stop', { method: 'POST', body: '{}' });
  await updateSimStatus();
};

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  };
});

function appendSimLog(event) {
  const li = document.createElement('li');
  li.innerHTML = `<b>${event.type}</b> — ${JSON.stringify(event.payload || {}).slice(0, 120)} <span class="dim">${new Date().toLocaleTimeString()}</span>`;
  $('#sim-log').prepend(li);
}

function renderAudit() { return refreshOnce('audit', loadAudit); }
async function loadAudit() {
  const zone = $('#audit-zone').value.trim(), actor = $('#audit-actor').value.trim();
  const action = $('#audit-action').value.trim(), resource = $('#audit-resource').value.trim();
  // Filter locally so legacy records with missing actors cannot break the request.
  const allRows = await api('/api/audit-log');
  if (zone !== $('#audit-zone').value.trim() || actor !== $('#audit-actor').value.trim() || action !== $('#audit-action').value.trim() || resource !== $('#audit-resource').value.trim()) return;
  const rows = allRows.filter(r => (!zone || String(r.zone_id ?? '').toLowerCase() === zone.toLowerCase())
    && (!actor || `${r.actor ?? ''} ${readableAgency(r.actor)}`.toLowerCase().includes(actor.toLowerCase()))
    && (!action || String(r.action_type ?? '').toLowerCase() === action.replace(/\s+/g, '_').toLowerCase())
    && (!resource || String(r.resource_id ?? '').toLowerCase() === resource.toLowerCase()));
  updateHTML('#audit-list', rows.map(feedRow).join('') || '<li class="dim">No matching entries.</li>');
}
$('#audit-refresh').onclick = renderAudit;

for (const trigger of document.querySelectorAll('#demo-workspace, #btn-demo-tour')) {
  trigger.onclick = () => $('#demo-modal').classList.remove('hidden');
}
if ($('#demo-modal-close')) {
  $('#demo-modal-close').onclick = () => $('#demo-modal').classList.add('hidden');
}

window.runDemoStep = async (step) => {
  const out = $('#demo-output');
  if (out) {
    out.classList.remove('hidden');
    out.innerHTML = `<span class="dim">Executing Step ${step}...</span>`;
  }
  try {
    if (step === 1) {
      await api('/api/seed', { method: 'POST' });
      if (out) out.innerHTML = ` <b>Step 1 Complete:</b> Seeded 4 baseline zones (Ward 3, 7, 11, 14). 12 scarce medical kits pre-committed to Ward 3.`;
      show('dashboard');
    } else if (step === 2) {
      const res = await api('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Ward 9', location: 'Ward 9, West District', population_affected: 1500,
          needs: ['medical', 'rescue'], rescue_needed: true, urgency_high: true
        })
      });
      if (out) out.innerHTML = ` <b>Step 2 Complete:</b> Ward 9 recorded with <b>rescue_needed: true</b> → Hard override fired → Tier: CRITICAL. Reallocation agent proposed diversion card on dashboard!`;
      show('dashboard');
    } else if (step === 3) {
      const props = await api('/api/reallocations');
      if (props.length > 0) {
        await api(`/api/reallocations/${props[0].allocation_id}/accept`, { method: 'POST', body: '{}' });
        const allocs = await api('/api/allocations');
        const ward9Alloc = allocs.find(a => (a.status === 'confirmed' && a.category === 'medical' && a.to_zone));
        if (ward9Alloc) {
          await api(`/api/allocations/${ward9Alloc.allocation_id}/deliver`, { method: 'POST', body: '{}' });
        }
        if (out) out.innerHTML = ` <b>Step 3 Complete:</b> Accepted re-allocation proposal. Ward 3 allocation marked <i>diverted</i>. Stock delivered to Ward 9. Inventory decremented at delivery only!`;
      } else {
        if (out) out.innerHTML = ` No open proposal found. Make sure Step 2 was run first.`;
      }
      show('dashboard');
    } else if (step === 4) {
      await api('/zones/Z2/update', {
        method: 'POST',
        body: JSON.stringify({ population_affected: 1600, urgency_high: true })
      });
      if (out) out.innerHTML = ` <b>Step 4 Complete:</b> Ward 7 population doubled (800 → 1600). Severity score surged live. Reallocation check ran and logged provable <b>no-op</b> to audit trail!`;
      show('dashboard');
    } else if (step === 5) {
      await api('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Ward 3', location: 'Ward 3, North District', population_affected: 1200,
          needs: ['medical', 'food']
        })
      });
      if (out) out.innerHTML = ` <b>Step 5 Complete:</b> Resubmitted Ward 3 report. Duplicate detector flagged match score ≥ 3! Notice the review banner on top of Dashboard.`;
      show('dashboard');
    } else if (step === 6) {
      try {
        await api('/zones/Z4/claim', {
          method: 'POST',
          body: JSON.stringify({ category: 'medical', agency_id: 'AG1', quantity: 10 })
        });
        await api('/zones/Z4/deliver', {
          method: 'POST',
          body: JSON.stringify({ category: 'medical', agency_id: 'AG1', quantity: 10 })
        });
      } catch(e) {}
      if (out) out.innerHTML = ` <b>Step 6 Complete:</b> Ward 14 claimed medical supplies while stock was empty (0). Allocation agent issued <b>partial allocation</b> (0 units) and logged shortfall honestly to audit log!`;
      show('dashboard');
    } else if (step === 7) {
      if (out) out.innerHTML = ` <b>Step 7 Complete:</b> Switched to SITREP view. Review auto-generated intelligence brief and actionable recommendations!`;
      show('sitrep');
    }
  } catch(err) {
    if (out) out.innerHTML = ` Error in Step ${step}: ${err.message}`;
  }
};

if ($('#reset-demo')) {
  $('#reset-demo').onclick = async () => {
    if (!confirm('Reset all demo reports, claims and deliveries to the four-zone starting scenario?')) return;
    await api('/api/seed', { method: 'POST' });
    $('#zone-modal').classList.add('hidden');
    await renderDashboard();
  };
}

window.saveStock = async resourceId => {
  await api('/api/resource-items', { method: 'POST', body: JSON.stringify({ resource_id: resourceId, quantity_available: Number($('#stock-' + resourceId).value) }) });
  await renderInventory();
};

function reportError(error) {
  if ($('#app-status')) $('#app-status').textContent = error.message ? `${error.message}. Retry the action when ready.` : 'Connection unavailable. Check the server and retry.';
}
window.addEventListener('unhandledrejection', e => {
  reportError(e.reason);
  e.preventDefault();
});

// Keep dialogs usable with keyboards, and return focus to the opening control.
for (const modal of document.querySelectorAll('.modal')) {
  let returnFocus = null;
  let wasOpen = false;
  new MutationObserver(() => {
    const open = !modal.classList.contains('hidden');
    if (open && !wasOpen) { returnFocus = document.activeElement; modal.querySelector('.close').focus(); }
    if (!open && wasOpen) { returnFocus?.focus(); }
    wasOpen = open;
    document.body.style.overflow = document.querySelector('.modal:not(.hidden)') ? 'hidden' : '';
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') { modal.classList.add('hidden'); return; }
    if (e.key !== 'Tab') return;
    const controls = [...modal.querySelectorAll('button, input, select, a[href], summary, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
}
setupVoiceDispatcher();
setupVoiceBriefing();
show('dashboard');
setInterval(() => {
  if (document.hidden) return;
  if (state.screen === 'dashboard') renderDashboard().catch(reportError);
  if (state.screen === 'inventory') renderInventory().catch(reportError);
  if (state.screen === 'audit') renderAudit().catch(reportError);
  if (state.screen === 'simulation') updateSimStatus().catch(reportError);
  syncReports();
}, 8000);
