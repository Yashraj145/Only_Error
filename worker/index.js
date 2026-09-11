import {
  store, seedDemoData, getZone, getAgency, getResource, availableQuantity,
  TIER_ORDER, isUndelivered, zoneName, CATEGORIES,
} from './src/store.js';
import { audit } from './src/audit.js';
import { submitReport, createZone, mergeIntoZone, updateZone } from './src/pipeline.js';
import { resolveFlag, scoreMatch } from './src/agents/duplicateReport.js';
import { attemptClaim } from './src/agents/claims.js';
import { convertClaimToAllocation, deliverAllocation, refreshAssessments, outstandingNeed } from './src/agents/allocation.js';
import { acceptProposal, dismissProposal } from './src/agents/reallocation.js';
import { generateForecasts } from './src/agents/forecasting.js';
import { generateSitrep } from './src/agents/sitrep.js';
import { parseNaturalReport } from './src/agents/nlpParser.js';
import { SCENARIOS } from './src/simulation.js';

seedDemoData();
const requests = new Map();
let simulationStatus = { running: false, scenario_name: null, speed: 1, events_completed: 0, total_events: 0, started_at: null };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const actorOf = (request, body) => request.headers.get('x-actor') || body?.actor || 'coordinator';
const match = (pathname, pattern) => pathname.match(pattern);

function validateReport(body, partial = false) {
  if (!partial && (typeof body.name !== 'string' || !body.name.trim() || typeof body.location !== 'string' || !body.location.trim())) throw Object.assign(new Error('Name and location are required'), { status: 400 });
  if ((!partial || body.population_affected != null) && (!Number.isInteger(body.population_affected) || body.population_affected < 0)) throw Object.assign(new Error('Population must be a nonnegative integer'), { status: 400 });
  if ((!partial || body.needs != null) && (!Array.isArray(body.needs) || body.needs.some(c => !CATEGORIES.includes(c)))) throw Object.assign(new Error('Choose valid resource categories'), { status: 400 });
}

function zones() {
  return [...store.ZONES]
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.severity_score - a.severity_score)
    .map(z => ({
      ...z,
      outstanding_needs: Object.fromEntries(CATEGORIES.map(c => [c, outstandingNeed(z, c)])),
      claims: store.CLAIMS.filter(c => c.zone_id === z.zone_id),
      allocations: store.ALLOCATIONS.filter(a => a.zone_id === z.zone_id && a.status !== 'proposed'),
      unclaimed_categories: Object.entries(z.gaps || {}).filter(([, gap]) => gap > 0).map(([category]) => category)
        .filter(category => !store.CLAIMS.some(c => c.zone_id === z.zone_id && c.category === category && c.status === 'pending')
          && !store.ALLOCATIONS.some(a => a.zone_id === z.zone_id && a.category === category && isUndelivered(a))),
    }));
}

const voiceSamples = {
  'critical_mayday.wav': { title: 'Flood surge mayday (Ward 9)', transcript: 'Mayday! Flash flood surge in Ward 9, 45 elderly residents stranded on rooftops, medical assistance and emergency rescue teams needed urgently!', scenario: 'Flood Mayday', distress: 92 },
  'urgent_earthquake.wav': { title: 'Earthquake structural collapse (Sector 4)', transcript: 'Urgent radio dispatch! Severe structural collapse at Sector 4 Bridge, 25 casualties, trapped survivors, medical and shelter needed urgently!', scenario: 'Earthquake Collapse', distress: 78 },
  'moderate_sitrep.wav': { title: 'Routine relocation update (Ward 11)', transcript: 'Ward 11 relocation camp update, 150 individuals sheltered, food and drinking water distribution ongoing.', scenario: 'Routine Sitrep', distress: 34 },
};

function acousticFor(score) {
  return { distress_score: score, urgency_level: score >= 70 ? 'CRITICAL_DISTRESS' : score >= 45 ? 'HIGH' : 'MODERATE', confidence: .91, pitch_hz: score >= 70 ? 242 : 164, pitch_variance: score >= 70 ? 54 : 23, energy_rms: score >= 70 ? .21 : .11, speech_rate: score >= 70 ? 5.8 : 3.2, mfcc: [-112, 42, 16, -4, 12, -8, 7, -3, 5, -2, 3, -1, 2] };
}

