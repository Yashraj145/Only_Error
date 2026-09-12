// §10 — API contract (master list). Express server over the in-memory store.
// Reads are computed fresh from the same tables every call (§6.11) so no screen
// ever holds a private copy.
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  store, seedDemoData, getZone, getAgency, getResource, availableQuantity,
  TIER_ORDER, isUndelivered, zoneName, CATEGORIES,
} from './src/store.js';
import { audit, auditTrailForZone } from './src/audit.js';
import { submitReport, createZone, mergeIntoZone, updateZone, runAssessmentPipeline } from './src/pipeline.js';
import { resolveFlag, scoreMatch } from './src/agents/duplicateReport.js';
import { attemptClaim } from './src/agents/claims.js';
import { convertClaimToAllocation, deliverAllocation, refreshAssessments, outstandingNeed } from './src/agents/allocation.js';
import { acceptProposal, dismissProposal } from './src/agents/reallocation.js';
import { generateForecasts } from './src/agents/forecasting.js';
import { generateSitrep } from './src/agents/sitrep.js';
import { parseNaturalReport } from './src/agents/nlpParser.js';
import { startSimulation, stopSimulation, setSpeed, getSimulationStatus, SCENARIOS } from './src/simulation.js';

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { snapshotStore } from './src/persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '20mb' }));

const isTest = process.env.NODE_ENV === 'test' || process.argv.some((arg) => arg.includes('test'));
const requests = new Map();
const persistence = !isTest || process.env.SANJEEVANI_STATE_FILE
  ? snapshotStore(process.env.SANJEEVANI_STATE_FILE || path.join(__dirname, 'data', 'workspace.json'), store, requests)
  : null;
// Fail startup on an unreadable/corrupt snapshot instead of overwriting history.
if (!persistence?.load()) { seedDemoData(); persistence?.save(); }
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = body => {
    if (req.method === 'POST' && res.statusCode < 500) persistence?.save();
    return json(body);
  };
  next();
});

// ---------- SSE real-time push ----------
const sseClients = new Set();

function broadcast(eventType, payload) {
  persistence?.save();
  const data = JSON.stringify({ type: eventType, payload, timestamp: new Date().toISOString() });
  for (const res of sseClients) {
    res.write(`event: update\ndata: ${data}\n\n`);
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Make broadcast available to simulation engine
global.__broadcast = broadcast;

const actorOf = (req) => req.get('x-actor') || req.body?.actor || 'coordinator';
function validateReport(body, partial = false) {
  if (!partial && (typeof body.name !== 'string' || !body.name.trim() || typeof body.location !== 'string' || !body.location.trim())) throw Object.assign(new Error('Name and location are required'), { status: 400 });
  if ((!partial || body.population_affected != null) && (!Number.isInteger(body.population_affected) || body.population_affected < 0)) throw Object.assign(new Error('Population must be a nonnegative integer'), { status: 400 });
  if ((!partial || body.needs != null) && (!Array.isArray(body.needs) || body.needs.some(c => !CATEGORIES.includes(c)))) throw Object.assign(new Error('Choose valid resource categories'), { status: 400 });
  for (const key of ['rescue_needed', 'urgency_high']) if (body[key] != null && typeof body[key] !== 'boolean') throw Object.assign(new Error('Urgency flags must be boolean'), { status: 400 });
}

// ---------- reads ----------

app.get('/api/zones', (_req, res) => {
  const zones = [...store.ZONES]
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.severity_score - a.severity_score)
    .map((z) => ({
      ...z,
      outstanding_needs: Object.fromEntries(CATEGORIES.map(c => [c, outstandingNeed(z, c)])),
      claims: store.CLAIMS.filter((c) => c.zone_id === z.zone_id),
      allocations: store.ALLOCATIONS.filter((a) => a.zone_id === z.zone_id && a.status !== 'proposed'),
      unclaimed_categories: (z.gaps && Object.entries(z.gaps).filter(([, gap]) => gap > 0).map(([category]) => category))
        .filter((category) => !store.CLAIMS.some((c) => c.zone_id === z.zone_id && c.category === category && c.status === 'pending')
          && !store.ALLOCATIONS.some((a) => a.zone_id === z.zone_id && a.category === category && isUndelivered(a))),
    }));
  res.json(zones);
});

app.get('/zones/:id/score-breakdown', (req, res) => {
  const zone = getZone(req.params.id);
  if (!zone) return res.status(404).json({ error: 'zone not found' });
  // Read-only: the breakdown stored by the last scoring pass (§13 — one tap
  // from the dashboard, never mutates state).
  res.json({
    zone_id: zone.zone_id,
    name: zone.name,
    gaps: zone.gaps,
    benchmarked_needs: zone.benchmarked_needs,
    severity_score: zone.severity_score,
    tier: zone.tier,
    override_applied: zone.override_applied,
    breakdown: zone.score_breakdown ?? null,
  });
});

app.get('/api/resource-items', (_req, res) => {
  res.json(store.RESOURCE_ITEMS.map((r) => ({ ...r, agency_name: getAgency(r.agency_id)?.name || r.agency_id })));
});

app.post('/api/resource-items', (req, res) => {
  const { agency_id, category, unit, quantity_available, resource_id } = req.body;
  if (!Number.isFinite(quantity_available) || quantity_available < 0) return res.status(400).json({ error: 'Quantity must be nonnegative' });
  if (resource_id) {
    const item = getResource(resource_id);
    if (!item) return res.status(404).json({ error: 'resource not found' });
    const committed = store.ALLOCATIONS.filter(a => a.resource_id === resource_id && isUndelivered(a)).reduce((s,a)=>s+a.quantity,0);
    if (quantity_available < committed) return res.status(409).json({ error: `Cannot reduce inventory below ${committed} committed units` });
    if (quantity_available != null) item.quantity_available = Math.max(0, quantity_available);
    item.status = item.quantity_available > 0 ? 'available' : 'depleted';
    audit({ actor: actorOf(req), action_type: 'INVENTORY_UPDATED', resource_id, description: `Inventory updated: ${resource_id} now ${item.quantity_available} ${item.unit}` });
    refreshAssessments(actorOf(req));
    return res.json(item);
  }
  const item = { resource_id: `RES${String(store.RESOURCE_ITEMS.length + 1).padStart(2, '0')}`, agency_id, category, unit: unit || 'unit', quantity_available: quantity_available ?? 0, status: quantity_available > 0 ? 'available' : 'depleted' };
  if (!getAgency(agency_id) || !CATEGORIES.includes(category)) return res.status(400).json({ error: 'Valid agency and category required' });
  store.RESOURCE_ITEMS.push(item);
  audit({ actor: actorOf(req), action_type: 'INVENTORY_ADDED', resource_id: item.resource_id, description: `Inventory added: ${item.quantity_available} ${item.unit} of ${category} by ${getAgency(agency_id)?.name || agency_id}` });
  refreshAssessments(actorOf(req));
  res.status(201).json(item);
});

app.get('/api/allocations', (_req, res) => {
  res.json(store.ALLOCATIONS.map((a) => ({
    ...a,
    from_zone: a.reallocated_from,
    to_zone: a.reallocated_to,
    zone_name: zoneName(a.zone_id),
  })));
});

app.get('/api/claims', (_req, res) => res.json(store.CLAIMS));

app.get('/api/agencies', (_req, res) => {
  const result = store.AGENCIES.map((ag) => {
    const claims = store.CLAIMS.filter((c) => c.agency_id === ag.agency_id);
    const resources = store.RESOURCE_ITEMS.filter((r) => r.agency_id === ag.agency_id);
    const rejections = store.AUDIT_LOG.filter((a) => a.actor === `agency:${ag.agency_id}` && a.action_type === 'CLAIM_REJECTED').length;
    return {
      ...ag,
      active_claims: claims.filter((c) => c.status === 'pending').length,
      converted_claims: claims.filter((c) => c.status === 'converted').length,
      resources_managed: resources.length,
      total_units_stocked: resources.reduce((sum, r) => sum + r.quantity_available, 0),
      duplicate_attempts_blocked: rejections,
    };
  });
  res.json(result);
});

app.get('/api/audit-log', (req, res) => {
  let rows = [...store.AUDIT_LOG].reverse(); // newest first
  if (req.query.zone) rows = rows.filter((r) => r.zone_id === req.query.zone);
  if (req.query.actor) rows = rows.filter((r) => String(r.actor ?? '').includes(req.query.actor));
  if (req.query.action) rows = rows.filter(r => r.action_type === req.query.action);
  if (req.query.resource) rows = rows.filter(r => r.resource_id === req.query.resource);
  res.json(rows);
});

// v2 — re-allocation: open proposals only.
app.get('/api/reallocations', (_req, res) => {
  res.json(store.ALLOCATIONS.filter((a) => a.status === 'proposed').map((a) => ({
    allocation_id: a.allocation_id,
    resource_id: a.resource_id,
    from_zone: a.reallocated_from,
    from_zone_name: zoneName(a.reallocated_from),
    to_zone: a.reallocated_to,
    to_zone_name: zoneName(a.reallocated_to),
    quantity: a.quantity,
    category: a.category,
    reason_text: a.reason_text,
    status: a.status,
  })));
});

app.post('/api/reallocations/:id/accept', (req, res) => {
  const result = acceptProposal(req.params.id, actorOf(req));
  if (!result) return res.status(404).json({ error: 'no open proposal with that id' });
  res.json({ status: 'confirmed', source_allocation: 'diverted', reallocated_to: result.proposal.reallocated_to });
  broadcast('allocation', { action: 'reallocation_accepted', allocation_id: req.params.id });
});

app.post('/api/reallocations/:id/dismiss', (req, res) => {
  const proposal = dismissProposal(req.params.id, actorOf(req));
  if (!proposal) return res.status(404).json({ error: 'no open proposal with that id' });
  res.json({ status: 'dismissed' });
});

// Duplicate-report flags (dashboard banner + coordinator resolve).
app.get('/api/duplicate-flags', (_req, res) => {
  res.json(store.DUPLICATE_FLAGS.filter((f) => f.status === 'open').map((f) => ({
    ...f,
    matched_zone_name: zoneName(f.matched_zone_id),
    match_detail: scoreMatch(f.incoming, getZone(f.matched_zone_id)),
  })));
});

app.post('/api/duplicate-flags/:id/resolve', (req, res) => {
  const action = req.body?.action;
  if (!['merge', 'dismiss'].includes(action)) return res.status(400).json({ error: "action must be 'merge' or 'dismiss'" });
  const flag = resolveFlag(req.params.id, action);
  if (!flag) return res.status(404).json({ error: 'no open flag with that id' });
  if (action === 'merge') {
    const result = mergeIntoZone(flag.matched_zone_id, flag.incoming, actorOf(req));
    return res.json({ status: 'merged', zone_id: result.zone.zone_id, tier: result.zone.tier, severity_score: result.zone.severity_score });
  }
  const result = createZone(flag.incoming, actorOf(req));
  res.json({ status: 'new', zone_id: result.zone_id, tier: result.zone.tier });
});

// ---------- actions ----------

app.post('/api/reports', (req, res) => {
  validateReport(req.body);
  const requestId = req.body.request_id;
  if (requestId && requests.has(requestId)) return res.json(requests.get(requestId));
  const { name, location, population_affected, needs, rescue_needed, urgency_high } = req.body;
  if (!name || !location) return res.status(400).json({ error: 'name and location are required' });
  const result = submitReport({ name, location, population_affected, needs, rescue_needed, urgency_high }, actorOf(req));
  const response = {
    status: result.status,
    zone_id: result.zone_id,
    message: result.message || `Zone ${result.zone?.name} recorded at tier ${result.zone?.tier} (score ${result.zone?.severity_score})`,
    flag: result.flag ? { flag_id: result.flag.flag_id, score: result.flag.score } : null,
    proposal: result.proposal ? { allocation_id: result.proposal.allocation_id, reason_text: result.proposal.reason_text } : null,
  };
  if (requestId) requests.set(requestId, response);
  broadcast('zone_update', { action: 'report_created', zone_id: result.zone_id });
  res.status(result.status === 'duplicate' ? 409 : 201).json(response);
});

app.post('/zones/:id/claim', (req, res) => {
  const { category, agency_id, quantity } = req.body;
  const zone = getZone(req.params.id);
  if (!zone) return res.status(404).json({ error: 'zone not found' });
  if (!category || !agency_id) return res.status(400).json({ error: 'category and agency_id are required' });
  const result = attemptClaim({ zone_id: zone.zone_id, category, agency_id, quantity });
  res.status(result.accepted ? 201 : 409).json(result);
});

// §6.8–6.9: delivery confirmation converts a pending claim into an allocation.
app.post('/zones/:id/deliver', (req, res) => {
  const { category, agency_id, quantity } = req.body;
  const claim = store.CLAIMS.find(
    (c) => c.zone_id === req.params.id && c.category === category && c.agency_id === agency_id && c.status === 'pending'
  );
  if (!claim) return res.status(404).json({ error: 'no pending claim for that zone/category/agency' });
  if (quantity != null) claim.quantity = quantity;
  const allocation = convertClaimToAllocation(claim, actorOf(req));
  res.json({ allocation, inventory: availableQuantity(category) });
  broadcast('allocation', { action: 'delivery_confirmed', zone_id: req.params.id });
});

// Delivery of an already-committed allocation (e.g. an accepted diversion).
app.post('/api/allocations/:id/deliver', (req, res) => {
  const allocation = deliverAllocation(req.params.id, req.body?.quantity, actorOf(req));
  if (!allocation) return res.status(404).json({ error: 'no confirmed allocation with that id' });
  res.json({ allocation, inventory: availableQuantity(allocation.category) });
});

app.post('/zones/:id/update', (req, res) => {
  validateReport(req.body, true);
  const result = updateZone(req.params.id, req.body, actorOf(req));
  if (!result) return res.status(404).json({ error: 'zone not found' });
  res.json({ zone_id: result.zone.zone_id, tier: result.zone.tier, severity_score: result.zone.severity_score, proposal: result.proposal ? { allocation_id: result.proposal.allocation_id, reason_text: result.proposal.reason_text } : null });
  broadcast('zone_update', { action: 'zone_updated', zone_id: req.params.id });
});

// Dashboard status strip (§8): one read, fresh from the tables.
app.get('/api/dashboard', (_req, res) => {
  const critical = store.ZONES.filter((z) => z.tier === 'critical');
  res.json({
    active_zones: store.ZONES.length,
    critical_zones: critical.length,
    resources_allocated: store.ALLOCATIONS.filter((a) => !['proposed', 'diverted'].includes(a.status)).reduce((s, a) => s + a.quantity, 0),
    pending_reports: store.DUPLICATE_FLAGS.filter((f) => f.status === 'open').length,
    open_proposals: store.ALLOCATIONS.filter((a) => a.status === 'proposed').length,
    critical_zone_categories: critical.map((z) => ({ zone_id: z.zone_id, name: z.name, unclaimed_categories: (z.gaps && Object.entries(z.gaps).filter(([, g]) => g > 0).map(([c]) => c)) })),
    inventory_totals: Object.fromEntries(['water', 'medical', 'food', 'shelter', 'rescue'].map((c) => [c, availableQuantity(c)])),
    audit_excerpt: [...store.AUDIT_LOG].slice(-8).reverse(),
  });
});

// Demo reset (§12 setup) — reseeds the exact 4-zone scenario.
app.post('/api/seed', (_req, res) => { stopSimulation(); requests.clear(); res.json(seedDemoData()); });
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));