async function api(request, url) {
  const { pathname, searchParams } = url;
  const method = request.method;
  const body = method === 'GET' ? {} : await request.json().catch(() => ({}));
  let m;

  if (method === 'GET' && pathname === '/api/events') {
    const encoder = new TextEncoder();
    let timer;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`));
        timer = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 15000);
        request.signal.addEventListener('abort', () => { clearInterval(timer); try { controller.close(); } catch {} });
      },
      cancel() { clearInterval(timer); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
  }
  if (method === 'GET' && pathname === '/api/zones') return json(zones());
  if (method === 'GET' && (m = match(pathname, /^\/zones\/([^/]+)\/score-breakdown$/))) {
    const z = getZone(m[1]);
    return z ? json({ zone_id: z.zone_id, name: z.name, gaps: z.gaps, benchmarked_needs: z.benchmarked_needs, severity_score: z.severity_score, tier: z.tier, override_applied: z.override_applied, breakdown: z.score_breakdown ?? null }) : json({ error: 'zone not found' }, 404);
  }
  if (method === 'GET' && pathname === '/api/resource-items') return json(store.RESOURCE_ITEMS.map(r => ({ ...r, agency_name: getAgency(r.agency_id)?.name || r.agency_id })));
  if (method === 'POST' && pathname === '/api/resource-items') {
    const { agency_id, category, unit, quantity_available, resource_id } = body;
    if (!Number.isFinite(quantity_available) || quantity_available < 0) return json({ error: 'Quantity must be nonnegative' }, 400);
    if (resource_id) {
      const item = getResource(resource_id);
      if (!item) return json({ error: 'resource not found' }, 404);
      const committed = store.ALLOCATIONS.filter(a => a.resource_id === resource_id && isUndelivered(a)).reduce((s, a) => s + a.quantity, 0);
      if (quantity_available < committed) return json({ error: `Cannot reduce inventory below ${committed} committed units` }, 409);
      item.quantity_available = Math.max(0, quantity_available); item.status = item.quantity_available > 0 ? 'available' : 'depleted';
      audit({ actor: actorOf(request, body), action_type: 'INVENTORY_UPDATED', resource_id, description: `Inventory updated: ${resource_id} now ${item.quantity_available} ${item.unit}` });
      refreshAssessments(actorOf(request, body)); return json(item);
    }
    if (!getAgency(agency_id) || !CATEGORIES.includes(category)) return json({ error: 'Valid agency and category required' }, 400);
    const item = { resource_id: `RES${String(store.RESOURCE_ITEMS.length + 1).padStart(2, '0')}`, agency_id, category, unit: unit || 'unit', quantity_available, status: quantity_available > 0 ? 'available' : 'depleted' };
    store.RESOURCE_ITEMS.push(item); refreshAssessments(actorOf(request, body)); return json(item, 201);
  }
  if (method === 'GET' && pathname === '/api/allocations') return json(store.ALLOCATIONS.map(a => ({ ...a, from_zone: a.reallocated_from, to_zone: a.reallocated_to, zone_name: zoneName(a.zone_id) })));
  if (method === 'GET' && pathname === '/api/claims') return json(store.CLAIMS);
  if (method === 'GET' && pathname === '/api/agencies') return json(store.AGENCIES.map(ag => {
    const claims = store.CLAIMS.filter(c => c.agency_id === ag.agency_id); const resources = store.RESOURCE_ITEMS.filter(r => r.agency_id === ag.agency_id);
    return { ...ag, active_claims: claims.filter(c => c.status === 'pending').length, converted_claims: claims.filter(c => c.status === 'converted').length, resources_managed: resources.length, total_units_stocked: resources.reduce((sum, r) => sum + r.quantity_available, 0), duplicate_attempts_blocked: store.AUDIT_LOG.filter(a => a.actor === `agency:${ag.agency_id}` && a.action_type === 'CLAIM_REJECTED').length };
  }));
  if (method === 'GET' && pathname === '/api/audit-log') {
    let rows = [...store.AUDIT_LOG].reverse();
    if (searchParams.get('zone')) rows = rows.filter(r => r.zone_id === searchParams.get('zone'));
    if (searchParams.get('actor')) rows = rows.filter(r => r.actor.includes(searchParams.get('actor')));
    if (searchParams.get('action')) rows = rows.filter(r => r.action_type === searchParams.get('action'));
    if (searchParams.get('resource')) rows = rows.filter(r => r.resource_id === searchParams.get('resource'));
    return json(rows);
  }
  if (method === 'GET' && pathname === '/api/reallocations') return json(store.ALLOCATIONS.filter(a => a.status === 'proposed').map(a => ({ allocation_id: a.allocation_id, resource_id: a.resource_id, from_zone: a.reallocated_from, from_zone_name: zoneName(a.reallocated_from), to_zone: a.reallocated_to, to_zone_name: zoneName(a.reallocated_to), quantity: a.quantity, category: a.category, reason_text: a.reason_text, status: a.status })));
  if (method === 'POST' && (m = match(pathname, /^\/api\/reallocations\/([^/]+)\/(accept|dismiss)$/))) {
    const result = m[2] === 'accept' ? acceptProposal(m[1], actorOf(request, body)) : dismissProposal(m[1], actorOf(request, body));
    return result ? json({ status: m[2] === 'accept' ? 'confirmed' : 'dismissed', reallocated_to: result.proposal?.reallocated_to }) : json({ error: 'no open proposal with that id' }, 404);
  }
  if (method === 'GET' && pathname === '/api/duplicate-flags') return json(store.DUPLICATE_FLAGS.filter(f => f.status === 'open').map(f => ({ ...f, matched_zone_name: zoneName(f.matched_zone_id), match_detail: scoreMatch(f.incoming, getZone(f.matched_zone_id)) })));
  if (method === 'POST' && (m = match(pathname, /^\/api\/duplicate-flags\/([^/]+)\/resolve$/))) {
    if (!['merge', 'dismiss'].includes(body.action)) return json({ error: "action must be 'merge' or 'dismiss'" }, 400);
    const flag = resolveFlag(m[1], body.action); if (!flag) return json({ error: 'no open flag with that id' }, 404);
    const result = body.action === 'merge' ? mergeIntoZone(flag.matched_zone_id, flag.incoming, actorOf(request, body)) : createZone(flag.incoming, actorOf(request, body));
    const z = result.zone || result; return json({ status: body.action === 'merge' ? 'merged' : 'new', zone_id: z.zone_id, tier: z.tier, severity_score: z.severity_score });
  }
  if (method === 'POST' && pathname === '/api/reports') {
    validateReport(body); if (body.request_id && requests.has(body.request_id)) return json(requests.get(body.request_id));
    const result = submitReport(body, actorOf(request, body));
    const response = { status: result.status, zone_id: result.zone_id, message: result.message || `Zone ${result.zone?.name} recorded at tier ${result.zone?.tier}`, flag: result.flag ? { flag_id: result.flag.flag_id, score: result.flag.score } : null, proposal: result.proposal ? { allocation_id: result.proposal.allocation_id, reason_text: result.proposal.reason_text } : null };
    if (body.request_id) requests.set(body.request_id, response); return json(response, result.status === 'duplicate' ? 409 : 201);
  }
  if (method === 'POST' && (m = match(pathname, /^\/zones\/([^/]+)\/claim$/))) {
    if (!getZone(m[1])) return json({ error: 'zone not found' }, 404); const result = attemptClaim({ zone_id: m[1], category: body.category, agency_id: body.agency_id, quantity: body.quantity }); return json(result, result.accepted ? 201 : 409);
  }
  if (method === 'POST' && (m = match(pathname, /^\/zones\/([^/]+)\/deliver$/))) {
    const claim = store.CLAIMS.find(c => c.zone_id === m[1] && c.category === body.category && c.agency_id === body.agency_id && c.status === 'pending');
    if (!claim) return json({ error: 'no pending claim for that zone/category/agency' }, 404); if (body.quantity != null) claim.quantity = body.quantity;
    const allocation = convertClaimToAllocation(claim, actorOf(request, body)); return json({ allocation, inventory: availableQuantity(body.category) });
  }
  if (method === 'POST' && (m = match(pathname, /^\/api\/allocations\/([^/]+)\/deliver$/))) {
    const allocation = deliverAllocation(m[1], body.quantity, actorOf(request, body)); return allocation ? json({ allocation, inventory: availableQuantity(allocation.category) }) : json({ error: 'no confirmed allocation with that id' }, 404);
  }
  if (method === 'POST' && (m = match(pathname, /^\/zones\/([^/]+)\/update$/))) {
    validateReport(body, true); const result = updateZone(m[1], body, actorOf(request, body)); return result ? json({ zone_id: result.zone.zone_id, tier: result.zone.tier, severity_score: result.zone.severity_score, proposal: result.proposal || null }) : json({ error: 'zone not found' }, 404);
  }
  if (method === 'GET' && pathname === '/api/dashboard') {
    const critical = store.ZONES.filter(z => z.tier === 'critical');
    return json({ active_zones: store.ZONES.length, critical_zones: critical.length, resources_allocated: store.ALLOCATIONS.filter(a => !['proposed', 'diverted'].includes(a.status)).reduce((s, a) => s + a.quantity, 0), pending_reports: store.DUPLICATE_FLAGS.filter(f => f.status === 'open').length, open_proposals: store.ALLOCATIONS.filter(a => a.status === 'proposed').length, critical_zone_categories: critical.map(z => ({ zone_id: z.zone_id, name: z.name, unclaimed_categories: Object.entries(z.gaps || {}).filter(([, g]) => g > 0).map(([c]) => c) })), inventory_totals: Object.fromEntries(CATEGORIES.map(c => [c, availableQuantity(c)])), audit_excerpt: [...store.AUDIT_LOG].slice(-8).reverse() });
  }
  if (method === 'POST' && pathname === '/api/seed') { requests.clear(); return json(seedDemoData()); }
  if (method === 'GET' && pathname === '/api/forecasts') return json(generateForecasts());
  if (method === 'GET' && pathname === '/api/sitrep') return json(generateSitrep());
  if (method === 'POST' && pathname === '/api/reports/natural') return body.text ? json(parseNaturalReport(body.text)) : json({ error: 'text is required' }, 400);
  if (method === 'GET' && pathname === '/api/voice-samples') return json(Object.entries(voiceSamples).map(([filename, s]) => ({ filename, title: s.title, transcript: s.transcript, scenario: s.scenario, audio_url: `/samples/${filename}` })));
  if (method === 'POST' && pathname === '/api/voice-report') {
    const sample = voiceSamples[body.sample_name]; const transcript = body.transcript || sample?.transcript || '';
    if (!sample && !body.audio_base64) return json({ error: 'Either sample_name or audio_base64 is required' }, 400);
    const acoustic = acousticFor(sample?.distress || (transcript.toLowerCase().match(/mayday|urgent|trapped|rescue/) ? 82 : 48));
    const natural = parseNaturalReport(transcript || 'Emergency voice report from Ward 9, medical assistance needed urgently'); const parsed = { ...natural.parsed };
    if (acoustic.distress_score >= 70) { parsed.rescue_needed = true; parsed.urgency_high = true; }
    if (!parsed.name) parsed.name = 'Ward 9'; if (!parsed.location) parsed.location = `${parsed.name}, Emergency Zone`;
    const report_result = submitReport(parsed, actorOf(request, body)); return json({ success: true, transcript, acoustic, parsed, report_result });
  }
  if (method === 'GET' && pathname === '/api/simulate/scenarios') return json(Object.entries(SCENARIOS).map(([key, s]) => ({ key, name: s.name, description: s.description, event_count: s.events.length })));
  if (method === 'POST' && pathname === '/api/simulate/start') {
    const scenario = SCENARIOS[body.scenario]; if (!scenario) return json({ error: 'valid scenario key required', available: Object.keys(SCENARIOS) }, 400);
    seedDemoData(); const created = [];
    for (const event of scenario.events) { if (event.type === 'report') created.push(submitReport(event.data, 'simulation-engine').zone_id); else if (created[event.zone_index]) updateZone(created[event.zone_index], event.data, 'simulation-engine'); }
    simulationStatus = { running: false, scenario_name: scenario.name, speed: body.speed || 1, events_completed: scenario.events.length, total_events: scenario.events.length, started_at: new Date().toISOString() };
    return json(simulationStatus);
  }
  if (method === 'POST' && pathname === '/api/simulate/stop') { simulationStatus.running = false; return json({ status: 'stopped' }); }
  if (method === 'POST' && pathname === '/api/simulate/speed') { simulationStatus.speed = body.speed || 1; return json({ speed: simulationStatus.speed }); }
  if (method === 'GET' && pathname === '/api/simulate/status') return json(simulationStatus);
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/zones/')) {
        const response = await api(request, url);
        return response || json({ error: 'not found' }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error?.message || 'Unexpected server error' }, error?.status || 500);
    }
  },
};