// ---------- new agents ----------

app.get('/api/forecasts', (_req, res) => {
  try {
    res.json(generateForecasts());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sitrep', (_req, res) => {
  try {
    res.json(generateSitrep());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reports/natural', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const parsed = parseNaturalReport(text);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- AI Voice / Acoustic Distress Dispatcher ----------
const SAMPLES = {
  'critical_mayday.wav': {
    title: '🌊 Flood Surge Mayday (Ward 9)',
    file: path.join(__dirname, 'public', 'samples', 'critical_mayday.wav'),
    transcript: 'Mayday! Flash flood surge in Ward 9, water level rising rapidly, 45 elderly residents stranded on rooftops, medical assistance and emergency rescue teams needed urgently!',
    scenario: 'Flood Mayday',
  },
  'urgent_earthquake.wav': {
    title: '🏢 Earthquake Structural Collapse (Sector 4)',
    file: path.join(__dirname, 'public', 'samples', 'urgent_earthquake.wav'),
    transcript: 'Urgent radio dispatch! Severe structural collapse at Sector 4 Bridge, 25 casualties reported, trapped survivors under rubble, medical and shelter needed urgently!',
    scenario: 'Earthquake Collapse',
  },
  'moderate_sitrep.wav': {
    title: '📦 Routine Relocation Sitrep (Ward 11)',
    file: path.join(__dirname, 'public', 'samples', 'moderate_sitrep.wav'),
    transcript: 'Ward 11 relocation camp update, situation stabilized, 150 individuals sheltered, food and drinking water distribution ongoing, requesting 80 blankets.',
    scenario: 'Routine Sitrep',
  }
};

async function analyzeAudioWithPython(filePath) {
  const localPython = path.join(__dirname, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = process.env.SANJEEVANI_PYTHON || (await fs.access(localPython).then(() => localPython, () => 'python'));
  return new Promise((resolve, reject) => {
    const py = spawn(python, [path.join(__dirname, 'ai/processing/audio_distress.py'), filePath], { windowsHide: true });
    py.on('error', error => reject(new Error(`Cannot start audio Python runtime: ${error.message}. Set up .venv with requirements-audio.txt.`)));
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python distress script failed (code ${code}): ${stderr}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${stdout}`));
      }
    });
  });
}

app.get('/api/voice-samples', (_req, res) => {
  res.json(Object.entries(SAMPLES).map(([key, s]) => ({
    filename: key,
    title: s.title,
    transcript: s.transcript,
    scenario: s.scenario,
    audio_url: `/samples/${key}`
  })));
});

app.get('/api/voice-ready', async (_req, res) => {
  try {
    const result = await analyzeAudioWithPython('--test');
    res.json({ ready: result.has_librosa === true });
  } catch { res.json({ ready: false }); }
});

app.post('/api/voice-report', async (req, res) => {
  const { sample_name, audio_base64, transcript: clientTranscript } = req.body;
  let audioPath = null;
  let isTemp = false;
  let transcript = clientTranscript || '';

  try {
    if (sample_name && SAMPLES[sample_name]) {
      audioPath = SAMPLES[sample_name].file;
      if (!transcript) transcript = SAMPLES[sample_name].transcript;
    } else if (audio_base64) {
      const buffer = Buffer.from(audio_base64.replace(/^data:audio\/[a-z0-9]+;base64,/, ''), 'base64');
      audioPath = path.join(os.tmpdir(), `dispatch_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
      await fs.writeFile(audioPath, buffer);
      isTemp = true;
    } else {
      return res.status(400).json({ error: 'Either sample_name or audio_base64 is required' });
    }

    const acoustic = await analyzeAudioWithPython(audioPath);

    if (isTemp) {
      fs.unlink(audioPath).catch(() => {});
    }

    const natural = parseNaturalReport(transcript);
    const parsed = { ...natural.parsed };
    if (!natural.extraction_details.location_match) { parsed.name = ''; parsed.location = ''; }

    // Apply acoustic distress overrides derived from Librosa
    if (acoustic.distress_score >= 70 || acoustic.urgency_level === 'CRITICAL_DISTRESS') {
      parsed.rescue_needed = true;
      parsed.urgency_high = true;
    } else if (acoustic.distress_score >= 45) {
      parsed.urgency_high = true;
    }

    res.json({
      success: true,
      transcript,
      acoustic,
      parsed,
      review_required: true,
      transcript_missing: !transcript.trim()
    });
  } catch (err) {
    if (isTemp && audioPath) fs.unlink(audioPath).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ---------- simulation ----------

app.get('/api/simulate/scenarios', (_req, res) => {
  res.json(Object.entries(SCENARIOS).map(([key, s]) => ({ key, name: s.name, description: s.description, event_count: s.events.length })));
});

app.post('/api/simulate/start', (req, res) => {
  const { scenario, speed } = req.body;
  if (!scenario || !SCENARIOS[scenario]) return res.status(400).json({ error: 'valid scenario key required', available: Object.keys(SCENARIOS) });
  try {
    seedDemoData(); // reset to clean state
    requests.clear();
    const result = startSimulation(scenario, speed || 1, ({ type, ...payload }) => broadcast(type, payload));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/simulate/stop', (_req, res) => {
  stopSimulation();
  res.json({ status: 'stopped' });
});

app.post('/api/simulate/speed', (req, res) => {
  const { speed } = req.body;
  setSpeed(speed || 1);
  res.json({ speed: speed || 1 });
});

app.get('/api/simulate/status', (_req, res) => {
  res.json(getSimulationStatus());
});

// ---------- static client (§8 screen map) ----------
const publicDir = path.join(__dirname, 'public');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(publicDir, { etag: false, maxAge: 0 }));
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (!isTest) {
  app.listen(PORT, () => console.log(`Sanjeevani relief coordinator on http://localhost:${PORT}`));
}

export default app;
